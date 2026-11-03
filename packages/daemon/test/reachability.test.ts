import { expect, test } from "bun:test";
import type { Login } from "../src/auth.ts";
import { CACHE_MS, createReachability, PROBE_TIMEOUT_MS } from "../src/reachability.ts";

const quiet = { info() {}, warn() {}, error() {} };
const login: Login = { backend: "https://backend.test", apiKey: "ak_1", userId: "u", orgId: "o", email: "e", deviceId: "d", deviceName: "n" };

function setup(answer: (signal: AbortSignal) => Promise<Response>, timeoutMs = 50) {
  let clock = 0;
  const calls: string[] = [];
  const statuses: number[] = [];
  const reach = createReachability({
    log: quiet,
    headers: {},
    onResponse: (status) => statuses.push(status),
    fetch: (url, init) => {
      calls.push(url);
      if (!init.signal) throw new Error("probe has no timeout signal");
      return answer(init.signal);
    },
    now: () => clock,
    timeoutMs,
  });
  return { reach, calls, statuses, advance: (ms: number) => (clock += ms) };
}

const hang = (signal: AbortSignal) => new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));

test("the spec's numbers: a 2 second probe timeout and a 30 second cache", () => {
  expect(PROBE_TIMEOUT_MS).toBe(2_000);
  expect(CACHE_MS).toBe(30_000);
});

test("no answer within the timeout, a network error and a 5xx each mean unreachable", async () => {
  expect(await setup(hang).reach.check(login)).toEqual({ kind: "unreachable", reason: "no answer in 50 ms" });
  const network = await setup(() => Promise.reject(new TypeError("Unable to connect"))).reach.check(login);
  expect(network).toMatchObject({ kind: "unreachable", reason: expect.stringContaining("Unable to connect") });
  const down = setup(async () => new Response("", { status: 503 }));
  expect(await down.reach.check(login)).toEqual({ kind: "unreachable", reason: "HTTP 503" });
  expect(down.statuses).toEqual([503]);
  expect(down.calls).toEqual(["https://backend.test/iap/validate-key"]);
});

test("a 401 is signed out, not unreachable, and reaches the auth state", async () => {
  const s = setup(async () => Response.json({ message: "Invalid or expired API key" }, { status: 401 }));
  expect(await s.reach.check(login)).toEqual({ kind: "signed_out" });
  expect(s.statuses).toEqual([401]);
});

test("a 4xx other than 401 still proves the backend answers", async () => {
  expect(await setup(async () => new Response("", { status: 404 })).reach.check(login)).toEqual({ kind: "reachable" });
});

test("a verdict is cached for 30 s, shared by concurrent callers, and dropped when the key changes", async () => {
  let status = 503;
  const s = setup(async () => new Response("", { status }));
  const [a, b] = await Promise.all([s.reach.check(login), s.reach.check(login)]);
  expect(a).toEqual(b);
  expect(s.calls).toHaveLength(1);

  status = 200;
  s.advance(CACHE_MS - 1);
  expect((await s.reach.check(login)).kind).toBe("unreachable");
  expect(s.calls).toHaveLength(1);

  s.advance(1);
  expect((await s.reach.check(login)).kind).toBe("reachable");
  expect(s.calls).toHaveLength(2);

  expect((await s.reach.check({ ...login, apiKey: "ak_2" })).kind).toBe("reachable");
  expect(s.calls).toHaveLength(3);
});
