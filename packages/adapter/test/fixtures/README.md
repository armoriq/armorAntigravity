Hook payloads used by the tests.

`captured/` holds payloads the P0 spike captured from the real `agy` CLI
(runs `r1-empty-object`, `r3-full`, `r4-subagents`, `ft-deny`), stored as
`{event, stdin}` where `stdin` is the raw hook stdin. Scrubbing replaced the
spike's sandbox paths: `/tmp/agspike/home` with `/Users/dev`, the workspace
with `/Users/dev/src/ws`, and any other `/tmp/agspike` prefix with
`/Users/dev/spike`. Nothing else was changed.

`pre-read_file.json`, `pre-write_file.json` and `pre-edit_file.json` are raw
hook stdin from agy CLI 1.4.4 (2026-10-21), which renamed `view_file`,
`write_to_file` and the replace tools and passes the path as `Path`. The
sandbox home became `/Users/dev` and its workspace `/Users/dev/src/ws`.

`documented/` holds payloads written from https://antigravity.google/docs/hooks/
for cases the spike did not capture (a nested workspace, an MCP call with
domain arguments).
