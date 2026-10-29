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

- **One-shot and recurring** checks (`4h`, `90m`, `2d`, or an ISO timestamp; `repeat: "1d"` for recurring)
- **Same session**: the answer lands where you asked, with the previous context
- **Server-side**: closing the TUI/desktop/web client does not cancel anything
- **Durable**: jobs are persisted in plugin storage and re-armed when the plugin loads
- **Idempotent**: safe with several locations, plugin reloads and multiple server processes sharing storage
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
opencode plugin add github:hellomoto8999/opencode-scheduled-checks
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

## Usage

Just ask in natural language:

- "check the build in 20 minutes"
- "look at the logs again tomorrow at 9"
- "every morning at 8 check disk usage" (the model schedules the first run with `repeat: "1d"`)

The tools are also callable directly by the model:

| Tool | Input | Description |
| --- | --- | --- |
| `schedule_check` | `when`, `task`, `repeat?` | Schedule a task to be replayed in this session |
| `list_checks` | — | List this session's checks with ids and next run |
| `cancel_check` | `id` | Cancel a check |

`when` accepts a duration from now (`30m`, `4h`, `2d`, `90s`) or an ISO 8601
timestamp (`2026-10-29T09:00:00`, interpreted as local time when it has no
offset). `repeat` is a duration and must be at least 1 minute.

Example tool call:

```json
{
  "when": "3m",
  "task": "Measure CPU and RAM on the raspberry: run `uptime`, `free -h`, `top -bn1 | head -5`, report real numbers only.",
  "repeat": null
}
```

## Recommended: teach the model to use it

Tool descriptions are usually enough, but weak models sometimes claim a check is
scheduled without calling the tool. Adding this to your global
`~/.config/opencode/AGENTS.md` makes it reliable:

```md
## Scheduled checks

When I ask to check, verify or re-check something later or at a specific time
("check again in 4 hours", "look at it tomorrow at 9"), use the `schedule_check` tool.

- `when`: duration (`4h`, `90m`, `2d`) or a local ISO timestamp (`2026-10-29T09:00:00`)
- `task`: a self-contained instruction to replay at that moment
- `repeat`: only for recurring checks (`1d`, `12h`)

Never claim a check is scheduled without receiving a `chk_...` id from the tool,
and always quote that id back to me. Use `list_checks` and `cancel_check` to manage them.
```

## How it works

- `setup(ctx)` registers the three tools with `ctx.tool.transform`.
- Each job is stored in `ctx.storage` under `job/<id>` and armed with a `setTimeout`.
- When it fires, the plugin calls `ctx.session.prompt({ sessionID, delivery: "queue" })`
  with `[scheduled check] <task>` and metadata (`jobID`, `dueAt`, `pid`).
- Recurring jobs compute the next occurrence (skipping missed cycles) and re-arm.
- Timers longer than ~24.8 days are re-armed in chunks, since that is the Node
  `setTimeout` limit.
- Delivery is de-duplicated three ways, because plugin setup can run more than
  once per process (locations, reloads) and several servers can share storage:
  1. a process-wide registry keyed by `jobID:dueAt`,
  2. a short durable claim in storage,
  3. a check of the session transcript for an already-delivered message with the
     same `jobID` and `dueAt`.

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

## Development

```sh
git clone https://github.com/hellomoto8999/opencode-scheduled-checks
cd opencode-scheduled-checks
npm install
npm run typecheck
```

To try a local checkout, add its absolute path to `plugins` in
`~/.config/opencode/opencode.json(c)` and restart the service.

## License

MIT
