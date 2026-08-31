/**
 * Measure what `this.ws?.readyState` actually reads on each WebSocket client at
 * the moment the migration deadline would fire (#1056).
 *
 * The question: can deck-core tell "a connect is in progress" apart from "this
 * host is never coming"? If both read CONNECTING, gating a grace period on
 * positive evidence of an in-flight connect is worthless.
 *
 *   node probe-readystate.mjs --repo <worktree> --client mirabox|ulanzi --port 12345 --label "case"
 *
 * Samples every second for 12 s (the deadline is 10 s) and prints the timeline,
 * plus whether the client's onClose fired — which on both clients is what ends
 * the plugin process in production.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);

  return i === -1 ? fallback : args[i + 1];
};

const repo = flag("repo", process.cwd());
const which = flag("client", "mirabox");
const port = flag("port", "12345");
const label = flag("label", "(unlabelled)");

const STATES = { 0: "CONNECTING", 1: "OPEN", 2: "CLOSING", 3: "CLOSED", undefined: "no socket (ws is null)" };

const pkg = which === "ulanzi" ? "deck-adapter-ulanzi" : "deck-adapter-mirabox";
const file = which === "ulanzi" ? "ulanzi-client.js" : "vsd-client.js";
const modulePath = path.join(repo, "packages", pkg, "dist", file);
const mod = await import(pathToFileURL(modulePath).href);
const Client = which === "ulanzi" ? mod.UlanziClient : mod.VSDClient;

// The clients import `ws` themselves; this is only to fail loudly and early if
// the worktree's dependencies are not installed.
createRequire(path.join(repo, "packages", pkg, "package.json"))("ws");

const silent = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };

let closed = false;
const params =
  which === "ulanzi"
    ? { address: "127.0.0.1", port, language: "en" }
    : { port, pluginUuid: "com.iracedeck.sd.core", registerEvent: "registerPlugin" };

const client = new Client(params, silent, () => {
  closed = true;
  console.log(`  onClose fired — in production this is process.exit(0)`);
});

let hostReadyAt = null;
const t0 = Date.now();

client.onHostReady(() => {
  hostReadyAt = Date.now() - t0;
  console.log(`  onHostReady fired at +${hostReadyAt} ms`);
});

console.log(`\n=== ${which} / ${label} (port ${port}) ===`);
await client.connect();

for (let second = 1; second <= 12; second++) {
  await new Promise((r) => setTimeout(r, 1000));

  const state = client.ws?.readyState;

  // 10 s is MIGRATION_TIMEOUT_MS: the sample that decides the question.
  const marker = second === 10 ? "   <-- the deadline fires here" : "";

  console.log(`  +${String(second).padStart(2)}s  readyState=${STATES[state]}  closed=${closed}${marker}`);

  if (closed) break;
}

console.log(`  result: onHostReady ${hostReadyAt === null ? "never fired" : `fired at +${hostReadyAt} ms`}`);
process.exit(0);
