import type { RecordTokenLatencyPayload } from "@armoriq/sdk-dev";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PRODUCT, type EvidenceDeps } from "../context.ts";
import { writeJson } from "../io/backend-usage.ts";
import { isRecord, parseJson } from "../io/http.ts";
import type { UsagePump } from "./usage.ts";

export interface LatencyPump {
  readonly name: "latency";
  turnStarted(sessionId: string, at: number): void;
  turnEnded(sessionId: string, at: number): void;
  start(): void;
  kick(): void;
  stop(): Promise<void>;
}

type Op = { kind: "start" | "stop"; sessionId: string; at: number };

const safeName = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");
const STOP_DEADLINE_MS = 2_000;

// Turn start is PreInvocation and end is PostInvocation or Stop, measured by the daemon's clock.
// One histogram per session and UTC day; conmap replaces the row, so a re-post is idempotent.
export function createLatencyPump(deps: EvidenceDeps & { usage: Pick<UsagePump, "client"> }, options: { stopDeadlineMs?: number } = {}): LatencyPump {
  const { log } = deps;
  const dir = path.join(deps.dataDir, "latency");
  // Sessions with samples not yet posted, kept on disk so a restart still sends their last turns.
  const pendingPath = path.join(dir, "pending.json");
  const ops: Op[] = [];
  const touched = new Set<string>();
  let stopped = false;
  let chain: Promise<void> = readFile(pendingPath, "utf8")
    .then((text) => {
      const raw = parseJson(text);
      if (Array.isArray(raw)) for (const id of raw) if (typeof id === "string") touched.add(id);
    })
    .catch(() => {});
  const savePending = () => writeJson(pendingPath, [...touched]);

  const store = (async () => {
    const { TurnTimingStore } = await import("@armoriq/sdk-dev");
    return new TurnTimingStore(path.join(dir, "turns"));
  })();

  function apply(): void {
    chain = chain.then(async () => {
      const s = await store;
      let ended = false;
      for (const op of ops.splice(0)) {
        if (op.kind === "start") s.start(op.sessionId, op.at);
        else {
          s.stop(op.sessionId, op.at);
          touched.add(op.sessionId);
          ended = true;
        }
      }
      if (ended) await savePending();
    }).catch((error) => log.warn("latency: turn not stored", { error: String(error) }));
  }

  async function send(): Promise<void> {
    const ready = await deps.usage.client();
    if (!ready) return;
    const { turnLatencyPayloads } = await import("@armoriq/sdk-dev");
    const s = await store;
    for (const sessionId of [...touched]) {
      touched.delete(sessionId);
      const identity = { product: PRODUCT, sessionId, deviceId: ready.login.deviceId, deviceName: ready.login.deviceName };
      const sentPath = path.join(dir, `${safeName(sessionId)}.sent.json`);
      const raw = parseJson(await readFile(sentPath, "utf8").catch(() => ""));
      const sent: Record<string, string> = {};
      if (isRecord(raw)) for (const [k, v] of Object.entries(raw)) if (typeof v === "string") sent[k] = v;
      const payloads: RecordTokenLatencyPayload[] = turnLatencyPayloads(identity, s.samples(sessionId));
      for (const payload of payloads) {
        const digest = JSON.stringify(payload);
        if (sent[payload.usageDate] === digest) continue;
        const res = await ready.client.recordLatency(payload);
        if (res.ok) sent[payload.usageDate] = digest;
        else {
          touched.add(sessionId);
          log.warn("latency: not sent", { usageDate: payload.usageDate, reason: res.reason });
        }
      }
      await writeJson(sentPath, sent);
    }
    await savePending();
  }

  function kick(): void {
    if (stopped) return;
    chain = chain.then(() => (touched.size ? send() : undefined)).catch((error) => log.warn("latency: send failed", { error: String(error) }));
  }

  return {
    name: "latency",
    turnStarted(sessionId, at) {
      ops.push({ kind: "start", sessionId, at });
      apply();
    },
    turnEnded(sessionId, at) {
      ops.push({ kind: "stop", sessionId, at });
      apply();
    },
    // Sends what a previous daemon left pending.
    start: kick,
    kick,
    async stop() {
      kick();
      stopped = true;
      // The SDK retries a latency post for up to two minutes; what is not sent stays pending on disk.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([chain, new Promise<void>((resolve) => (deadline = setTimeout(resolve, options.stopDeadlineMs ?? STOP_DEADLINE_MS)))]);
      clearTimeout(deadline);
    },
  };
}
