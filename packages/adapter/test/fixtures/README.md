Hook payloads used by the tests.

`captured/` holds payloads the P0 spike captured from the real `agy` CLI
(runs `r1-empty-object`, `r3-full`, `r4-subagents`, `ft-deny`), stored as
`{event, stdin}` where `stdin` is the raw hook stdin. Scrubbing replaced the
spike's sandbox paths: `/tmp/agspike/home` with `/Users/dev`, the workspace
with `/Users/dev/src/ws`, and any other `/tmp/agspike` prefix with
`/Users/dev/spike`. Nothing else was changed.

`documented/` holds payloads written from https://antigravity.google/docs/hooks/
for cases the spike did not capture (a nested workspace, an MCP call with
domain arguments).
