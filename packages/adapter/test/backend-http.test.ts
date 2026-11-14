import { expect, test } from "bun:test";
import { backendRequest, type Fetch } from "../src/backend-http.ts";

const access = (backend: string) => ({
  login: { backend, apiKey: "ak_test", userId: "u", orgId: "o", email: "dev@example.com", deviceId: "dev_1", deviceName: "host" },
  client: "armorantigravity/0.1.0",
});

const capture = () => {
  const seen: string[] = [];
  const fetch: Fetch = (input) => {
    seen.push(input);
    return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
  };
  return { seen, fetch };
};

test("the backend's trailing slashes are dropped before the path is joined", async () => {
  const { seen, fetch } = capture();
  for (const backend of ["https://api.x.io", "https://api.x.io/", "https://api.x.io///"]) {
    await backendRequest(access(backend), { method: "GET", path: "/v1/ping", fetch });
  }
  await backendRequest(access("https://api.x.io/base/"), { method: "GET", path: "/v1/ping", fetch });
  expect(seen).toEqual(["https://api.x.io/v1/ping", "https://api.x.io/v1/ping", "https://api.x.io/v1/ping", "https://api.x.io/base/v1/ping"]);
});

test("a backend holding a long run of interior slashes does not stall the request", async () => {
  const { seen, fetch } = capture();
  const backend = `https://api.x.io${"/".repeat(200_000)}a`;
  const started = performance.now();
  await backendRequest(access(backend), { method: "GET", path: "/v1/ping", fetch });
  expect(performance.now() - started).toBeLessThan(200);
  expect(seen).toEqual([`${backend}/v1/ping`]);
});
