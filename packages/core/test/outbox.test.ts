import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createOutbox, MAX_ATTEMPTS, ROTATE_BYTES, type SendResult } from "../src/outbox.ts";
import { memoryLog, scratch } from "./helpers/stub.ts";

type Item = { id: string; pad?: string };
const ok = (rejected: Extract<SendResult<Item>, { ok: true }>["rejected"] = []) => ({ ok: true as const, rejected });
const CHILD = join(import.meta.dir, "./helpers/outbox-child.ts");

function liveFiles(dir: string): string[] {
  const root = join(dir, "outbox", "audit");
  return existsSync(root) ? readdirSync(root).filter((n) => n.endsWith(".jsonl")) : [];
}

function spawnChild(dir: string, prefix: string, count: number, backend: string, mode = "") {
  return Bun.spawn([process.execPath, CHILD, dir, prefix, String(count), backend, mode], { stdout: "inherit", stderr: "inherit" });
}

describe("outbox", () => {
  test("drains in enqueue order, acks sent rows, and reports more", async () => {
    const outbox = createOutbox<Item>(scratch(), "audit", memoryLog().log);
    for (const id of ["a", "b", "c"]) outbox.enqueue({ id });
    const sent: string[][] = [];
    const send = async (batch: readonly Item[]) => (sent.push(batch.map((i) => i.id)), ok());
    expect(await outbox.drain(send, 2)).toBe("more");
    expect(await outbox.drain(send, 2)).toBe("empty");
    expect(await outbox.drain(send, 2)).toBe("empty");
    expect(sent).toEqual([["a", "b"], ["c"]]);
  });

  test("a failed send keeps every row for the next drain", async () => {
    const outbox = createOutbox<Item>(scratch(), "audit", memoryLog().log);
    outbox.enqueue({ id: "a" });
    expect(await outbox.drain(async () => ({ ok: false }), 10)).toBe("blocked");
    const sent: string[] = [];
    await outbox.drain(async (batch) => (sent.push(...batch.map((i) => i.id)), ok()), 10);
    expect(sent).toEqual(["a"]);
  });

  test("lines whose append failed are still written by the next flush", async () => {
    const dir = scratch();
    const outbox = createOutbox<Item>(dir, "audit", memoryLog().log);
    outbox.enqueue({ id: "a" });
    await Bun.sleep(150);
    const [name] = liveFiles(dir);
    const file = join(dir, "outbox", "audit", name!);
    chmodSync(file, 0o400);
    outbox.enqueue({ id: "b" });
    await Bun.sleep(150);
    chmodSync(file, 0o600);
    outbox.enqueue({ id: "c" });
    await outbox.persist();
    const ids = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l).v.id);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  test(`a rejected row is retried until ${MAX_ATTEMPTS} attempts, then dead-lettered`, async () => {
    const dir = scratch();
    const { log, lines } = memoryLog();
    const outbox = createOutbox<Item>(dir, "audit", log);
    outbox.enqueue({ id: "flaky" });
    outbox.enqueue({ id: "fine" });
    let sends = 0;
    const send = async (batch: readonly Item[]) => {
      sends += 1;
      return ok(batch.filter((i) => i.id === "flaky").map((item) => ({ item, error: "row timeout" })));
    };
    for (let i = 0; i < 20; i++) await outbox.drain(send, 10);
    expect(sends).toBe(MAX_ATTEMPTS);
    await outbox.persist();
    const deadDir = join(dir, "outbox", "audit", "dead");
    const dead = readdirSync(deadDir).flatMap((f) => readFileSync(join(deadDir, f), "utf8").trim().split("\n")).map((l) => JSON.parse(l));
    expect(dead.map((d) => [d.item.id, d.attempts, d.error])).toEqual([["flaky", MAX_ATTEMPTS, "row timeout"]]);
    expect(lines.filter((l) => l.message === "outbox row dead-lettered")).toHaveLength(1);
  });

  test("a permanently rejected row is dead-lettered on the first attempt", async () => {
    const dir = scratch();
    const outbox = createOutbox<Item>(dir, "audit", memoryLog().log);
    outbox.enqueue({ id: "bad" });
    let sends = 0;
    const send = async (batch: readonly Item[]) => (sends++, ok(batch.map((item) => ({ item, error: "invalid row: x", permanent: true }))));
    await outbox.drain(send, 10);
    await outbox.drain(send, 10);
    expect(sends).toBe(1);
    await outbox.persist();
    expect(readdirSync(join(dir, "outbox", "audit", "dead"))).toHaveLength(1);
  });

  test("persist writes unsent rows to the process file", async () => {
    const dir = scratch();
    const outbox = createOutbox<Item>(dir, "audit", memoryLog().log);
    outbox.enqueue({ id: "a" });
    outbox.enqueue({ id: "b" });
    await outbox.drain(async (batch) => ok(), 1);
    await outbox.persist();
    const [file] = liveFiles(dir);
    expect(file).toMatch(new RegExp(`^${process.pid}-[0-9a-f]+\\.jsonl$`));
    const text = readFileSync(join(dir, "outbox", "audit", file!), "utf8");
    expect(text).toContain('"id":"b"');
  });

  test("enqueue does not touch the disk until the coalescing window passes", async () => {
    const dir = scratch();
    const outbox = createOutbox<Item>(dir, "audit", memoryLog().log);
    outbox.enqueue({ id: "a" });
    expect(liveFiles(dir)).toEqual([]);
    await Bun.sleep(250);
    expect(liveFiles(dir)).toHaveLength(1);
  });

  test("rotation past 10 MB rewrites the file with only unacked rows", async () => {
    const dir = scratch();
    const outbox = createOutbox<Item>(dir, "audit", memoryLog().log);
    const pad = "x".repeat(1024 * 1024);
    for (let i = 0; i < 9; i++) outbox.enqueue({ id: `big-${i}`, pad });
    await Bun.sleep(150);
    await outbox.drain(async () => ok(), 8);
    for (let i = 9; i < 11; i++) outbox.enqueue({ id: `big-${i}`, pad });
    await Bun.sleep(150);
    const file = join(dir, "outbox", "audit", liveFiles(dir)[0]!);
    expect(statSync(file).size).toBeLessThan(ROTATE_BYTES);
    const ids = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l).v.id);
    expect(ids).toEqual(["big-8", "big-9", "big-10"]);
  });

  test("a dead process's rows are adopted and sent by the next process", async () => {
    const dir = scratch();
    const writer = spawnChild(dir, "dead", 4, "none");
    expect(await writer.exited).toBe(0);
    expect(liveFiles(dir)).toHaveLength(1);

    const outbox = createOutbox<Item>(dir, "audit", memoryLog().log);
    const sent: string[] = [];
    await outbox.drain(async (batch) => (sent.push(...batch.map((i) => i.id)), ok()), 10);
    expect(sent).toEqual(["dead-0", "dead-1", "dead-2", "dead-3"]);
    expect(liveFiles(dir).some((f) => f.startsWith(`${writer.pid}-`))).toBe(false);
  });

  test("a second outbox in the same process leaves a live outbox's rows alone", async () => {
    const dir = scratch();
    const first = createOutbox<Item>(dir, "audit", memoryLog().log);
    first.enqueue({ id: "r1" });
    await Bun.sleep(150);
    const second = createOutbox<Item>(dir, "audit", memoryLog().log);
    const sent: string[] = [];
    await second.drain(async (batch) => (sent.push(...batch.map((i) => `second:${i.id}`)), ok()), 10);
    await first.drain(async (batch) => (sent.push(...batch.map((i) => `first:${i.id}`)), ok()), 10);
    expect(sent).toEqual(["first:r1"]);
  });

  test("a retired outbox's unsent rows are adopted once its in-flight drain settles", async () => {
    const dir = scratch();
    const first = createOutbox<Item>(dir, "audit", memoryLog().log);
    first.enqueue({ id: "sent" });
    first.enqueue({ id: "left" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sent: string[] = [];
    const inFlight = first.drain(async (batch) => (sent.push(...batch.map((i) => `first:${i.id}`)), await gate, ok()), 1);
    await Bun.sleep(20);
    const persisted = first.persist();
    await Bun.sleep(30);
    const second = createOutbox<Item>(dir, "audit", memoryLog().log);
    const drained = second.drain(async (batch) => (sent.push(...batch.map((i) => `second:${i.id}`)), ok()), 10);
    await Bun.sleep(50);
    release();
    await Promise.all([inFlight, persisted, drained]);
    expect(sent).toEqual(["first:sent", "second:left"]);
  });

  test("rows the backend stored while the process was shutting down are not sent again by the next process", async () => {
    const dir = scratch();
    const seen: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const { rows } = (await req.json()) as { rows: Item[] };
        seen.push(...rows.map((r) => r.id));
        await Bun.sleep(300);
        return new Response("ok");
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}`;
      expect(await spawnChild(dir, "first", 4, url, "exit-during-send").exited).toBe(0);
      expect(await spawnChild(dir, "second", 1, url).exited).toBe(0);
    } finally {
      server.stop(true);
    }
    expect(seen.sort()).toEqual(["first-0", "first-1", "first-2", "first-3", "second-0"]);
  });

  test("two live processes sharing the directory never send the same row twice", async () => {
    const dir = scratch();
    expect(await spawnChild(dir, "orphan", 5, "none").exited).toBe(0);

    const seen: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const { rows } = (await req.json()) as { rows: Item[] };
        seen.push(...rows.map((r) => r.id));
        return new Response("ok");
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}`;
      const a = spawnChild(dir, "a", 7, url);
      const b = spawnChild(dir, "b", 7, url);
      expect([await a.exited, await b.exited]).toEqual([0, 0]);
    } finally {
      server.stop(true);
    }
    const expected = [
      ...Array.from({ length: 5 }, (_, i) => `orphan-${i}`),
      ...Array.from({ length: 7 }, (_, i) => `a-${i}`),
      ...Array.from({ length: 7 }, (_, i) => `b-${i}`),
    ];
    expect([...seen].sort()).toEqual(expected.sort());
  });
});
