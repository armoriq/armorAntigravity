import { afterEach, describe, expect, test } from "bun:test";
import { createPolicyBundle, decideV2, parseBundleAgent } from "../src/policy-v2.ts";
import { v2CallOf } from "../src/decision.ts";
import { mapToolCall } from "../src/tools.ts";
import { stubBackend } from "./support/backend.ts";
import { memoryLog } from "./support/log.ts";
import { AGENT, APPROVAL, agentOf, bundleOf, doc, entry, ORG } from "./support/v2.ts";

const home = "/Users/dev";
const NOW = 1_760_000_000_000;

const run = (CommandLine: string) => v2CallOf(mapToolCall({ name: "run_command", args: { CommandLine, Cwd: "/Users/dev/ws" } }), home, NOW, "dev@example.com");
const view = (AbsolutePath: string) => v2CallOf(mapToolCall({ name: "view_file", args: { AbsolutePath } }), home, NOW, "dev@example.com");
const fetchUrl = (Url: string) => v2CallOf(mapToolCall({ name: "read_url_content", args: { Url } }), home, NOW, undefined);

describe("parseBundleAgent", () => {
  test("reads the canonical policies[] list", () => {
    const a = agentOf([entry("floor", "org", "active", doc("floor", ORG, "      run_command: block\n")), entry("try", "agent", "shadow", doc("try", AGENT, "      view_file: block\n"))]);
    expect(a.policies.map((p) => [p.name, p.targetType, p.status])).toEqual([
      ["floor", "org", "active"],
      ["try", "agent", "shadow"],
    ]);
  });

  test("falls back to the legacy single policy on an older backend", () => {
    const document = doc("legacy", AGENT, "      run_command: block\n");
    const a = parseBundleAgent({ orgId: "o", agents: [{ agentId: "uuid", name: "armorantigravity", inactive: false, policy: { policyId: "p1", name: "Legacy", policyHash: null, document }, tools: [], members: [] }] }, "armorantigravity");
    expect(a?.policies).toEqual([{ policyId: "p1", name: "Legacy", policyHash: null, document, targetType: "agent", status: "active" }]);
  });

  test("an org with no entry for this agent has no v2 policy", () => {
    expect(parseBundleAgent({ orgId: "o", agents: [] }, "armorantigravity")).toBeNull();
    expect(decideV2(null, run("ls")).enforced).toBeNull();
  });
});

describe("decideV2", () => {
  test("no active document leaves the call to v1 and the local file", () => {
    expect(decideV2(agentOf([]), run("ls")).enforced).toBeNull();
  });

  test("an agent rule blocks and names its policy", () => {
    const out = decideV2(agentOf([entry("No shell", "agent", "active", doc("no-shell", AGENT, "      run_command: block\n"))]), run("ls"));
    expect(out.enforced?.verdict).toBe("block");
    expect(out.enforced?.policy?.name).toBe("No shell");
    expect(out.enforced?.rule).toBe("run_command#0");
  });

  test("an org-wide block wins over an agent allow", () => {
    const org = entry("Org floor", "org", "active", doc("org-floor", ORG, "      run_command: block\n"));
    const own = entry("Agent allow", "agent", "active", doc("agent-allow", AGENT, "      run_command: allow\n"));
    const out = decideV2(agentOf([org, own]), run("ls"));
    expect(out.enforced?.verdict).toBe("block");
    expect(out.enforced?.policy?.name).toBe("Org floor");
  });

  test("an agent rule tightens an org allow", () => {
    const org = entry("Org allow", "org", "active", doc("org-allow", ORG, "      run_command: allow\n"));
    const own = entry("Agent hold", "agent", "active", doc("agent-hold", AGENT, "      run_command: hold\n", "allow", APPROVAL));
    const out = decideV2(agentOf([org, own]), run("ls"));
    expect(out.enforced?.verdict).toBe("hold");
    expect(out.enforced?.policy?.name).toBe("Agent hold");
  });

  test("a rule written for ArmorClaude's Bash reaches run_command", () => {
    const out = decideV2(agentOf([entry("Org no Bash", "org", "active", doc("org-bash", ORG, "      Bash: block\n"))]), run("ls"));
    expect(out.enforced?.verdict).toBe("block");
  });

  test("an allow-list is read by the primary name, not blocked by an alias it does not list", () => {
    const out = decideV2(agentOf([entry("Allow list", "agent", "active", doc("allow-list", AGENT, "      run_command: allow\n", "block"))]), run("ls"));
    expect(out.enforced?.verdict).toBe("allow");
  });

  test("a network deny matches the URL's host", () => {
    const agent = agentOf([entry("No example", "org", "active", doc("net", ORG, "      run_command: allow\n", "allow", "  network:\n    deny: [\"*.example.com\"]\n"))]);
    expect(decideV2(agent, fetchUrl("https://api.example.com/x")).enforced?.verdict).toBe("block");
    expect(decideV2(agent, fetchUrl("https://armoriq.ai/")).enforced?.verdict).toBe("allow");
  });

  test("a files deny matches a home-relative path", () => {
    const agent = agentOf([entry("No ssh", "org", "active", doc("files", ORG, "      run_command: allow\n", "allow", '  files:\n    deny: ["~/.ssh/**"]\n'))]);
    expect(decideV2(agent, view("/Users/dev/.ssh/id_rsa")).enforced?.verdict).toBe("block");
    expect(decideV2(agent, view("/Users/dev/ws/readme.md")).enforced?.verdict).toBe("allow");
  });

  test("a shadow policy reports its verdict and is never enforced", () => {
    const out = decideV2(agentOf([entry("Shadow no shell", "agent", "shadow", doc("shadow", AGENT, "      run_command: block\n"))]), run("ls"));
    expect(out.enforced).toBeNull();
    expect(out.shadow.map((s) => [s.policy?.name, s.verdict])).toEqual([["Shadow no shell", "block"]]);
  });

  test("an inactive agent with no document is blocked", () => {
    expect(decideV2(agentOf([], { inactive: true }), run("ls")).enforced).toEqual({ verdict: "block", policy: null, rule: "agent_inactive" });
  });
});

describe("createPolicyBundle", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));

  test("revalidates with the ETag and keeps the bundle on a 304", async () => {
    let body = bundleOf([entry("No shell", "agent", "active", doc("no-shell", AGENT, "      run_command: block\n"))]);
    let etag = '"v1"';
    const backend = stubBackend({
      "GET /policy/bundles/current": (req) =>
        req.headers.get("if-none-match") === etag ? new Response(null, { status: 304, headers: { ETag: etag } }) : Response.json(body, { headers: { ETag: etag } }),
    });
    cleanups.push(backend.stop);
    const bundle = createPolicyBundle({ access: () => ({ login: backend.login, client: "armorantigravity/test" }), log: memoryLog(), revalidateMs: 60_000 });
    cleanups.push(() => bundle.stop());

    expect(await bundle.refresh()).toEqual({ kind: "applied", etag: '"v1"', policies: 1 });
    expect(await bundle.refresh()).toEqual({ kind: "unchanged" });
    expect(bundle.current()?.policies[0]?.name).toBe("No shell");
    expect(backend.seen.map((s) => [s.path, s.headers.get("if-none-match")])).toEqual([
      ["/policy/bundles/current?agent=armorantigravity", null],
      ["/policy/bundles/current?agent=armorantigravity", '"v1"'],
    ]);

    body = bundleOf([]);
    etag = '"v2"';
    expect(await bundle.refresh()).toEqual({ kind: "applied", etag: '"v2"', policies: 0 });
    expect(bundle.current()?.policies).toEqual([]);
  });

  test("a failed pull keeps the last bundle", async () => {
    let up = true;
    const backend = stubBackend({
      "GET /policy/bundles/current": () => (up ? Response.json(bundleOf([entry("No shell", "agent", "active", doc("no-shell", AGENT, "      run_command: block\n"))]), { headers: { ETag: '"a"' } }) : new Response("down", { status: 503 })),
    });
    cleanups.push(backend.stop);
    const bundle = createPolicyBundle({ access: () => ({ login: backend.login, client: "t" }), log: memoryLog() });
    cleanups.push(() => bundle.stop());
    await bundle.refresh();
    up = false;
    expect((await bundle.refresh()).kind).toBe("failed");
    expect(bundle.current()?.policies).toHaveLength(1);
  });

  test("logging out drops the bundle", async () => {
    const backend = stubBackend({ "GET /policy/bundles/current": () => Response.json(bundleOf([])) });
    cleanups.push(backend.stop);
    let loggedIn = true;
    const bundle = createPolicyBundle({ access: () => (loggedIn ? { login: backend.login, client: "t" } : null), log: memoryLog() });
    cleanups.push(() => bundle.stop());
    await bundle.refresh();
    expect(bundle.current()).not.toBeNull();
    loggedIn = false;
    expect(bundle.current()).toBeNull();
  });

  test("polls on its own timer", async () => {
    const backend = stubBackend({ "GET /policy/bundles/current": () => Response.json(bundleOf([])) });
    cleanups.push(backend.stop);
    const bundle = createPolicyBundle({ access: () => ({ login: backend.login, client: "t" }), log: memoryLog(), revalidateMs: 20 });
    cleanups.push(() => bundle.stop());
    await Bun.sleep(120);
    expect(backend.seen.length).toBeGreaterThanOrEqual(2);
  });
});
