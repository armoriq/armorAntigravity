import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOrgModeStore } from "../src/org-mode.ts";

test("a mode that cannot be saved is logged, leaves no temp file, and still applies in memory", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "agd-org-"));
  // A directory where the file should be makes the rename fail.
  mkdirSync(path.join(dataDir, "org-mode.json", "blocker"), { recursive: true });
  const warnings: string[] = [];
  const store = createOrgModeStore(dataDir, {}, { info() {}, warn: (m) => void warnings.push(m), error() {} }, () => "login-test");

  store.set({ mode: "enforce", notices: false });

  expect(warnings).toEqual(["org mode not saved"]);
  expect(readdirSync(dataDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  expect(store.monitoring()).toBe(false);
});
