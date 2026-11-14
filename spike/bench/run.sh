#!/bin/bash
# Usage: run.sh [calls]   builds both clients, starts the stub server, prints percentiles.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
n="${1:-300}"
out="$(mktemp -d)"
trap 'kill "${server_pid:-}" 2>/dev/null || true; rm -rf "$out"' EXIT

(cd "$here" && go build -o "$out/server" ./server && go build -ldflags="-s -w" -o "$out/agd-hook-go" ./client-go && go build -o "$out/harness" ./harness)
bun build --compile --minify "$here/client-bun/main.ts" --outfile "$out/agd-hook-bun" >/dev/null

python3 -I -c '
import json, sys
for line in open(sys.argv[1]):
    r = json.loads(line)
    if r.get("event") == "PreToolUse":
        json.dump(r["stdin"], open(sys.argv[2], "w")); break
' "$here/../payloads/cli/r3-shell-write-read-web-mcp.jsonl" "$out/payload.json"

export ARMORANTIGRAVITY_SOCKET="$out/agd.sock"
"$out/server" "$ARMORANTIGRAVITY_SOCKET" &
server_pid=$!
until [ -S "$ARMORANTIGRAVITY_SOCKET" ]; do sleep 0.05; done

echo "$(uname -sm), $(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -p), go $(go env GOVERSION), bun $(bun --version)"
ls -la "$out/agd-hook-go" "$out/agd-hook-bun" | awk '{print $5, $NF}'
"$out/harness" "$out/payload.json" "$n" \
  "baseline-sh=cat >/dev/null; echo '{\"decision\":\"allow\"}'" \
  "go=$out/agd-hook-go PreToolUse" \
  "bun=$out/agd-hook-bun PreToolUse"
echo "load: $(uptime | sed 's/.*load averages*: //')"
