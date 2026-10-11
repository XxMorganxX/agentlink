#!/bin/bash
# Stands in for `claude -p`: echoes the flags it got as a system event, then
# emits a few stream-json lines. FAKE_CLAUDE_MODE=hang sleeps until killed
# (for the cancel and timeout tests); exits 143 on SIGTERM like the real one.
trap 'exit 143' TERM
prompt="$(cat)"
printf '{"type":"system","subtype":"init","argv":%s,"cwd":"%s"}\n' "$(printf '%s\n' "$@" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().splitlines()))')" "$PWD"
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"prompt was %s chars"}]}}\n' "${#prompt}"
if [ "$FAKE_CLAUDE_MODE" = "hang" ]; then
  # `sleep` in the background + `wait`: bash defers traps during a foreground command, so a plain
  # `sleep 0.2` would delay the exit by up to 200 ms and race the launcher's SIGKILL grace.
  while true; do sleep 0.2 & wait $!; done
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"{\\"n\\":2}","structured_output":{"n":2},"total_cost_usd":0.5,"num_turns":3,"session_id":"sess-1"}\n'
exit 0
