// armorantigravity and armoriq-agd are node bundles behind a small shell wrapper. The archive ships
// wrappers that resolve node from PATH; `armorantigravity install` rewrites them with the absolute
// interpreter that ran the install, because launchd and systemd do not carry a version manager's node.
export const BUNDLES = [
  { wrapper: "armorantigravity", script: "cli.js", entry: "packages/cli/src/main.ts" },
  { wrapper: "armoriq-agd", script: "agd.js", entry: "packages/daemon/src/main.ts" },
] as const;

// node:sqlite is still flagged experimental on node 22, and the daemon's stderr is a log file.
export const NODE_FLAGS: Readonly<Record<string, string>> = { "armoriq-agd": "--disable-warning=ExperimentalWarning" };

export const MIN_NODE_MAJOR = 22;

export function wrapperText(wrapper: string, node: string | null): string {
  const bundle = BUNDLES.find((b) => b.wrapper === wrapper);
  if (!bundle) throw new Error(`unknown wrapper ${wrapper}`);
  const flags = NODE_FLAGS[wrapper] ?? "";
  return [
    "#!/bin/sh",
    `NODE=${node ? shellQuote(node) : '""'}`,
    `[ -x "$NODE" ] || NODE=$(command -v node) || { echo "ArmorAntigravity needs node ${MIN_NODE_MAJOR} or newer on PATH (https://nodejs.org)." >&2; exit 1; }`,
    `exec "$NODE"${flags ? ` ${flags}` : ""} "$(dirname "$0")"/${bundle.script} "$@"`,
    "",
  ].join("\n");
}

export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}
