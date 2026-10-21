#!/usr/bin/env python3
"""Usage: export.py <raw-surface-dir> <out.jsonl> [--all-sources] [--env-sample <out.json>]

Writes one scrubbed record per line, ordered by capture sequence. By default
only records from the "global" registration are kept: the plugin and
workspace registrations receive byte-identical stdin, and their presence is
already shown by the seq/source summary line at the top of the file.
"""
import argparse
import glob
import json
import re

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
SECRET_KEY = re.compile(r"TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH|COOKIE|CREDENTIAL|SESSION_ID", re.I)
DROP_ENV = re.compile(r"^(CLAUDE|AI_AGENT|T3_|__CF|XPC_|OSLog|MallocNano)")


def scrub(value):
    if isinstance(value, str):
        return EMAIL.sub("<email>", value)
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, dict):
        return {k: ("<redacted>" if SECRET_KEY.search(k) and isinstance(v, str) else scrub(v)) for k, v in value.items()}
    return value


def scrub_env(env):
    return {k: scrub({k: v})[k] for k, v in sorted(env.items()) if not DROP_ENV.search(k)}


ap = argparse.ArgumentParser()
ap.add_argument("raw")
ap.add_argument("out")
ap.add_argument("--all-sources", action="store_true")
ap.add_argument("--env-sample")
a = ap.parse_args()

records = sorted((json.load(open(p)) for p in glob.glob(a.raw + "/*.json")), key=lambda r: r["seq"])
summary = [f'{r["seq"]}:{r["event"]}:{r["argv"][2] if len(r["argv"]) > 2 else "?"}' for r in records]
with open(a.out, "w") as f:
    f.write(json.dumps({"captureOrder": summary}) + "\n")
    for r in records:
        source = r["argv"][2] if len(r["argv"]) > 2 else "?"
        if not a.all_sources and source != "global":
            continue
        f.write(json.dumps(scrub({
            "seq": r["seq"], "event": r["event"], "source": source, "hookCwd": r["cwd"],
            "action": r["action"], "envConversationId": r["env"].get("ANTIGRAVITY_CONVERSATION_ID"),
            "stdin": r["stdin"] if r["stdin"] is not None else r["stdinRaw"],
        }), sort_keys=True) + "\n")

if a.env_sample and records:
    r = records[0]
    with open(a.env_sample, "w") as f:
        json.dump({"argv": r["argv"], "cwd": r["cwd"], "env": scrub_env(r["env"])}, f, indent=2, sort_keys=True)
        f.write("\n")
