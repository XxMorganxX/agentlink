# agentlink

A small background agent that lets a web app run agent tasks on your own Mac with
[Claude Code](https://claude.ai/code). You pair it with an app once; after that the app can
start work (a button press, a schedule, an event) and it runs here, unattended, inside limits
you control. macOS only.

Any web app can use it by implementing the contract below. Nothing in the daemon is specific
to one app.

## Install and pair

The app shows you one command with a one-time code in it. Run it in Terminal (⌘-Space, type
Terminal, Return):

    curl -fsSL https://github.com/XxMorganxX/agentlink/releases/latest/download/install.sh | sh -s -- https://app.example K7Q2-9XM4

That downloads the `agentlink` binary for your Mac into `~/.local/bin`, installs Claude Code
with its own installer if `claude` is missing, starts a launchd agent
(`com.stuart-labs.agentlink`) that keeps running across logins, and pairs it with the app.
If Claude Code was new, run `claude` once to sign in.

Install without pairing: drop the `-s -- <origin> <code>` part. Pair later, or with another app,
without restarting the agent: `agentlink pair <origin> <code>`. One pairing per app origin.

## What happens when an app sends a task

1. The daemon polls every paired app (every 3 s, or the `Retry-After` the app sends). A poll
   that returns a task has already claimed it for this Mac.
2. Claude Code runs headless in a new empty folder with only that app's MCP servers, only that
   app's tools plus WebSearch and WebFetch, no permission prompts, and the app's limits clamped
   to your ceilings (60 turns, $10, 30 minutes).
3. Progress streams back to the app. Stopping the task in the app kills the run here. A
   notification reports the result and cost, and the daemon polls that app again at once.

One task at a time. Stopping the daemon (`launchctl`, logout) kills a running task and reports
it `failed` / `daemon_stopped`. If the app revokes the pairing, the daemon forgets it and
notifies you.

## Commands

    agentlink status                    claude path + version, agent running or not, paired apps
    agentlink pair <origin> <code>      pair with an app (the code comes from the app)
    agentlink unpair <origin>           forget an app locally (disconnect it in the app too)
    agentlink serve                     the loop launchd runs; run it by hand to watch
    agentlink install                   (re)write the launchd agent; install.sh runs this
    agentlink uninstall                 stop the agent, remove it and ~/.config/agentlink

## Files

    ~/.local/bin/agentlink                              the binary
    ~/.config/agentlink/config.json                     { claude_path, model? }       0600
    ~/.config/agentlink/devices.json                    paired apps + device tokens   0600
    ~/.config/agentlink/logs/serve.log                  daemon log
    ~/.config/agentlink/logs/<task id>.log              one per task
    ~/.config/agentlink/logs/launchd.log                stdout/stderr of the daemon
    ~/Library/LaunchAgents/com.stuart-labs.agentlink.plist
    ~/.config/background-systems/registry/agentlink.json   manifest for the daemon-deck menu bar app

Set `model` in `config.json` (for example `"sonnet"`) to run tasks on a cheaper model.

## Make your app compatible

An app needs five HTTP routes. All bodies are JSON unless noted. Every URL the app hands out
must be `https` (plain `http` only on `localhost` / `127.0.0.1`) with no query string or
fragment, because the daemon appends paths to it. The types are in [`src/protocol.ts`](src/protocol.ts).

### 1. Pair — `POST {origin}/api/agentlink/v1/pair`

The user gets a one-time code from your app and runs `agentlink pair <origin> <code>`. This path
is fixed; every other URL comes from your responses.

Request: `{ "code": "K7Q2-9XM4", "name": "Morgan's MacBook Pro", "launcher": Launcher }`, where
`Launcher` is `{ "name": "agentlink", "version": "0.2.0", "platform": "darwin-arm64", "claude_version": "2.1.295" | null }`.
Treat the code case-insensitively and ignore hyphens and spaces.

| Status | Body |
|---|---|
| `200` | `{ "device_id", "device_token", "poll_url", "workspace": { "id", "slug", "name" }, "app": { "name" } }` |
| `404` | unknown or already-used code |
| `410` | expired code |

`device_token` is the long-lived credential for this Mac; store only a hash. `workspace` is
whatever your app scopes work to (an account, a team, a project) and is shown to the user.
`app.name` labels notifications.

### 2. Poll — `POST {poll_url}`, `Authorization: Bearer <device_token>`

Request: `{ "launcher": Launcher }`. The poll is both the heartbeat (update "last seen") and the
claim.

| Status | Meaning |
|---|---|
| `204` | nothing to do. Optional `Retry-After: <seconds>` sets the next poll (default 3, clamped to 1–60) |
| `200` | `{ "task": TaskDocument, "task_url": "https://…/tasks/<id>" }`: you have already assigned this task to this device |
| `401` | the token is unknown or revoked; the daemon deletes the pairing |

Return `401` only for a well-formed token you do not recognise. Anything else (`400`, `413`,
`5xx`, a network error) keeps the pairing and backs that app off 5 s, doubling to 60 s.
Claim atomically (for example `SELECT … FOR UPDATE SKIP LOCKED`) so two Macs never take the
same task.

### The task document

```json
{
  "protocol": "agentlink/1",
  "id": "tsk_123",
  "title": "Find people at Acme",
  "instructions": "The prompt, sent to Claude Code on stdin.",
  "mcp_servers": { "yourapp": { "url": "https://app.example/mcp", "headers": { "Authorization": "Bearer <per-run token>" } } },
  "allowed_tools": ["mcp__yourapp__search", "mcp__yourapp__save", "WebSearch"],
  "result_schema": { "type": "object", "properties": { "count": { "type": "number" } } },
  "limits": { "max_turns": 30, "max_budget_usd": 2, "timeout_s": 600 },
  "run_token": "<per-run token for the task routes>"
}
```

- `protocol` must be exactly `agentlink/1`.
- `mcp_servers`: at most 4, remote only (`url`, optional string `headers`); `https`, or `http`
  on localhost. Anything with `command`, `args`, `env` or `type: "stdio"` is rejected, because
  a local server would be arbitrary code on the user's Mac. Mint a short-lived token per run
  for the headers; the daemon writes it to a temp file that is deleted when the run ends.
- `allowed_tools`: only `mcp__<one of your server names>` / `mcp__<name>__<tool>`, `WebSearch`
  and `WebFetch` are kept. Other entries are dropped silently.
- `result_schema`: a JSON Schema for the final answer, or `null` for free text. It is passed to
  Claude Code's `--json-schema`; the result comes back as `structured_output`.
- `limits` (optional, each a positive number) are clamped to the user's ceilings. Defaults:
  40 turns, $5, 900 s. Ceilings: 60 turns, $10, 1800 s.

Two kinds of failure, handled differently:

- **Wrong shape** (a missing field, a wrong type, a `protocol` other than `agentlink/1`, a
  `task_url` that is not https): the daemon treats the whole poll as failed and backs off. It
  never calls the task routes, so the task sits claimed until your `lost` rule catches it.
- **Well-formed but not allowed** (a local MCP server, more than 4 servers, a non-https server
  URL): the daemon does not run it and completes it as `failed` with
  `error: "task_rejected: <rule>"`.

### 3. Status — `GET {task_url}`, `Authorization: Bearer <run_token>`

Answer `{ "status": "claimed" | "running" | … }`. The daemon calls this about every 5 s during a
run; it is the run's heartbeat. Any status other than `claimed` or `running` (for example
`cancelled` after the user presses Stop) kills the run, which then completes as `cancelled`.
Mark a task `lost` yourself if its heartbeat stops for more than about 60 s.

Statuses the daemon understands: `queued`, `claimed`, `running`, `done`, `failed`, `cancelled`,
`declined`, `lost`, `expired`. Moving `claimed` → `running` (for example on the first events
batch) is up to you.

### 4. Events — `POST {task_url}/events`, `Authorization: Bearer <run_token>`

`Content-Type: application/x-ndjson`: batches of Claude Code `stream-json` lines, flushed every
0.5 s or 64 kB, retried 3 times. Store or summarise them for live progress; answer `2xx`.

### 5. Complete — `POST {task_url}/complete`, `Authorization: Bearer <run_token>`

```json
{ "outcome": "done" | "failed" | "cancelled" | "declined", "exit_code": 0, "result_text": "…", "structured_output": {} ,
  "total_cost_usd": 0.42, "num_turns": 12, "session_id": "…", "error": null }
```

Sent once, retried for up to 60 s. `error` is `null` on success, otherwise for example
`task_rejected: <rule>`, `timeout`, `daemon_stopped`, `claude_not_found` or Claude Code's own
error subtype. Revoke the run's MCP token here.

### Checking your implementation

`test/fake-app.ts` is a minimal server for the three task routes, and `test/runner.test.ts`
drives the real runner against it with a fake `claude` (`test/fake-claude.sh`). Pair and poll
are covered by `test/client.test.ts` and `test/serve.test.ts` against injected `fetch`. To try
a real app end to end, install agentlink, pair it with `http://localhost:<port>`, and queue a
task.

## Develop

    npm install
    npm test
    npm run agentlink -- status        run the CLI from source
    npm run build                      needs bun; writes dist/agentlink-darwin-{arm64,x64}

Releases: a `v*` tag builds both binaries and publishes them with `install.sh`
(`.github/workflows/release.yml`). This repository is published as snapshots from the
author's private workspace: issues are welcome, and code changes are applied there and
published here.
