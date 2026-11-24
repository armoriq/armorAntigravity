import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../src/config.ts";
import { runReportingEnabled } from "@armorantigravity/evidence";

test("the persistent runs switch is read from config with an explicit environment override", () => {
  const dir = mkdtempSync(join(tmpdir(), "agd-config-"));
  try {
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ runReportingEnabled: true }));
    const config = readConfig(file, { info() {}, warn() {}, error() {} });
    expect(runReportingEnabled({}, config.runReportingEnabled)).toBe(true);
    expect(runReportingEnabled({ ARMORIQ_RUN_REPORTING_ENABLED: "false" }, config.runReportingEnabled)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
