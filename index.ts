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
 *
 * Two recurrence models are supported:
 * - `when` + `repeat`: a duration from now, repeated every N minutes/hours/days
 * - `cron`: a 5-field expression evaluated in a timezone, DST-safe
 */

const PREFIX = "job/"
const MAX_TIMEOUT = 2_147_483_647 // ~24.8 days, Node timer limit
const MAX_ATTEMPTS = 5
const CLAIM_LEASE = 20_000
const FIRED_TTL = 10 * 60_000
const DEFAULT_LANG: Lang = "en"

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

type Lang = "en" | "it"

type ScheduledArgs = { id: string; when: string; human: string; note: string }
type ListArgs = { id: string; when: string; human: string; note: string; task: string }

type Texts = {
  noSession: string
  invalidTime: (when: string) => string
  timePast: (when: string) => string
  taskEmpty: string
  invalidRepeat: (repeat: string) => string
  needWhenOrCron: string
  bothWhenAndCron: string
  invalidCron: (expr: string, reason: string) => string
  cronNever: (expr: string) => string
  invalidTimezone: (tz: string) => string
  scheduled: (args: ScheduledArgs) => string
  noChecks: string
  listLine: (args: ListArgs) => string
  noCheckFound: (id: string) => string
  otherSession: (id: string) => string
  cancelled: (id: string) => string
  missingId: string
}

const EN: Texts = {
  noSession: "Error: no session is associated with this tool call.",
  invalidTime: (when) =>
    `Invalid time: "${when}". Use a duration ('4h', '90m', '2d') or an ISO 8601 timestamp ('2026-10-28T18:00:00').`,
  timePast: (when) => `The requested time (${when}) is in the past or too close.`,
  taskEmpty: "Error: 'task' is empty.",
  invalidRepeat: (repeat) => `Invalid repeat interval: "${repeat}". Minimum is 1m.`,
  needWhenOrCron: "Provide either 'when' (with optional 'repeat') or 'cron'.",
  bothWhenAndCron: "Use either 'when'/'repeat' or 'cron', not both.",
  invalidCron: (expr, reason) => `Invalid cron expression "${expr}": ${reason}.`,
  cronNever: (expr) => `Cron expression "${expr}" never matches.`,
  invalidTimezone: (tz) => `Unknown timezone: "${tz}".`,
  scheduled: ({ id, when, human, note }) =>
    `${id} — check scheduled for ${when} (in ${human}${note}). ` +
    `When it fires, the task is sent back into this session and the answer appears here. ` +
    `Quote this id back to the user.`,
  noChecks: "No checks scheduled in this session.",
  listLine: ({ id, when, human, note, task }) => `- ${id}: ${when} (in ${human}${note}) — ${task}`,
  noCheckFound: (id) => `No check found with id ${id}.`,
  otherSession: (id) => `Check ${id} belongs to another session.`,
  cancelled: (id) => `Check ${id} cancelled.`,
  missingId: "Error: 'id' is missing.",
}

const IT: Texts = {
  noSession: "Errore: nessuna sessione associata a questa chiamata.",
  invalidTime: (when) =>
    `Orario non valido: "${when}". Usa una durata ('4h', '90m', '2d') o un timestamp ISO 8601 ('2026-10-28T18:00:00').`,
  timePast: (when) => `L'orario richiesto (${when}) è nel passato o troppo vicino.`,
  taskEmpty: "Errore: 'task' è vuoto.",
  invalidRepeat: (repeat) => `Intervallo di ripetizione non valido: "${repeat}". Minimo 1m.`,
  needWhenOrCron: "Indica 'when' (con eventuale 'repeat') oppure 'cron'.",
  bothWhenAndCron: "Usa 'when'/'repeat' oppure 'cron', non entrambi.",
  invalidCron: (expr, reason) => `Espressione cron non valida "${expr}": ${reason}.`,
  cronNever: (expr) => `L'espressione cron "${expr}" non corrisponde mai.`,
  invalidTimezone: (tz) => `Fuso orario sconosciuto: "${tz}".`,
  scheduled: ({ id, when, human, note }) =>
    `${id} — check programmato per ${when} (tra ${human}${note}). ` +
    `Quando scatta, il task viene reinviato in questa sessione e la risposta compare qui. ` +
    `Riporta questo id all'utente.`,
  noChecks: "Nessun check programmato in questa sessione.",
  listLine: ({ id, when, human, note, task }) => `- ${id}: ${when} (tra ${human}${note}) — ${task}`,
  noCheckFound: (id) => `Nessun check trovato con id ${id}.`,
  otherSession: (id) => `Il check ${id} appartiene a un'altra sessione.`,
  cancelled: (id) => `Check ${id} annullato.`,
  missingId: "Errore: 'id' mancante.",
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

type CronSpec = {
  expr: string
  minutes: number[]
  hours: number[]
  days: number[]
  months: number[]
  weekdays: number[]
  domStar: boolean
  dowStar: boolean
}

const MONTH_ALIASES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}
const DAY_ALIASES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

function parseAtom(raw: string, aliases?: Record<string, number>): number {
  const key = raw.toLowerCase()
  if (aliases && key in aliases) return aliases[key]
  if (!/^\d+$/.test(key)) throw new Error(`invalid value "${raw}"`)
  return Number(key)
}

function parseField(
  field: string,
  min: number,
  max: number,
  aliases?: Record<string, number>,
): { values: number[]; star: boolean } {
  const values = new Set<number>()
  for (const part of field.split(",")) {
    if (!part) throw new Error("empty list item")
    const [rangeRaw, stepRaw] = part.split("/")
    let step = 1
    if (stepRaw !== undefined) {
      step = Number(stepRaw)
      if (!Number.isInteger(step) || step <= 0) throw new Error(`invalid step "${stepRaw}"`)
    }

    let lo: number
    let hi: number
    if (rangeRaw === "*") {
      lo = min
      hi = max
    } else if (rangeRaw.includes("-")) {
      const [a, b] = rangeRaw.split("-")
      lo = parseAtom(a, aliases)
      hi = parseAtom(b, aliases)
    } else {
      lo = parseAtom(rangeRaw, aliases)
      hi = stepRaw !== undefined ? max : lo
    }

    if (lo < min || hi > max || lo > hi) throw new Error(`value out of range "${part}"`)
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return { values: [...values].sort((a, b) => a - b), star: field === "*" }
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error("expected 5 fields: minute hour day month weekday")

  const minutes = parseField(fields[0], 0, 59)
  const hours = parseField(fields[1], 0, 23)
  const days = parseField(fields[2], 1, 31)
  const months = parseField(fields[3], 1, 12, MONTH_ALIASES)
  const weekdaysRaw = parseField(fields[4], 0, 7, DAY_ALIASES)
  const weekdays = [...new Set(weekdaysRaw.values.map((v) => (v === 7 ? 0 : v)))].sort((a, b) => a - b)

  return {
    expr: expr.trim(),
    minutes: minutes.values,
    hours: hours.values,
    days: days.values,
    months: months.values,
    weekdays,
    domStar: days.star,
    dowStar: weekdaysRaw.star,
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatter(tz?: string): Intl.DateTimeFormat {
  const key = tz ?? ""
  let value = formatterCache.get(key)
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    formatterCache.set(key, value)
  }
  return value
}

function validateTimezone(tz: string): void {
  formatter(tz).format(0)
}

function tzParts(epoch: number, tz?: string) {
  const out: Record<string, string> = {}
  for (const part of formatter(tz).formatToParts(new Date(epoch))) {
    if (part.type !== "literal") out[part.type] = part.value
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
  }
}

function tzOffset(epoch: number, tz?: string): number {
  const parts = tzParts(epoch, tz)
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return asUTC - Math.floor(epoch / 1000) * 1000
}

function zonedToEpoch(year: number, month: number, day: number, hour: number, minute: number, tz?: string): number {
  const target = Date.UTC(year, month - 1, day, hour, minute)
  let epoch = target
  for (let i = 0; i < 3; i++) {
    const next = target - tzOffset(epoch, tz)
    if (next === epoch) break
    epoch = next
  }
  return epoch
}

function matchesDate(spec: CronSpec, year: number, month: number, day: number): boolean {
  if (!spec.months.includes(month)) return false
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  if (spec.domStar && spec.dowStar) return true
  if (spec.domStar) return spec.weekdays.includes(weekday)
  if (spec.dowStar) return spec.days.includes(day)
  // Classic cron: when both are restricted, either match is enough.
  return spec.days.includes(day) || spec.weekdays.includes(weekday)
}

/** First occurrence strictly after `after`, evaluated in `tz` (default: server timezone). */
export function nextCronOccurrence(spec: CronSpec, after: number, tz?: string): number | undefined {
  const start = tzParts(after, tz)
  const baseDate = Date.UTC(start.year, start.month - 1, start.day)

  // Four years covers leap days and any month/weekday combination.
  for (let offset = 0; offset < 366 * 4; offset++) {
    const date = new Date(baseDate + offset * 86_400_000)
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1
    const day = date.getUTCDate()
    if (!matchesDate(spec, year, month, day)) continue

    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const candidate = zonedToEpoch(year, month, day, hour, minute, tz)
        if (candidate <= after) continue
        // Reject local times that do not exist (DST spring-forward gap).
        const back = tzParts(candidate, tz)
        if (
          back.year === year &&
          back.month === month &&
          back.day === day &&
          back.hour === hour &&
          back.minute === minute
        ) {
          return candidate
        }
      }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDuration(raw: string): number | undefined {
  const match = /^\+?(\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)$/.exec(raw.trim())
  if (!match) return undefined
  const amount = Number(match[1].replace(",", "."))
  if (!Number.isFinite(amount) || amount <= 0) return undefined

  const unit = match[2].toLowerCase()
  const seconds = ["s", "sec", "secs", "second", "seconds"]
  const minutes = ["m", "min", "mins", "minute", "minutes"]
  const hours = ["h", "hr", "hrs", "hour", "hours"]
  const days = ["d", "day", "days"]
  const weeks = ["w", "week", "weeks"]

  let factor: number | undefined
  if (seconds.includes(unit)) factor = 1_000
  else if (minutes.includes(unit)) factor = 60_000
  else if (hours.includes(unit)) factor = 3_600_000
  else if (days.includes(unit)) factor = 86_400_000
  else if (weeks.includes(unit)) factor = 604_800_000
  if (!factor) return undefined

  return Math.round(amount * factor)
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

function formatLocal(ms: number, tz?: string): string {
  return new Date(ms).toLocaleString(undefined, {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function newID(): string {
  return `chk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Job = {
  id: string
  sessionID: string
  task: string
  dueAt: number
  createdAt: number
  repeatMs?: number
  cron?: { expr: string; tz?: string }
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

export default Plugin.define({
  id: "scheduled-checks",
  async setup(ctx) {
    const lang: Lang = ((ctx.options as any)?.language as Lang | undefined) ?? DEFAULT_LANG
    const text = lang === "it" ? IT : EN
    const dayUnit = lang === "it" ? "g" : "d"

    const formatDuration = (ms: number): string => {
      const total = Math.max(0, Math.round(ms / 1_000))
      const d = Math.floor(total / 86_400)
      const h = Math.floor((total % 86_400) / 3_600)
      const m = Math.floor((total % 3_600) / 60)
      const s = total % 60
      const parts = [
        d ? `${d}${dayUnit}` : "",
        h ? `${h}h` : "",
        m ? `${m}m` : "",
        !d && !h ? `${s}s` : "",
      ].filter(Boolean)
      return parts.join(" ") || "0s"
    }

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

    const nextInterval = (dueAt: number, step: number) => {
      const now = Date.now()
      let next = dueAt + step
      while (next <= now) next += step
      return next
    }

    const nextCron = (job: Job): number | undefined => {
      if (!job.cron) return undefined
      try {
        return nextCronOccurrence(parseCron(job.cron.expr), Date.now(), job.cron.tz)
      } catch {
        return undefined
      }
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
        const note = late > 120_000
          ? lang === "it"
            ? ` (in ritardo di ${formatDuration(late)})`
            : ` (late by ${formatDuration(late)})`
          : ""
        const prefix = lang === "it" ? "[check programmato]" : "[scheduled check]"
        console.log(`[scheduled-checks] fire ${job.id} occurrence=${job.dueAt} pid=${process.pid}`)
        await ctx.session.prompt({
          sessionID: job.sessionID,
          text: `${prefix}${note} ${job.task}`,
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

      const next = job.cron ? nextCron(job) : job.repeatMs ? nextInterval(job.dueAt, job.repeatMs) : undefined
      if (next === undefined) {
        await drop(job.id)
        return
      }

      job.dueAt = next
      job.attempts = 0
      job.lastFiredAt = Date.now()
      job.claim = undefined
      await save(job)
      arm(job)
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

    const describe = (job: Job): string => {
      if (job.cron) {
        const tz = job.cron.tz ? ` (${job.cron.tz})` : ""
        return lang === "it" ? `, con cron ${job.cron.expr}${tz}` : `, on cron ${job.cron.expr}${tz}`
      }
      if (job.repeatMs) {
        return lang === "it" ? `, poi ogni ${formatDuration(job.repeatMs)}` : `, then every ${formatDuration(job.repeatMs)}`
      }
      return ""
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "schedule_check",
        description:
          "Schedule a follow-up check that runs later in THIS SAME session. Use it when the user asks for something to be " +
          "checked after a delay, at a specific time, or on a calendar schedule ('check again in 4 hours', 'look at it " +
          "tomorrow at 9', 'every Monday at 08:20'). The task text is sent back into this session at that moment, the model " +
          "executes it with the full session context, and the answer appears here. Prefer one self-contained, explicit task. " +
          "Always call this tool for such requests; never tell the user a check is scheduled without calling it and quoting " +
          "the returned chk_ id.",
        input: {
          type: "object",
          properties: {
            when: {
              type: "string",
              description:
                "When to run it, for one-shot or interval jobs. Either a duration from now ('4h', '30m', '2d', '90s') or " +
                "an ISO 8601 timestamp ('2026-10-28T18:00:00', local time when no offset is given). Not used with 'cron'.",
            },
            task: {
              type: "string",
              description:
                "The instruction to execute when the time comes. Must be self-contained because it is replayed later " +
                "without the user typing anything.",
            },
            repeat: {
              type: "string",
              description:
                "Optional interval after the first run, e.g. '1d' or '6h'. Minimum 1 minute. It is a fixed duration, so " +
                "local clock times drift across daylight-saving changes; use 'cron' for calendar schedules.",
            },
            cron: {
              type: "string",
              description:
                "Optional 5-field cron expression: minute hour day-of-month month day-of-week. Examples: '20 8 * * 1' " +
                "(every Monday 08:20), '0 9 * * 1-5' (weekdays at 09:00), '0 3 1 * *' (first of the month). Supports '*', " +
                "'a-b', lists, steps ('*/15') and names (mon, jan). Evaluated in 'timezone' and DST-safe. Cannot be " +
                "combined with 'when' or 'repeat'.",
            },
            timezone: {
              type: "string",
              description: "Optional IANA timezone for 'cron', e.g. 'Europe/Rome'. Defaults to the server timezone.",
            },
          },
          required: ["task"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const sessionID: string | undefined = context?.sessionID
          if (!sessionID) return { content: text.noSession }

          const task = String(input?.task ?? "").trim()
          if (!task) return { content: text.taskEmpty }

          const cronRaw = input?.cron ? String(input.cron).trim() : ""
          const whenRaw = input?.when ? String(input.when).trim() : ""
          const repeatRaw = input?.repeat ? String(input.repeat).trim() : ""

          const job: Job = {
            id: newID(),
            sessionID,
            task,
            dueAt: 0,
            createdAt: Date.now(),
            attempts: 0,
          }

          if (cronRaw) {
            if (whenRaw || repeatRaw) return { content: text.bothWhenAndCron }

            let tz: string | undefined
            if (input?.timezone) {
              tz = String(input.timezone).trim()
              try {
                validateTimezone(tz)
              } catch {
                return { content: text.invalidTimezone(tz) }
              }
            }

            let spec: CronSpec
            try {
              spec = parseCron(cronRaw)
            } catch (error) {
              return { content: text.invalidCron(cronRaw, (error as Error).message) }
            }

            const first = nextCronOccurrence(spec, Date.now(), tz)
            if (!first) return { content: text.cronNever(spec.expr) }

            job.cron = { expr: spec.expr, tz }
            job.dueAt = first
          } else {
            if (!whenRaw) return { content: text.needWhenOrCron }

            const dueAt = parseWhen(whenRaw)
            if (!dueAt) return { content: text.invalidTime(whenRaw) }
            if (dueAt <= Date.now() + 5_000) return { content: text.timePast(formatLocal(dueAt)) }

            if (repeatRaw) {
              const repeatMs = parseDuration(repeatRaw)
              if (!repeatMs || repeatMs < 60_000) return { content: text.invalidRepeat(repeatRaw) }
              job.repeatMs = repeatMs
            }
            job.dueAt = dueAt
          }

          await save(job)
          arm(job)

          return {
            content: text.scheduled({
              id: job.id,
              when: formatLocal(job.dueAt, job.cron?.tz),
              human: formatDuration(job.dueAt - Date.now()),
              note: describe(job),
            }),
          }
        },
      })

      editor.add({
        name: "list_checks",
        description: "List the checks scheduled in this session, with their id, next run time and recurrence.",
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

          if (jobs.length === 0) return { content: text.noChecks }

          return {
            content: jobs
              .map((job) =>
                text.listLine({
                  id: job.id,
                  when: formatLocal(job.dueAt, job.cron?.tz),
                  human: formatDuration(job.dueAt - Date.now()),
                  note: describe(job),
                  task: job.task,
                }),
              )
              .join("\n"),
          }
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
          if (!id) return { content: text.missingId }

          const job = (await ctx.storage.get(key(id))) as Job | undefined
          if (!job) return { content: text.noCheckFound(id) }
          if (context?.sessionID && job.sessionID !== context.sessionID) {
            return { content: text.otherSession(id) }
          }

          await drop(id)
          for (const occurrence of [...registry.fired.keys()]) {
            if (occurrence === id || occurrence.startsWith(`${id}:`)) registry.fired.delete(occurrence)
          }
          return { content: text.cancelled(id) }
        },
      })
    })

    return () => {
      for (const id of [...own]) disarm(id)
    }
  },
})
