#!/bin/bash
# Usage: setup.sh <home>
# Registers the logger for all five events at global and plugin scope, plus the
# echo MCP server globally and inside the plugin, under <home>/.gemini/config.
set -euo pipefail

target_home="$1"
here="$(cd "$(dirname "$0")" && pwd)"
cfg="$target_home/.gemini/config"
plugin="$cfg/plugins/agspike"
mkdir -p "$cfg" "$plugin"

hooks_json() {
  local src="$1"
  local cmd="python3 -I $here/logger.py"
  cat <<EOF
{
  "agspike-$src": {
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "$cmd PreToolUse $src", "timeout": 10 }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "$cmd PostToolUse $src", "timeout": 10 }] }],
    "PreInvocation": [{ "type": "command", "command": "$cmd PreInvocation $src", "timeout": 10 }],
    "PostInvocation": [{ "type": "command", "command": "$cmd PostInvocation $src", "timeout": 10 }],
    "Stop": [{ "type": "command", "command": "$cmd Stop $src", "timeout": 10 }]
  }
}
EOF
}

hooks_json global > "$cfg/hooks.json"
hooks_json plugin > "$plugin/hooks.json"
echo '{ "name": "agspike" }' > "$plugin/plugin.json"

cat > "$cfg/mcp_config.json" <<EOF
{ "mcpServers": { "agspike-global": { "command": "python3", "args": ["-I", "$here/mcp_echo.py"] } } }
EOF
cat > "$plugin/mcp_config.json" <<EOF
{ "mcpServers": { "agspike-plugin": { "command": "python3", "args": ["-I", "$here/mcp_echo.py"] } } }
EOF
echo "configured $cfg"
