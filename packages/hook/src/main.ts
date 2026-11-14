import {
  DEFAULT_SOCKET_PATH,
  fallbackResponse,
  isHookEvent,
  MODE_FILE_NAME,
  parseHookResponse,
  PROTOCOL_VERSION,
  SOCKET_PATH_ENV,
  type DaemonRequest,
  type HookResponse,
  type Mode,
} from "@armorantigravity/protocol";

// hooks.json must set a timeout above START_BUDGET_MS + RESPONSE_BUDGET_MS, so our own budget,
// not Antigravity's undocumented timeout behavior, decides what happens when the daemon is down.
export const START_BUDGET_MS = 3_000;
export const RESPONSE_BUDGET_MS = 10_000;
const RETRY_MS = 10;

// Every import here costs startup time on each tool call, so the hot path uses only Bun globals.
const socketPath = resolveSocket();

async function main(): Promise<HookResponse> {
  const event = process.argv[2];
  if (!isHookEvent(event)) return null;
  const stdin = await Bun.stdin.text();
  const request: DaemonRequest = { v: PROTOCOL_VERSION, id: crypto.randomUUID(), receivedAt: Date.now(), event, payload: parseJson(stdin) };
  const line = `${JSON.stringify(request)}\n`;
  const deadline = Date.now() + START_BUDGET_MS;
  let started = false;
  for (;;) {
    try {
      const response = parseResponse(await exchange(line), request.id);
      if (response !== undefined) return response;
      return fallbackResponse(event, await cachedMode(), "daemon_unavailable", "armoriq-agd sent an unreadable response");
    } catch (error) {
      if (!(error instanceof ConnectFailed) || Date.now() >= deadline) {
        return fallbackResponse(event, await cachedMode(), "daemon_unavailable", `armoriq-agd did not answer (${error instanceof Error ? error.message : String(error)})`);
      }
      if (!started) {
        started = true;
        await startDaemon();
      }
      await Bun.sleep(RETRY_MS);
    }
  }
}

class ConnectFailed extends Error {}

function exchange(line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const decoder = new TextDecoder();
    const finish = (error: Error | null, value = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`no response in ${RESPONSE_BUDGET_MS} ms`)), RESPONSE_BUDGET_MS);
    Bun.connect({
      unix: socketPath,
      socket: {
        open: (socket) => void socket.write(line),
        data(socket, chunk) {
          buffer += decoder.decode(chunk, { stream: true });
          const nl = buffer.indexOf("\n");
          if (nl < 0) return;
          finish(null, buffer.slice(0, nl));
          socket.end();
        },
        close: () => finish(new Error("connection closed")),
        error: (_socket, error) => finish(error),
        connectError: (_socket, error) => finish(new ConnectFailed(error.message)),
      },
    }).catch((error: unknown) => finish(new ConnectFailed(String(error))));
  });
}

// A second daemon started by a concurrent hook exits on the instance lock, so racing here is safe.
async function startDaemon(): Promise<void> {
  const { spawn } = await import("node:child_process");
  const bin = process.env.ARMORANTIGRAVITY_DAEMON?.trim() || `${process.execPath.slice(0, process.execPath.lastIndexOf("/"))}/armoriq-agd`;
  try {
    spawn(bin, [], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  } catch {}
}

// The daemon writes this file; a missing or unreadable one fails closed.
async function cachedMode(): Promise<Mode> {
  try {
    const text = await Bun.file(`${socketPath.slice(0, socketPath.lastIndexOf("/"))}/${MODE_FILE_NAME}`).text();
    return text.trim() === "monitor" ? "monitor" : "enforce";
  } catch {
    return "enforce";
  }
}

function parseResponse(line: string, id: string): HookResponse | undefined {
  const raw = parseJson(line);
  if (typeof raw !== "object" || raw === null || !("id" in raw) || raw.id !== id || !("response" in raw)) return undefined;
  return parseHookResponse(raw.response);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resolveSocket(): string {
  const home = process.env.HOME ?? "";
  const configured = process.env[SOCKET_PATH_ENV]?.trim();
  if (configured) return configured.startsWith("~/") ? `${home}${configured.slice(1)}` : configured;
  const armoriqHome = process.env.ARMORIQ_HOME?.trim() || `${home}/.armoriq`;
  return DEFAULT_SOCKET_PATH.replace("~/.armoriq", armoriqHome);
}

main().then(
  async (response) => {
    // Bun.stdout instead of process.stdout: setting up the node stream measured 1 to 2.5 ms per PreToolUse on an M5.
    if (response !== null) await Bun.write(Bun.stdout, `${JSON.stringify(response)}\n`).catch(() => {});
    process.exit(0);
  },
  () => process.exit(0),
);
