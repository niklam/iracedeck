/**
 * Reroute probe (#1411): the repeatable check of the session-identity and
 * reroute code in src/addon.cc, which no unit test can reach — it is COM on a
 * live audio device, and the suite runs against the mock.
 *
 * It loads the real addon, sets a session identity, opens the output device
 * and keeps it open, and prints a heartbeat. While it runs, change the Windows
 * default output device (or pull the device): a healthy addon prints
 * `REROUTED` and keeps beating; a main thread that Windows has locked up
 * prints `STALLED`, and after ten seconds of it the probe ends itself, since
 * nothing else will. `list-audio-sessions.ps1`, beside this file, shows from
 * outside whether the session got its name.
 *
 * Run it with `--busy`. The freeze needed the reroute to reach JavaScript a
 * few milliseconds late, into the next of the two or three rounds Windows
 * sends per device change, and an idle event loop is never late: without the
 * option the addon that froze the plugin survived 21 changes in a row.
 *
 * Usage, after `pnpm --filter @iracedeck/audio-native build`:
 *
 *   node packages/audio-native/scripts/reroute-probe.mjs [options]
 *
 *   --list             print the output devices with their ids, and exit
 *   --name <text>      session display name (default "iRaceDeck probe")
 *   --icon <path>      absolute path to an .ico for the session
 *   --device <id>      open this device (an id from --list), not the default
 *   --clip <path>      loop this audio file; without it the device is open
 *                      and silent
 *   --volume <0..1>    volume of the clip (default 0.05)
 *   --seconds <n>      stop after n seconds (default: run until Ctrl+C)
 *   --busy <ms>        keep the main thread unavailable for this long at a
 *                      time, over and over, the way a plugin's is in a race;
 *                      15 puts a reroute's arrival anywhere in the next round
 *   --no-destroy       leave with process.exit(0) and no destroyAudioEngine,
 *                      the way a deck host ends a plugin
 */
import { existsSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";

/** A beat of the event loop, and the longest the loop may miss them before it counts as stalled. */
const BEAT_INTERVAL_MS = 100;
const HEARTBEAT_INTERVAL_MS = 1000;
const STALL_THRESHOLD_MS = 1500;
/** A loop stalled this long is not coming back, and a frozen main thread cannot end the process itself. */
const STALL_GIVE_UP_MS = 10_000;

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const startedAt = performance.now();

/**
 * Print one line, synchronously: nothing is lost when the process ends with
 * process.exit, and the watchdog thread can print while the main thread is
 * blocked.
 */
function log(line) {
  const elapsed = ((performance.now() - startedAt) / 1000).toFixed(3).padStart(8);

  writeSync(1, `[+${elapsed}s] ${line}\n`);
}

function fail(message) {
  writeSync(2, `reroute-probe: ${message}\n`);
  process.exit(1);
}

function parseOptions() {
  try {
    return parseArgs({
      options: {
        list: { type: "boolean", default: false },
        name: { type: "string", default: "iRaceDeck probe" },
        icon: { type: "string" },
        device: { type: "string" },
        clip: { type: "string" },
        volume: { type: "string", default: "0.05" },
        seconds: { type: "string" },
        busy: { type: "string" },
        "no-destroy": { type: "boolean", default: false },
      },
    }).values;
  } catch (error) {
    return fail(error.message);
  }
}

/**
 * The WASAPI endpoint id inside a device id from getAudioDevices: the hex is
 * the bytes of a UTF-16 string, which is the id Windows itself shows. The addon
 * trims trailing zero bytes, the high byte of the last character among them.
 */
function endpointIdOf(deviceId) {
  const hex = deviceId.length % 4 === 0 ? deviceId : `${deviceId}00`;

  return Buffer.from(hex, "hex").toString("utf16le").replace(/\0+$/, "");
}

/**
 * Watches the event loop from a second thread, so a loop that never comes back
 * — the #1411 freeze — still says so. The main thread counts beats into shared
 * memory; the watchdog reports while the count stands still, and then ends
 * the process: Ctrl+C is handled on the thread that is stuck.
 */
function startWatchdog(beats) {
  const source = `
    const { writeSync } = require("node:fs");
    const { workerData } = require("node:worker_threads");
    const beats = new Int32Array(workerData.beats);
    let seen = Atomics.load(beats, 0);
    let changedAt = Date.now();
    let reportedAt = 0;
    setInterval(() => {
      const now = Date.now();
      const current = Atomics.load(beats, 0);
      if (current !== seen) {
        seen = current;
        changedAt = now;
        reportedAt = 0;
        return;
      }
      const stalledFor = now - changedAt;
      if (stalledFor > workerData.giveUp) {
        writeSync(1, "STALLED for good after " + stalledFor + " ms: ending the process\\n");
        process.kill(process.pid);
      }
      if (stalledFor > workerData.threshold && now - reportedAt >= 1000) {
        reportedAt = now;
        writeSync(1, "STALLED " + stalledFor + " ms and counting: the event loop is blocked\\n");
      }
    }, 250);
  `;
  const watchdog = new Worker(source, {
    eval: true,
    workerData: { beats: beats.buffer, threshold: STALL_THRESHOLD_MS, giveUp: STALL_GIVE_UP_MS },
  });

  watchdog.unref();

  return watchdog;
}

const options = parseOptions();

if (process.platform !== "win32") {
  fail("Windows only: the session identity and the reroute are WASAPI code.");
}

if (process.env.IRACEDECK_MOCK) {
  fail("IRACEDECK_MOCK is set, which loads the mock. Unset it: the probe is for the real addon.");
}

if (existsSync(join(process.cwd(), ".mock"))) {
  fail("a .mock file in the current directory forces the mock. Run the probe from somewhere else.");
}

const addonPath = join(packageDir, "build", "Release", "audio_native.node");
const entryPath = join(packageDir, "dist", "index.js");

if (!existsSync(addonPath) || !existsSync(entryPath)) {
  fail("the addon is not built. Run: pnpm --filter @iracedeck/audio-native build");
}

const volume = Number(options.volume);

if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
  fail(`--volume must be a number from 0 to 1, got "${options.volume}"`);
}

const seconds = options.seconds === undefined ? null : Number(options.seconds);

if (seconds !== null && (!Number.isFinite(seconds) || seconds <= 0)) {
  fail(`--seconds must be a positive number, got "${options.seconds}"`);
}

const busyMs = options.busy === undefined ? null : Number(options.busy);

if (busyMs !== null && (!Number.isFinite(busyMs) || busyMs <= 0)) {
  fail(`--busy must be a positive number of milliseconds, got "${options.busy}"`);
}

if (options.icon !== undefined && !isAbsolute(options.icon)) {
  fail("--icon must be an absolute path: Windows resolves it, not this process.");
}

const clipPath = options.clip === undefined ? null : resolve(options.clip);

if (clipPath !== null && !existsSync(clipPath)) {
  fail(`--clip not found: ${clipPath}`);
}

const { AudioChannel, AudioNative } = await import(pathToFileURL(entryPath).href);
const native = new AudioNative();

if (!native.initAudioEngine()) {
  fail("initAudioEngine failed.");
}

const devices = native.getAudioDevices();

// The wrapper falls back to the mock without a word when the binary fails to load.
if (devices.some((device) => device.id === "mock-device-0")) {
  fail("the mock is loaded, not the addon: build/Release/audio_native.node did not load.");
}

if (options.list) {
  for (const device of devices) {
    log(`${device.isDefault ? "default" : "       "} ${device.name}`);
    log(`          endpoint ${endpointIdOf(device.id)}`);
    log(`          --device ${device.id}`);
  }

  native.destroyAudioEngine();
  process.exit(0);
}

log(`pid ${process.pid}, node ${process.version}`);

if (!native.setSessionIdentity(options.name, options.icon)) {
  fail("setSessionIdentity returned false.");
}

log(`session identity: name "${options.name}"${options.icon ? `, icon ${options.icon}` : ""}`);

if (options.device !== undefined) {
  if (!native.setAudioDeviceById(options.device)) {
    fail("setAudioDeviceById returned false: no such device now. See --list.");
  }

  const selected = devices.find((device) => device.id === options.device);

  log(`device: ${selected?.name ?? "?"} (${endpointIdOf(options.device)})`);
} else {
  log(`device: the system default (${devices.find((device) => device.isDefault)?.name ?? "?"})`);
}

let reroutes = 0;

native.setDeviceReroutedCallback(() => {
  reroutes++;
  log(`REROUTED #${reroutes}`);
});

if (clipPath !== null && !native.playOnChannel(AudioChannel.Ambient, clipPath, true, volume)) {
  fail(`playOnChannel failed for ${clipPath}`);
}

if (!native.startAudioEngine()) {
  fail("startAudioEngine failed.");
}

log(clipPath === null ? "device open, silent" : `device open, looping ${clipPath} at volume ${volume}`);

if (busyMs !== null) {
  log(`main thread busy ${busyMs} ms at a time`);
}

const beats = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const watchdog = startWatchdog(beats);

let lastBeatAt = performance.now();
let worstBlockMs = 0;
let stalls = 0;

const beatTimer = setInterval(() => {
  const now = performance.now();
  const blockedMs = now - lastBeatAt - BEAT_INTERVAL_MS;

  lastBeatAt = now;
  worstBlockMs = Math.max(worstBlockMs, blockedMs);
  Atomics.add(beats, 0, 1);

  if (blockedMs > STALL_THRESHOLD_MS) {
    stalls++;
    log(`STALLED ${Math.round(blockedMs)} ms: the event loop was blocked, and is running again`);
  }
}, BEAT_INTERVAL_MS);

let lastHeartbeatAt = performance.now();
let heartbeats = 0;

const heartbeatTimer = setInterval(() => {
  const now = performance.now();
  const gapMs = Math.round(now - lastHeartbeatAt);

  lastHeartbeatAt = now;
  heartbeats++;
  log(`heartbeat ${heartbeats} gap=${gapMs}ms worst-block=${Math.max(0, Math.round(worstBlockMs))}ms`);
  worstBlockMs = 0;
}, HEARTBEAT_INTERVAL_MS);

let finished = false;
let secondsTimer = null;
let busyImmediate = null;

/**
 * Sleeps rather than spins: the thread is just as unavailable, and no core is
 * burnt. One turn of the event loop runs between two sleeps, which is when a
 * reroute waiting for the thread gets through.
 */
const busyGate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function stayBusy() {
  Atomics.wait(busyGate, 0, 0, busyMs);
  busyImmediate = setImmediate(stayBusy);
}

if (busyMs !== null) {
  busyImmediate = setImmediate(stayBusy);
}

function finish(reason) {
  if (finished) {
    return;
  }

  finished = true;
  clearInterval(beatTimer);
  clearInterval(heartbeatTimer);
  clearTimeout(secondsTimer);
  clearImmediate(busyImmediate);
  log(`${reason}: ${heartbeats} heartbeats, ${reroutes} reroutes, ${stalls} stalls`);

  if (options["no-destroy"]) {
    log("leaving with process.exit(0), no destroyAudioEngine");
    process.exit(0);
  }

  const destroyStartedAt = performance.now();

  native.destroyAudioEngine();
  log(`destroyAudioEngine returned after ${Math.round(performance.now() - destroyStartedAt)} ms`);
  // The event loop is empty once the watchdog is gone, and the process ends by itself.
  void watchdog.terminate();
}

process.on("SIGINT", () => finish("Ctrl+C"));

if (seconds !== null) {
  secondsTimer = setTimeout(() => finish(`${seconds} s elapsed`), seconds * 1000);
}
