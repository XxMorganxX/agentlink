# agentlink — agent instructions

`README.md` is the contract. Read it first; this file says how to work with it.

## If you are adding agentlink support to an app

Build the five routes in this order, each tested before the next:

1. **Pair.** Issue one-time codes (about 40 bits, a few minutes' TTL, single use, stored hashed).
   Exchange a code for a device token (stored hashed) and return `poll_url`.
2. **Poll.** Look the device up by token hash, record last seen, then claim the oldest queued,
   unexpired task for its scope atomically. `204` when there is none, `401` only for an unknown
   or revoked token.
3. **Task document.** Build it on the server, never from client input you have not validated:
   `protocol: "agentlink/1"`, remote MCP servers only, tools only as `mcp__<server>__*`,
   `WebSearch`, `WebFetch`. Mint a short-lived MCP bearer and a run token per run.
4. **Status, events, complete.** All authorised by the run token. Status drives cancellation:
   return `cancelled` to stop a run. Revoke the MCP bearer on every terminal path (complete,
   cancel, lost, expired).
5. **Lost and expired.** A task whose status heartbeat stops for about 60 s is `lost`; a queued
   task past its expiry is `expired`.

Do not:

- Expect a task with a wrong shape to be reported back. A bad document fails the poll silently
  from your side (the daemon backs off); only policy violations come back as `task_rejected`.
- Put a query string on any URL you return; the daemon appends `/events` and `/complete`.
- Ask for local (stdio) MCP servers or built-in tools beyond `WebSearch` and `WebFetch`; the
  daemon will refuse, and the user cannot be asked to allow it.

Test against a real daemon: `agentlink pair http://localhost:<port> <code>`, queue a task, and
watch `~/.config/agentlink/logs/serve.log` and `<task id>.log`.

## If you are changing agentlink itself

- `src/config.ts` holds every tunable (limits, timings, paths, the protocol string);
  `src/protocol.ts` holds the contract types and shape checks; `src/policy.ts` holds what an app
  may ask for. Change the contract there and in `README.md` in the same commit.
- A change an existing app could notice (a new required field, a stricter rule) needs a new
  `protocol` value, not an edit to `agentlink/1`.
- `npm test` must stay green; tests use injected `fetch`, a fake task server and a fake `claude`,
  so they never touch the network or the real CLI.
- Bump `version` in `package.json` and `LAUNCHER_VERSION` in `src/config.ts` together.
- The public repository is a published snapshot. Source changes are made upstream and published
  with a `v*` tag, which builds the release.
