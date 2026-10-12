// Reports armorOpenCode files that changed upstream since packages/core vendored them.
// Usage: bun scripts/check-core-sync.ts [--repo-dir <armorOpenCode clone>]
// Without --repo-dir it reads GitHub with GH_TOKEN or GITHUB_TOKEN.
// Exit 0: in sync. Exit 1: upstream moved. Exit 2: upstream unreachable or manifest invalid.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Manifest = { repo: string; ref: string; commit: string; files: { upstream: string; local: string; blob: string }[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(raw: unknown): Manifest | string {
  if (!isRecord(raw)) return "manifest must be an object";
  const { repo, ref, commit, files } = raw;
  if (typeof repo !== "string" || typeof ref !== "string" || typeof commit !== "string") return "repo, ref and commit must be strings";
  if (!Array.isArray(files)) return "files must be an array";
  const out: Manifest["files"] = [];
  for (const [i, f] of files.entries()) {
    if (!isRecord(f) || typeof f.upstream !== "string" || typeof f.local !== "string" || typeof f.blob !== "string") {
      return `files[${i}] needs upstream, local and blob strings`;
    }
    out.push({ upstream: f.upstream, local: f.local, blob: f.blob });
  }
  return { repo, ref, commit, files: out };
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const root = join(import.meta.dir, "..");
const manifestPath = join(root, "packages/core/UPSTREAM.json");
const parsed = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
if (typeof parsed === "string") fail(`${manifestPath}: ${parsed}`);
const manifest: Manifest = parsed;

const dirFlag = process.argv.indexOf("--repo-dir");
const repoDir = dirFlag >= 0 ? process.argv[dirFlag + 1] : undefined;
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;

async function upstreamBlob(path: string): Promise<string | null> {
  if (repoDir !== undefined) {
    const r = spawnSync("git", ["-C", repoDir, "rev-parse", `origin/${manifest.ref}:${path}`], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  }
  const url = `https://api.github.com/repos/${manifest.repo}/contents/${path}?ref=${manifest.ref}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } });
  if (res.status === 404) return null;
  if (!res.ok) fail(`GET ${url}: ${res.status}`);
  const body: unknown = await res.json();
  if (!isRecord(body) || typeof body.sha !== "string") fail(`GET ${url}: no sha in response`);
  return body.sha;
}

if (repoDir === undefined && !token) fail("pass --repo-dir <armorOpenCode clone> or set GH_TOKEN with read access to " + manifest.repo);

let moved = 0;
for (const file of manifest.files) {
  const blob = await upstreamBlob(file.upstream);
  if (blob === file.blob) continue;
  moved += 1;
  if (blob === null) console.log(`removed upstream: ${file.upstream} (vendored as ${file.local})`);
  else console.log(`changed upstream: ${file.upstream} (vendored as ${file.local}); review with: git diff ${file.blob} ${blob}`);
}
if (moved > 0) {
  console.log(`${moved} file(s) moved since ${manifest.repo}@${manifest.commit.slice(0, 7)}; port the change and update packages/core/UPSTREAM.json.`);
  process.exit(1);
}
console.log(`packages/core is in sync with ${manifest.repo} ${manifest.ref} (${manifest.files.length} files).`);
