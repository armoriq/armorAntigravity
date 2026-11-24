import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rulesFileText } from "@armorantigravity/intent";
import { syncRules } from "../src/rules.ts";

const shipped = readFileSync(path.join(import.meta.dir, "..", "..", "mcp", "rules", "armoriq.md"), "utf8");
const quiet = { info() {}, warn() {}, error() {} };
const fileIn = () => path.join(mkdtempSync(path.join(tmpdir(), "agd-rules-")), "armoriq.md");

test("the enforce text is the rules file the installer ships", () => {
  expect(rulesFileText("enforce")).toBe(shipped);
});

test("outside enforce the installed rule stops asking for a plan, and Block puts it back", () => {
  const file = fileIn();
  writeFileSync(file, shipped, { mode: 0o644 });

  syncRules(file, "monitor", quiet);
  const monitor = readFileSync(file, "utf8");
  expect(monitor).not.toContain("register_intent_plan once");
  expect(monitor).toContain("ArmorIQ intent enforcement");
  expect(statSync(file).mode & 0o777).toBe(0o644);

  syncRules(file, "enforce", quiet);
  expect(readFileSync(file, "utf8")).toBe(shipped);
});

test("a rules file the installer did not write is left alone, and none is created", () => {
  const own = fileIn();
  writeFileSync(own, "my own rule\n");
  syncRules(own, "monitor", quiet);
  expect(readFileSync(own, "utf8")).toBe("my own rule\n");

  const missing = fileIn();
  syncRules(missing, "monitor", quiet);
  expect(existsSync(missing)).toBe(false);
});
