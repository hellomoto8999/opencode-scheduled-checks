import { Plugin } from "@opencode/plugin"

/**
 * Scheduled checks
 *
 * Lets a model schedule a follow-up turn in the *same* session: "check again
 * in 4 hours" runs later without any client connected, and the answer is
 * written back into the original session.
 *
 * Jobs live in plugin storage, are re-armed when the plugin loads, and are
 * delivered with `session.prompt`. Plugin setup can run several times in one
 * server process (multiple locations, reloads, concurrent activation) and
 * several server processes can share the same storage, so delivery is guarded
 * three ways: a process-wide registry, a durable claim in storage, and a check
 * of the session transcript before prompting.
 */

const PREFIX = "job/"
const MAX_TIMEOUT = 2_147_483_647 // ~24.8 days, Node timer limit
const MAX_ATTEMPTS = 5
const CLAIM_LEASE = 20_000
const FIRED_TTL = 10 * 60_000

type Job = {
  id: string
  sessionID: string
  task: string
  dueAt: number
  createdAt: number
  repeatMs?: number
  attempts?: number
  lastFiredAt?: number
  claim?: { owner: string; at: number }
}

type Registry = {
  timers: Map<string, { owner: string; timer: ReturnType<typeof setTimeout> }>
  fired: Map<string, number>
}

const GLOBAL_KEY = Symbol.for("opencode.scheduled-checks.registry")
const registry: Registry =
  ((globalThis as any)[GLOBAL_KEY] as Registry | undefined) ??
  ((globalThis as any)[GLOBAL_KEY] = { timers: new Map(), fired: new Map() } as Registry)

const UNIT: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
}

function parseDuration(raw: string): number | undefined {
  const match = /^\+?(\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)$/.exec(raw.trim())
  if (!match) return undefined
  const amount = Number(match[1].replace(",", "."))
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  const unit = UNIT[match[2].toLowerCase()]
  if (!unit) return undefined
  return Math.round(amount * unit)
}

function parseWhen(raw: string, now = Date.now()): number | undefined {
  const value = raw.trim()
  if (!value) return undefined
  const relative = parseDuration(value)
  if (relative) return now + relative
  if (/^\d+$/.test(value)) return now + Number(value) * 60_000 // bare number = minutes
  const absolute = Date.parse(value)
  return Number.isNaN(absolute) ? undefined : absolute
}

function formatLocal(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1_000))
  const d = Math.floor(total / 86_400)
  const h = Math.floor((total % 86_400) / 3_600)
  const m = Math.floor((total % 3_600) / 60)
  const s = total % 60
  const parts = [d ? `${d}d` : "", h ? `${h}h` : "", m ? `${m}m` : "", !d && !h ? `${s}s` : ""].filter(Boolean)
  return parts.join(" ") || "0s"
}

function newID(): string {
  return `chk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export default Plugin.define({
  id: "scheduled-checks",
  async setup(ctx) {
    const owner = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    const own = new Set<string>()
    const firing = new Set<string>()

    const key = (id: string) => PREFIX + id

    const save = async (job: Job) => {
      await ctx.storage.set(key(job.id), job)
    }

    const disarm = (id: string) => {
      const entry = registry.timers.get(id)
      if (entry && entry.owner === owner) {
        clearTimeout(entry.timer)
        registry.timers.delete(id)
      }
      own.delete(id)
    }

    const drop = async (id: string) => {
      disarm(id)
      await ctx.storage.remove(key(id))
    }

    const arm = (job: Job) => {
      const existing = registry.timers.get(job.id)
      if (existing && existing.owner !== owner) return // someone else already armed it
      disarm(job.id)

      const delay = job.dueAt - Date.now()
      if (delay > MAX_TIMEOUT) {
        const timer = setTimeout(() => arm(job), MAX_TIMEOUT)
        ;(timer as any).unref?.()
        registry.timers.set(job.id, { owner, timer })
        own.add(job.id)
        return
      }

      const timer = setTimeout(() => {
        registry.timers.delete(job.id)
        own.delete(job.id)
        if (job.dueAt - Date.now() > 1_000) {
          arm(job) // fired early, wait the rest
          return
        }
        void fire(job)
      }, Math.max(0, delay))
      ;(timer as any).unref?.()
      registry.timers.set(job.id, { owner, timer })
      own.add(job.id)
    }

    const nextOccurrence = (dueAt: number, step: number) => {
      const now = Date.now()
      let next = dueAt + step
      while (next <= now) next += step
      return next
    }

    const alreadyDelivered = async (job: Job): Promise<boolean> => {
      try {
        const messages = await ctx.session.context({ sessionID: job.sessionID })
        const floor = Math.max(job.dueAt - 5_000, job.lastFiredAt ?? 0)
        return messages.some((message: any) => {
          if (message?.type !== "user") return false
          const meta = message?.metadata
          if (meta?.jobID !== job.id) return false
          // Exact per-occurrence match when available (recurring jobs), time window otherwise.
          if (typeof meta?.dueAt === "number") return meta.dueAt === job.dueAt
          return typeof message?.time?.created === "number" && message.time.created >= floor
        })
      } catch {
        return false // session context unavailable: fall through to the other guards
      }
    }

    const claim = async (job: Job): Promise<boolean> => {
      const current = (await ctx.storage.get(key(job.id))) as Job | undefined
      if (!current) return false
      if (current.claim && Date.now() - current.claim.at < CLAIM_LEASE) return false

      current.claim = { owner, at: Date.now() }
      await save(current)
      await sleep(250 + Math.random() * 250) // let concurrent claims settle (last write wins)

      const verified = (await ctx.storage.get(key(job.id))) as Job | undefined
      return !!verified && verified.claim?.owner === owner
    }

    const fire = async (job: Job) => {
      if (firing.has(job.id)) return
      // Dedupe per occurrence, not per job: recurring jobs must fire every cycle.
      const occurrence = `${job.id}:${job.dueAt}`
      const recent = registry.fired.get(occurrence)
      if (recent && Date.now() - recent < FIRED_TTL) return

      firing.add(job.id)
      try {
        if (await alreadyDelivered(job)) {
          await drop(job.id)
          return
        }
        if (!(await claim(job))) return

        registry.fired.set(occurrence, Date.now())
        const late = Date.now() - job.dueAt
        const note = late > 120_000 ? ` (late by ${formatDuration(late)})` : ""
        console.log(`[scheduled-checks] fire ${job.id} occurrence=${job.dueAt} pid=${process.pid}`)
        await ctx.session.prompt({
          sessionID: job.sessionID,
          text: `[scheduled check]${note} ${job.task}`,
          delivery: "queue",
          metadata: { source: "scheduled-checks", jobID: job.id, dueAt: job.dueAt, pid: process.pid },
        })
      } catch (error) {
        job.attempts = (job.attempts ?? 0) + 1
        console.error(`[scheduled-checks] delivery failed for ${job.id} (attempt ${job.attempts})`, error)
        registry.fired.delete(occurrence)
        job.claim = undefined
        if (job.attempts >= MAX_ATTEMPTS) {
          await drop(job.id)
        } else {
          job.dueAt = Date.now() + 60_000
          await save(job)
          arm(job)
        }
        return
      } finally {
        firing.delete(job.id)
      }

      if (job.repeatMs) {
        job.dueAt = nextOccurrence(job.dueAt, job.repeatMs)
        job.attempts = 0
        job.lastFiredAt = Date.now()
        job.claim = undefined
        await save(job)
        arm(job)
      } else {
        await drop(job.id)
      }
    }

    const readAll = async (): Promise<Job[]> => {
      const jobs: Job[] = []
      let after: string | undefined
      do {
        const page = await ctx.storage.scan({ prefix: PREFIX, limit: 100, after })
        for (const entry of page.entries) {
          const job = entry.value as Job
          if (job && typeof job.dueAt === "number" && typeof job.sessionID === "string") jobs.push(job)
        }
        after = page.next ?? undefined
      } while (after)
      return jobs
    }

    // Re-arm everything that was persisted before this load.
    for (const job of await readAll()) arm(job)

    // Drop stale registry entries.
    for (const [id, at] of registry.fired) {
      if (Date.now() - at > FIRED_TTL) registry.fired.delete(id)
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "schedule_check",
        description:
          "Schedule a follow-up check that runs later in THIS SAME session. Use it when the user asks for something to be " +
          "checked after a delay or at a specific time ('check again in 4 hours', 'look at it tomorrow at 9', 'check every " +
          "morning'). The task text is sent back into this session at that moment, the model executes it with the full " +
          "session context, and the answer appears here. Prefer one self-contained, explicit task. Always call this tool " +
          "for such requests; never tell the user a check is scheduled without calling it and quoting the returned chk_ id.",
        input: {
          type: "object",
          properties: {
            when: {
              type: "string",
              description:
                "When to run it. Either a duration from now ('4h', '30m', '2d', '90s') or an ISO 8601 timestamp " +
                "('2026-10-28T18:00:00', local time when no offset is given).",
            },
            task: {
              type: "string",
              description:
                "The instruction to execute when the time comes. Must be self-contained because it is replayed later " +
                "without the user typing anything.",
            },
            repeat: {
              type: "string",
              description: "Optional recurring interval after the first run, e.g. '1d' or '6h'. Minimum 1 minute.",
            },
          },
          required: ["when", "task"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const sessionID: string | undefined = context?.sessionID
          if (!sessionID) return { content: "Error: no session is associated with this tool call." }

          const dueAt = parseWhen(String(input?.when ?? ""))
          if (!dueAt) {
            return {
              content:
                `Invalid time: "${input?.when}". Use a duration ('4h', '90m', '2d') ` +
                `or an ISO 8601 timestamp ('2026-10-28T18:00:00').`,
            }
          }
          if (dueAt <= Date.now() + 5_000) {
            return { content: `The requested time (${formatLocal(dueAt)}) is in the past or too close.` }
          }

          const task = String(input?.task ?? "").trim()
          if (!task) return { content: "Error: 'task' is empty." }

          let repeatMs: number | undefined
          if (input?.repeat) {
            repeatMs = parseDuration(String(input.repeat))
            if (!repeatMs || repeatMs < 60_000) {
              return { content: `Invalid repeat interval: "${input.repeat}". Minimum is 1m.` }
            }
          }

          const job: Job = {
            id: newID(),
            sessionID,
            task,
            dueAt,
            createdAt: Date.now(),
            repeatMs,
            attempts: 0,
          }
          await save(job)
          arm(job)

          const repeatNote = repeatMs ? `, then every ${formatDuration(repeatMs)}` : ""
          return {
            content:
              `${job.id} — check scheduled for ${formatLocal(dueAt)} ` +
              `(in ${formatDuration(dueAt - Date.now())}${repeatNote}). ` +
              `When it fires, the task is sent back into this session and the answer appears here. ` +
              `Quote this id back to the user.`,
          }
        },
      })

      editor.add({
        name: "list_checks",
        description: "List the checks scheduled in this session, with their id, next run time and recurring interval.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async (_input: any, context: any) => {
          const sessionID: string | undefined = context?.sessionID
          const jobs = (await readAll())
            .filter((job) => !sessionID || job.sessionID === sessionID)
            .sort((a, b) => a.dueAt - b.dueAt)

          if (jobs.length === 0) return { content: "No checks scheduled in this session." }

          const lines = jobs.map((job) => {
            const repeat = job.repeatMs ? `, every ${formatDuration(job.repeatMs)}` : ""
            return `- ${job.id}: ${formatLocal(job.dueAt)} (in ${formatDuration(job.dueAt - Date.now())}${repeat}) — ${job.task}`
          })
          return { content: lines.join("\n") }
        },
      })

      editor.add({
        name: "cancel_check",
        description: "Cancel a scheduled check in this session by its id (see list_checks).",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "Job id, e.g. chk_abc123." },
          },
          required: ["id"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const id = String(input?.id ?? "").trim()
          if (!id) return { content: "Error: 'id' is missing." }

          const job = (await ctx.storage.get(key(id))) as Job | undefined
          if (!job) return { content: `No check found with id ${id}.` }
          if (context?.sessionID && job.sessionID !== context.sessionID) {
            return { content: `Check ${id} belongs to another session.` }
          }

          await drop(id)
          for (const occurrence of [...registry.fired.keys()]) {
            if (occurrence === id || occurrence.startsWith(`${id}:`)) registry.fired.delete(occurrence)
          }
          return { content: `Check ${id} cancelled.` }
        },
      })
    })

    return () => {
      for (const id of [...own]) disarm(id)
    }
  },
})
