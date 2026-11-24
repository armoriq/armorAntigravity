import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../src/config.ts";
import { runReportingEnabled } from "@armorantigravity/evidence";

// regression: #0013
test("the persistent runs switch accepts only true with an explicit environment override", () => {
  const dir = mkdtempSync(join(tmpdir(), "agd-config-"));
  try {
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ runReportingEnabled: true }));
    const config = readConfig(file, { info() {}, warn() {}, error() {} });
    expect(runReportingEnabled({}, config.runReportingEnabled)).toBe(true);
    expect(runReportingEnabled({ ARMORIQ_RUN_REPORTING_ENABLED: "false" }, config.runReportingEnabled)).toBe(false);
    for (const [value, enabled] of [[true, true], [false, false], ["true", false], [1, false], ["1", false], ["yes", false], ["on", false], [null, false]] as const) {
      writeFileSync(file, JSON.stringify({ runReportingEnabled: value }));
      const loaded = readConfig(file, { info() {}, warn() {}, error() {} });
      expect(runReportingEnabled({}, loaded.runReportingEnabled)).toBe(enabled);
    }
    for (const [value, enabled] of [["true", true], ["false", false], ["1", false], ["yes", false], ["on", false], ["TRUE", false], [" true", false], ["true ", false], ["", false]] as const) {
      for (const configured of [true, false]) expect(runReportingEnabled({ ARMORIQ_RUN_REPORTING_ENABLED: value }, configured)).toBe(enabled);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
