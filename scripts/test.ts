import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(tmpdir(), "agd-test-home-"));
const proc = Bun.spawn(["bun", "test", ...Bun.argv.slice(2)], { env: { ...process.env, HOME: home }, stdio: ["inherit", "inherit", "inherit"] });
const code = await proc.exited;
rmSync(home, { recursive: true, force: true });
process.exit(code);
