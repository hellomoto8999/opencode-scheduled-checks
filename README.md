# opencode-scheduled-checks

Schedule a follow-up check that runs later **inside the same OpenCode session**.

Ask "check the deploy in 4 hours" and the agent schedules it. When the time
comes the task is sent back into that session, the model runs it with the full
conversation context, and the answer appears there like any other turn. No
client has to stay open: the timer lives in the OpenCode server.

```
you  › check CPU and RAM on the raspberry in 3 minutes
ai   › chk_mvt7o97iw5nw — check scheduled for 29/10/2026, 08:20 (in 3m 0s)

      [scheduled check] Measure CPU and RAM ...
ai   › load 0.16 / 0.19 / 0.13, 84% idle, RAM 2.7/7.6 GiB, swap 2.5 MiB, 64.8 °C
```

## Features

- **One-shot, interval and calendar schedules**: `4h`, `90m`, `2d`, ISO timestamps, or 5-field cron with a timezone
- **Same session**: the answer lands where you asked, with the previous context
- **Server-side**: closing the TUI/desktop/web client does not cancel anything
- **Durable**: jobs are persisted in plugin storage and re-armed when the plugin loads
- **Idempotent**: safe with several locations, plugin reloads and multiple server processes sharing storage
- **DST-safe cron**: local times that do not exist are skipped, ambiguous ones fire once
- **Cross-platform**: pure TypeScript, Node timers and storage only. No shell, no absolute paths, no OS-specific calls
- **Tools**: `schedule_check`, `list_checks`, `cancel_check`

## Requirements

- OpenCode V2 (tested with `2.0.32`)
- The OpenCode **server** must be running when the check is due. If it was
  stopped, the job fires as soon as it loads again, marked as late.

## Install

From npm:

```sh
opencode plugin add opencode-scheduled-checks
```

Straight from GitHub:

```sh
opencode plugin add github:YOUR_GITHUB_USER/opencode-scheduled-checks
```

Or as a local directory in `opencode.json(c)`:

```jsonc
{
  "plugins": ["./plugins/opencode-scheduled-checks"]
}
```

No configuration is required. Restart the service if the plugin is not picked up:

```sh
opencode service restart
```

Optional settings:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-scheduled-checks",
      "options": { "language": "it" }
    }
  ]
}
```

`language` is `en` (default) or `it`, and only affects the messages the tools
return; tool descriptions stay in English.

## Usage

Just ask in natural language:

- "check the build in 20 minutes"
- "look at the logs again tomorrow at 9"
- "every Monday at 08:20 check the backup"
- "every weekday at 9 report disk usage"
- "first of the month at 3am clean up old artifacts"

The model picks the right parameters; the tools are also callable directly.

| Tool | Input | Description |
| --- | --- | --- |
| `schedule_check` | `task`, `when?`, `repeat?`, `cron?`, `timezone?` | Schedule a task to be replayed in this session |
| `list_checks` | — | List this session's checks with ids and next run |
| `cancel_check` | `id` | Cancel a check |

### Scheduling syntax

**Interval / one-shot** — use `when` (and optionally `repeat`):

| `when` | Meaning |
| --- | --- |
| `30m`, `4h`, `2d`, `90s` | duration from now |
| `2026-10-29T09:00:00` | ISO 8601, local time when no offset is given |
| `2026-10-29T08:00:00Z` | ISO 8601 with offset |

`repeat` is a duration (`1d`, `12h`, `1w`, minimum `1m`). It is a **fixed
interval**, so a weekly job drifts by one hour when daylight saving changes.
Use `cron` when the local clock time must stay exact.

**Calendar** — use `cron` (5 fields) and optionally `timezone`:

```
┌───────────── minute (0-59)
│ ┌─────────── hour (0-23)
│ │ ┌───────── day of month (1-31)
│ │ │ ┌─────── month (1-12 or jan-dec)
│ │ │ │ ┌───── day of week (0-7 or sun-sat, 0 and 7 = Sunday)
* * * * *
```

Supports `*`, single values, ranges (`1-5`), lists (`1,15,30`), steps (`*/15`,
`0-30/10`) and names (`mon-fri`, `jan`). When both day-of-month and day-of-week
are restricted, either match counts, as in classic cron.

| Expression | Meaning |
| --- | --- |
| `20 8 * * 1` | every Monday at 08:20 |
| `0 9 * * mon-fri` | weekdays at 09:00 |
| `0 3 1 * *` | first of the month at 03:00 |
| `*/15 * * * *` | every 15 minutes |
| `0 */6 * * *` | every 6 hours |

```json
{ "cron": "20 8 * * 1", "timezone": "Europe/Rome", "task": "Check the backup" }
```

Cron is evaluated in `timezone` (IANA name, defaults to the server timezone).
Times skipped by a spring-forward transition are not fired that day; times
repeated by a fall-back transition fire once.

## Recommended: teach the model to use it

Tool descriptions are usually enough, but weak models sometimes claim a check is
scheduled without calling the tool. Adding this to your global
`~/.config/opencode/AGENTS.md` makes it reliable:

```md
## Scheduled checks

When I ask to check, verify or re-check something later or at a specific time
("check again in 4 hours", "every Monday at 08:20"), use the `schedule_check` tool.

- `when`: duration (`4h`, `90m`, `2d`) or a local ISO timestamp (`2026-10-29T09:00:00`)
- `repeat`: fixed interval for recurring checks (`1d`, `12h`, `1w`)
- `cron`: 5-field expression for calendar schedules (`20 8 * * 1`), with `timezone`
- `task`: a self-contained instruction to replay at that moment

Never claim a check is scheduled without receiving a `chk_...` id from the tool,
and always quote that id back to me. Use `list_checks` and `cancel_check` to manage them.
```

## How it works

- `setup(ctx)` registers the three tools with `ctx.tool.transform`.
- Each job is stored in `ctx.storage` under `job/<id>` and armed with a `setTimeout`.
- When it fires, the plugin calls `ctx.session.prompt({ sessionID, delivery: "queue" })`
  with `[scheduled check] <task>` and metadata (`jobID`, `dueAt`, `pid`).
- Interval jobs add their step, skipping missed cycles; cron jobs compute the
  next matching instant in the target timezone.
- Timers longer than ~24.8 days are re-armed in chunks, since that is the Node
  `setTimeout` limit.
- Delivery is de-duplicated three ways, because plugin setup can run more than
  once per process (locations, reloads) and several servers can share storage:
  1. a process-wide registry keyed by `jobID:dueAt`,
  2. a short durable claim in storage,
  3. a check of the session transcript for an already-delivered message with the
     same `jobID` and `dueAt`.

## Differences from `opencode-scheduler`

[`different-ai/opencode-scheduler`](https://github.com/different-ai/opencode-scheduler)
solves the same problem the other way around: it registers jobs in the OS
scheduler (launchd, systemd, Task Scheduler, cron fallback) and each run starts
a fresh `opencode run` process, with output in log files. That survives reboots
and works while the server is off, but every run is a new session without the
conversation history.

This plugin keeps the timer inside the server and writes the answer back into
the session you were already in, which needs the server to stay up. It has no
external dependencies and no OS integration.

## Caveats

- **Permissions**: if the task needs an approval (edit, write commands), the turn
  blocks until you approve it. Prefer read-only tasks for unattended checks, or
  configure `permissions` accordingly.
- **Model quality**: the scheduler always delivers, but the answer is produced by
  the session's model. Cheap models may invent values or numbers; ask for raw
  command output and verify when it matters.
- **Session must exist**: deleting a session drops its pending checks after a few
  failed delivery attempts.
- **`delivery: "queue"`**: if a turn is already running, the check waits for it.
- **Cron has no seconds**: the smallest granularity is one minute.

## Development

```sh
git clone https://github.com/YOUR_GITHUB_USER/opencode-scheduled-checks
cd opencode-scheduled-checks
npm install
npm run typecheck
npm test
```

To try a local checkout, add its absolute path to `plugins` in
`~/.config/opencode/opencode.json(c)` and restart the service.

## License

MIT
