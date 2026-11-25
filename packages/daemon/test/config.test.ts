import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../src/config.ts";
import { runReportingEnabled } from "@armorantigravity/evidence";

// regression: #0013
// Owner decision B (2026-11-24): reporting is on unless switched off with exactly false.
test("the persistent runs switch defaults on, accepts only true, and the environment overrides it", () => {
  const dir = mkdtempSync(join(tmpdir(), "agd-config-"));
  try {
    const file = join(dir, "config.json");
    const log = { info() {}, warn() {}, error() {} };
    expect(runReportingEnabled({}, readConfig(join(dir, "missing.json"), log).runReportingEnabled)).toBe(true);
    writeFileSync(file, JSON.stringify({ backendUrl: "https://api.armoriq.ai" }));
    expect(runReportingEnabled({}, readConfig(file, log).runReportingEnabled)).toBe(true);
    expect(runReportingEnabled({ ARMORIQ_RUN_REPORTING_ENABLED: "false" }, readConfig(file, log).runReportingEnabled)).toBe(false);
    writeFileSync(file, JSON.stringify({ runReportingEnabled: true }));
    const config = readConfig(file, log);
    expect(runReportingEnabled({}, config.runReportingEnabled)).toBe(true);
    expect(runReportingEnabled({ ARMORIQ_RUN_REPORTING_ENABLED: "false" }, config.runReportingEnabled)).toBe(false);
    for (const [value, enabled] of [[true, true], [false, false], ["true", false], [1, false], ["1", false], ["yes", false], ["on", false], [null, false]] as const) {
      writeFileSync(file, JSON.stringify({ runReportingEnabled: value }));
      const loaded = readConfig(file, log);
      expect(runReportingEnabled({}, loaded.runReportingEnabled)).toBe(enabled);
    }
    for (const [value, enabled] of [["true", true], ["false", false], ["1", false], ["yes", false], ["on", false], ["TRUE", false], [" true", false], ["true ", false], ["", false]] as const) {
      for (const configured of [true, false, undefined]) expect(runReportingEnabled({ ARMORIQ_RUN_REPORTING_ENABLED: value }, configured)).toBe(enabled);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
