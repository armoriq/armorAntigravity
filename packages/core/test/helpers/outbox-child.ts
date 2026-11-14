// Child process for multi-process outbox tests: argv = dir, prefix, count, backend | "none", mode.
// mode "exit-during-send" starts one send, shuts down while it is in flight, then exits.
import { createOutbox } from "../../src/outbox.ts";

const [dir, prefix, count, backend, mode] = process.argv.slice(2) as [string, string, string, string, string?];
const quiet = { info() {}, warn() {}, error() {} };
const outbox = createOutbox<{ id: string }>(dir, "audit", quiet);
for (let i = 0; i < Number(count); i++) outbox.enqueue({ id: `${prefix}-${i}` });

if (backend === "none") {
  await outbox.persist();
  process.exit(0);
}

const send = async (batch: readonly { id: string }[]) => {
  const res = await fetch(backend, { method: "POST", body: JSON.stringify({ rows: batch }) });
  return res.ok ? { ok: true as const, rejected: [] } : { ok: false as const };
};
if (mode === "exit-during-send") {
  void outbox.drain(send, 10);
  await Bun.sleep(50);
  await outbox.persist();
  process.exit(0);
}
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  const state = await outbox.drain(send, 3);
  if (state === "empty") break;
}
await outbox.persist();
process.exit(0);
