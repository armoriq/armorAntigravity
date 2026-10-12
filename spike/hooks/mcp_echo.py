#!/usr/bin/env python3
"""Minimal stdio MCP server exposing one tool, `echo`, for the spike."""
import json
import sys


def reply(msg_id, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg_id, "result": result}) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    method = msg.get("method")
    if "id" not in msg:
        continue
    if method == "initialize":
        reply(msg["id"], {
            "protocolVersion": msg.get("params", {}).get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "agspike-echo", "version": "0.0.1"},
        })
    elif method == "tools/list":
        reply(msg["id"], {"tools": [{
            "name": "echo",
            "description": "Echo back the given text.",
            "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
        }]})
    elif method == "tools/call":
        text = msg.get("params", {}).get("arguments", {}).get("text", "")
        reply(msg["id"], {"content": [{"type": "text", "text": f"echo: {text}"}]})
    else:
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "method not found"}}) + "\n")
        sys.stdout.flush()
