#!/bin/bash
# Usage: workspace-hooks.sh <workspace>  writes <workspace>/.agents/hooks.json tagged "workspace".
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$1/.agents"
cmd="python3 -I $here/logger.py"
cat > "$1/.agents/hooks.json" <<EOF
{
  "agspike-workspace": {
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "command": "$cmd PreToolUse workspace", "timeout": 10 }] }],
    "Stop": [{ "command": "$cmd Stop workspace", "timeout": 10 }]
  }
}
EOF
