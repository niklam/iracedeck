/**
 * Fake VSD Craft / UlanziStudio host for testing #1056 by hand.
 *
 * Reproduces the ONE condition the bug is about: the plugin's socket exists but
 * is not OPEN for N seconds. It does that by listening immediately (so the
 * plugin's connect attempt is not refused — a refusal makes the client exit)
 * and then deliberately sitting on the WebSocket upgrade for N seconds before
 * completing the handshake. That is what delays the client's `open` event, and
 * with it the connect-time read that actually asks the host.
 *
 *   node fake-vsd-host.mjs --port 12345 --delay 15 --answer
 *
 *   --port    port to listen on (default 12345)
 *   --delay   seconds to hold the upgrade before completing it (default 15)
 *   --answer  reply to getGlobalSettings with a recognisable payload
 *             (omit it to model a host that connects but never answers)
 *   --never   never complete the upgrade at all (models "never connects")
 *
 * Every line is stamped with milliseconds since start, so the log can be lined
 * up against the plugin's own log.
 */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);

  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

// `ws` is resolved from the repo/worktree rather than from this script's own
// directory, so the harness can live outside any checkout. pnpm does not hoist,
// so resolve from the package that actually depends on `ws` — the Mirabox
// adapter — rather than from the workspace root, where it is absent.
const repo = flag("repo", process.cwd());
const { WebSocketServer } = createRequire(
  path.join(repo, "packages", "deck-adapter-mirabox", "package.json"),
)("ws");

const port = Number(flag("port", 12345));
const delayMs = Number(flag("delay", 15)) * 1000;
const answer = has("answer");
const never = has("never");

const t0 = Date.now();
const log = (message) => console.log(`[+${String(Date.now() - t0).padStart(6)} ms] ${message}`);

const server = createServer();
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  log(`upgrade requested — holding it for ${delayMs} ms${never ? " (never, --never)" : ""}`);

  // A raw upgrade socket with no error handler throws out of the process when
  // the client goes away mid-handshake — which is exactly what a client under
  // test does. Without this the harness dies with the first probe and every
  // later probe silently measures "nothing listening" instead.
  socket.on("error", (error) => log(`upgrade socket error (client went away): ${error.code ?? error.message}`));

  if (never) return; // socket stays open, never becomes an OPEN WebSocket

  setTimeout(() => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      log("upgrade completed — the plugin's socket is now OPEN");

      const shutdownSec = Number(flag("shutdown", 0));

      if (shutdownSec > 0) {
        setTimeout(() => {
          log("closing the socket — the client exits its process on close");
          ws.close();
          setTimeout(() => process.exit(0), 500);
        }, shutdownSec * 1000);
      }

      ws.on("message", (raw) => {
        const text = raw.toString();

        log(`<- ${text.slice(0, 200)}`);

        if (!answer) return;

        let frame;

        try {
          frame = JSON.parse(text);
        } catch {
          return;
        }

        // Mirabox (VSD) uses `event`; Ulanzi uses `cmd`.
        const kind = frame.event ?? frame.cmd;

        if (kind !== "getGlobalSettings") return;

        const settings = { driverName: "fake-host-migrated", blackBoxFuel: "F6" };
        const reply =
          frame.event !== undefined
            ? { event: "didReceiveGlobalSettings", context: frame.context, payload: { settings } }
            : { cmd: "didReceiveGlobalSettings", uuid: frame.uuid, key: "", actionid: frame.actionid, settings };

        log(`-> didReceiveGlobalSettings ${JSON.stringify(settings)}`);
        ws.send(JSON.stringify(reply));
      });
    });
  }, delayMs);
});

const exitSec = Number(flag("exit", 0));

if (exitSec > 0) {
  setTimeout(() => {
    log(`--exit ${exitSec}s reached; shutting the harness down`);
    process.exit(0);
  }, exitSec * 1000).unref?.();
}

server.listen(port, "127.0.0.1", () => {
  log(`listening on 127.0.0.1:${port} — start the plugin now`);
});
