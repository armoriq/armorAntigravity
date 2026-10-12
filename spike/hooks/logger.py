#!/usr/bin/env python3
"""Spike logging hook: records raw stdin, argv, env and timing for one hook call.

argv[1] is the event name we registered the command under, because the payload
itself may not name its event. Behavior is driven by $AGSPIKE_DIR/ctl.json so a
single registration can simulate deny, crash, hang and invalid output.
"""
import json
import os
import sys
import time

root = os.environ.get("AGSPIKE_DIR", "/tmp/agspike")
event = sys.argv[1] if len(sys.argv) > 1 else "unknown"
started = time.time()
raw = sys.stdin.read()

try:
    payload = json.loads(raw)
except ValueError:
    payload = None

surface = "unknown"
tp = (payload or {}).get("transcriptPath", "") if isinstance(payload, dict) else ""
for name in ("antigravity-cli", "antigravity-ide", "antigravity"):
    if f"/{name}/" in tp:
        surface = {"antigravity-cli": "cli", "antigravity-ide": "ide", "antigravity": "app"}[name]
        break

out_dir = os.path.join(root, "raw", surface)
os.makedirs(out_dir, exist_ok=True)
seq_path = os.path.join(out_dir, ".seq")
try:
    with open(seq_path) as f:
        n = int(f.read().strip() or 0) + 1
except (OSError, ValueError):
    n = 1
with open(seq_path, "w") as f:
    f.write(str(n))

ctl = {}
try:
    with open(os.path.join(root, "ctl.json")) as f:
        ctl = json.load(f)
except (OSError, ValueError):
    pass

tool = (payload or {}).get("toolCall", {}).get("name", "") if isinstance(payload, dict) else ""
rule = ctl.get(f"{event}:{tool}") or ctl.get(event) or {}
action = rule.get("action", "passthrough")

record = {
    "seq": n,
    "event": event,
    "argv": sys.argv,
    "cwd": os.getcwd(),
    "ppid": os.getppid(),
    "startedAt": started,
    "env": dict(os.environ),
    "stdinRaw": raw,
    "stdin": payload,
    "action": action,
}
with open(os.path.join(out_dir, f"{event}-{n:04d}.json"), "w") as f:
    json.dump(record, f, indent=2)

if action == "crash":
    sys.stderr.write("agspike: simulated crash\n")
    sys.exit(rule.get("exit", 1))
if action == "hang":
    time.sleep(rule.get("seconds", 120))
if action == "invalid":
    sys.stdout.write("this is not json {")
    sys.exit(0)
if action == "respond":
    sys.stdout.write(json.dumps(rule["response"]))
    sys.exit(0)
sys.stdout.write("{}")
