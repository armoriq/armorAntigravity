// Prototype agd-hook: stdin payload to the daemon over a unix socket, response to stdout.
import { connect } from "node:net";

const event = process.argv[2] ?? "unknown";
const stdin = await Bun.stdin.text();
const socketPath = process.env["ARMORANTIGRAVITY_SOCKET"] ?? "";

const line = await new Promise<string>((resolve, reject) => {
  let buf = "";
  const sock = connect(socketPath, () => {
    const payload: unknown = JSON.parse(stdin);
    sock.write(`${JSON.stringify({ v: 1, id: String(process.pid), receivedAt: Date.now(), event, payload })}\n`);
  });
  sock.setTimeout(5000, () => reject(new Error("timeout")));
  sock.on("data", (chunk) => {
    buf += chunk.toString();
    const nl = buf.indexOf("\n");
    if (nl >= 0) {
      resolve(buf.slice(0, nl));
      sock.end();
    }
  });
  sock.on("error", reject);
}).catch(() => process.exit(1));

const parsed: unknown = JSON.parse(line);
if (typeof parsed !== "object" || parsed === null || !("response" in parsed)) process.exit(1);
process.stdout.write(JSON.stringify(parsed.response));
