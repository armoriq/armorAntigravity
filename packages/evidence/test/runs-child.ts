import { createRunsPump } from "../src/pumps/runs.ts";

const runs = createRunsPump({
  dataDir: process.argv[2]!, enabled: true, log: { info() {}, warn() {}, error() {} },
  uploads: { client: { product: "armorantigravity", version: "test" }, headers: {}, report() {}, login: () => ({ backend: "http://localhost:1", apiKey: "test-runs", userId: "u", orgId: "o", email: "test@example.com", deviceId: "d", deviceName: "test" }) },
});
runs.begin("killed", "s", Date.now(), true);
runs.attempt("killed", "call", "bash", true);
process.kill(process.pid, "SIGKILL");
