import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createWatchdogWorkerSource,
  initialWatchdogState,
  WATCHDOG_DEFAULTS,
  type WatchdogConfig,
  type WatchdogEffect,
  type WatchdogEvent,
  type WatchdogFrame,
  type WatchdogState,
  watchdogStep,
} from "./main-thread-watchdog.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const DIAGNOSE: WatchdogConfig = { stallMs: 5000, diagnose: true };
const NO_INSPECTOR: WatchdogConfig = { stallMs: 5000, diagnose: false };

/** Feed events through the reducer, collecting every effect. */
function drive(
  events: WatchdogEvent[],
  config: WatchdogConfig = DIAGNOSE,
  start: WatchdogState = initialWatchdogState(0, 0),
): { state: WatchdogState; effects: WatchdogEffect[] } {
  let state = start;
  const effects: WatchdogEffect[] = [];

  for (const event of events) {
    const result = watchdogStep(state, event, config);
    state = result.state;
    effects.push(...result.effects);
  }

  return { state, effects };
}

const tick = (beat: number, now: number): WatchdogEvent => ({ type: "tick", beat, now });

const frame = (functionName: string, lineNumber = 9, columnNumber = 4): WatchdogFrame => ({
  functionName,
  url: "file:///bin/plugin.js",
  lineNumber,
  columnNumber,
});

const writes = (effects: WatchdogEffect[]): Extract<WatchdogEffect, { type: "write" }>[] =>
  effects.filter((e): e is Extract<WatchdogEffect, { type: "write" }> => e.type === "write");

describe("WATCHDOG_DEFAULTS", () => {
  it("are the spec's values", () => {
    expect(WATCHDOG_DEFAULTS).toEqual({ heartbeatMs: 500, stallMs: 5000, pauseTimeoutMs: 2000 });
  });
});

describe("watchdogStep", () => {
  it("does nothing while the heartbeat moves", () => {
    const { effects, state } = drive([tick(1, 500), tick(2, 1000), tick(3, 6000), tick(4, 12000)]);

    expect(effects).toEqual([]);
    expect(state.stalled).toBe(false);
  });

  it("does nothing before the stall threshold", () => {
    const { effects } = drive([tick(0, 500), tick(0, 4999)]);

    expect(effects).toEqual([]);
  });

  it("requests one pause when the heartbeat stands still for stallMs", () => {
    const { effects, state } = drive([tick(0, 5000), tick(0, 5500), tick(0, 9000)]);

    expect(effects).toEqual([{ type: "pause" }]);
    expect(state).toMatchObject({ stalled: true, pause: "pending" });
  });

  it("reports a pause that lands as stuck in JavaScript, with the frames, then resumes", () => {
    const { effects } = drive([tick(0, 5000), { type: "paused", now: 5012, frames: [frame("spin"), frame("")] }]);

    expect(effects).toEqual([
      { type: "pause" },
      {
        type: "write",
        level: "ERROR",
        lines: [
          "main thread blocked for 5.0 s in JavaScript",
          "    at spin (file:///bin/plugin.js:10:5)",
          "    at (anonymous) (file:///bin/plugin.js:10:5)",
        ],
      },
      { type: "resume" },
    ]);
  });

  it("caps a deep stack and says how many frames it left out", () => {
    const frames = Array.from({ length: 30 }, (_, i) => frame(`f${i}`));
    const [report] = writes(drive([tick(0, 5000), { type: "paused", now: 5000, frames }]).effects);

    expect(report.lines).toHaveLength(1 + 25 + 1);
    expect(report.lines.at(-1)).toBe("    ... 5 more frames");
  });

  it("reports a pause that does not land as native code, and the frames where it lands later", () => {
    const { effects } = drive([
      tick(0, 5000),
      { type: "pauseTimeout", now: 7000 },
      tick(0, 9000),
      { type: "paused", now: 12000, frames: [frame("callsNative")] },
    ]);

    expect(effects).toEqual([
      { type: "pause" },
      { type: "write", level: "ERROR", lines: ["main thread blocked for 7.0 s in native code"] },
      {
        type: "write",
        level: "ERROR",
        lines: [
          "main thread resumed after 12.0 s; the pause landed at:",
          "    at callsNative (file:///bin/plugin.js:10:5)",
        ],
      },
      { type: "resume" },
    ]);
  });

  it("ignores a pause timeout once the pause has landed", () => {
    const { effects } = drive([
      tick(0, 5000),
      { type: "paused", now: 5010, frames: [] },
      { type: "pauseTimeout", now: 7000 },
    ]);

    expect(writes(effects)).toHaveLength(1);
  });

  it("resumes any pause it did not ask for, and writes nothing", () => {
    const healthy = drive([{ type: "paused", now: 100, frames: [frame("debuggerStatement")] }]);
    const twice = drive([
      tick(0, 5000),
      { type: "paused", now: 5010, frames: [] },
      { type: "paused", now: 6000, frames: [frame("debuggerStatement")] },
    ]);

    expect(healthy.effects).toEqual([{ type: "resume" }]);
    expect(twice.effects.filter((e) => e.type === "resume")).toHaveLength(2);
    expect(writes(twice.effects)).toHaveLength(1);
  });

  it("writes the recovery line, tears the session down and re-arms when the heartbeat moves again", () => {
    const first = drive([tick(0, 5000), { type: "paused", now: 5010, frames: [] }, tick(1, 8250)]);

    expect(first.effects.slice(-2)).toEqual([
      { type: "teardown" },
      { type: "write", level: "WARN", lines: ["main thread responsive again after 8.3 s"] },
    ]);
    expect(first.state).toEqual({ lastBeat: 1, lastChangeAt: 8250, stalled: false, pause: "none" });

    const second = drive([tick(1, 13249), tick(1, 13250)], DIAGNOSE, first.state);

    expect(second.effects).toEqual([{ type: "pause" }]);
  });

  it("re-arms after a native stall whose pause never landed", () => {
    const { effects, state } = drive([tick(0, 5000), { type: "pauseTimeout", now: 7000 }, tick(1, 9000)]);

    expect(effects.at(-1)).toEqual({
      type: "write",
      level: "WARN",
      lines: ["main thread responsive again after 9.0 s"],
    });
    expect(state.pause).toBe("none");
  });

  it("reports without a location, at once and once, when the inspector is unavailable", () => {
    const { effects } = drive([tick(0, 5000), tick(0, 9000), tick(1, 10000)], NO_INSPECTOR);

    expect(effects).toEqual([
      {
        type: "write",
        level: "ERROR",
        lines: ["main thread blocked for 5.0 s (location unknown: the inspector is unavailable)"],
      },
      { type: "teardown" },
      { type: "write", level: "WARN", lines: ["main thread responsive again after 10.0 s"] },
    ]);
  });

  it("reports a failed pause without a location and tears the session down", () => {
    const { effects, state } = drive([tick(0, 5000), { type: "pauseFailed", now: 5001, reason: "Error: busy" }]);

    expect(effects.slice(1)).toEqual([
      { type: "teardown" },
      {
        type: "write",
        level: "ERROR",
        lines: ["main thread blocked for 5.0 s (location unknown: pausing it failed: Error: busy)"],
      },
    ]);
    expect(state.pause).toBe("failed");
  });
});

/** Poll `file` until `predicate` holds for its contents, or fail after `timeoutMs`. */
async function waitForLog(file: string, predicate: (text: string) => boolean, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const text = existsSync(file) ? readFileSync(file, "utf-8") : "";

    if (predicate(text)) return text;

    if (Date.now() > deadline) throw new Error(`timed out waiting for the log; it holds:\n${text}`);

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("the worker source", () => {
  let dir: string;
  let worker: Worker | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ird-watchdog-"));
  });

  afterEach(async () => {
    await worker?.terminate();
    worker = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  // `diagnose: false`, so the worker never pauses this (the test's own) thread:
  // what is under test is that the stringified source runs at all.
  it("runs in a real Worker: a daily-file stall report, then recovery", async () => {
    const heartbeat = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    worker = new Worker(createWatchdogWorkerSource(), {
      eval: true,
      workerData: {
        heartbeat,
        target: { kind: "daily", dir: join(dir, "log") },
        heartbeatMs: 20,
        pauseTimeoutMs: 100,
        config: { stallMs: 200, diagnose: false },
      },
    });
    const errors: unknown[] = [];
    worker.on("error", (err) => errors.push(err));

    const now = new Date();
    const file = join(dir, "log", `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}.log`);

    const stalled = await waitForLog(file, (text) => text.includes("blocked"));

    expect(stalled).toMatch(
      /^\d{4}-\d\d-\d\dT[\d:.]+Z ERROR MainThreadWatchdog: main thread blocked for \d+\.\d s \(location unknown: the inspector is unavailable\)\n$/,
    );

    Atomics.add(new Int32Array(heartbeat), 0, 1);
    const recovered = await waitForLog(file, (text) => text.includes("responsive again"));

    expect(recovered.split("\n")[1]).toMatch(
      / WARN {2}MainThreadWatchdog: main thread responsive again after \d+\.\d s$/,
    );
    expect(errors).toEqual([]);
  });
});

/**
 * The real watchdog in a child Node process whose main thread then blocks. A
 * child, because blocking this process's own main thread would block the test.
 * The child imports the TypeScript source directly (Node's built-in type
 * stripping), which works because the module imports nothing but Node built-ins
 * and erasable types.
 */
function runBlockingChild(logFile: string, mode: "js" | "native"): Promise<void> {
  const moduleUrl = pathToFileURL(join(HERE, "main-thread-watchdog.ts")).href;
  const script = `
    import { execFileSync } from "node:child_process";
    import { startMainThreadWatchdog } from ${JSON.stringify(moduleUrl)};

    const quiet = () => {};
    const logger = { trace: quiet, debug: quiet, info: quiet, warn: quiet, error: quiet };
    logger.withLevel = () => logger;
    logger.createScope = () => logger;

    startMainThreadWatchdog({
      logger,
      target: { kind: "file", path: ${JSON.stringify(logFile)} },
      heartbeatMs: 100,
      stallMs: 1000,
      pauseTimeoutMs: 500,
    });

    function spinInJavaScriptForTheWatchdog(ms) {
      const end = Date.now() + ms;
      let n = 0;
      while (Date.now() < end) n++;
      return n;
    }

    function blockInNativeCodeForTheWatchdog(ms) {
      execFileSync(process.execPath, ["-e", "setTimeout(() => {}, " + ms + ")"]);
    }

    setTimeout(() => {
      if (${JSON.stringify(mode)} === "js") spinInJavaScriptForTheWatchdog(3000);
      else blockInNativeCodeForTheWatchdog(3000);
      setTimeout(() => process.exit(0), 800);
    }, 300);
  `;

  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--no-warnings", "--input-type=module", "-e", script],
      { timeout: 20000 },
      (err, _stdout, stderr) => (err ? reject(new Error(`${String(err)}\n${stderr}`)) : resolve()),
    );
  });
}

describe("startMainThreadWatchdog in a blocked process", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ird-watchdog-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the spinning function when the thread is stuck in JavaScript, then logs recovery", async () => {
    const logFile = join(dir, "logs", "com.example.plugin.0.log");
    await runBlockingChild(logFile, "js");
    const lines = readFileSync(logFile, "utf-8").trimEnd().split("\n");

    expect(lines[0]).toMatch(/ ERROR MainThreadWatchdog: main thread blocked for \d+\.\d s in JavaScript$/);
    expect(lines[1]).toMatch(/MainThreadWatchdog: {5}at spinInJavaScriptForTheWatchdog \(.+:\d+:\d+\)$/);
    expect(lines.at(-1)).toMatch(/ WARN {2}MainThreadWatchdog: main thread responsive again after \d+\.\d s$/);
    expect(lines.filter((l) => l.includes("blocked for"))).toHaveLength(1);
  }, 30000);

  it("reports native code, then where the pause landed once the call returned, then recovery", async () => {
    const logFile = join(dir, "logs", "com.example.plugin.0.log");
    await runBlockingChild(logFile, "native");
    const text = readFileSync(logFile, "utf-8");
    const lines = text.trimEnd().split("\n");

    expect(lines[0]).toMatch(/ ERROR MainThreadWatchdog: main thread blocked for \d+\.\d s in native code$/);
    expect(lines[1]).toMatch(/ ERROR MainThreadWatchdog: main thread resumed after \d+\.\d s; the pause landed at:$/);
    expect(text).toMatch(/MainThreadWatchdog: {5}at blockInNativeCodeForTheWatchdog \(/);
    expect(lines.at(-1)).toMatch(/ WARN {2}MainThreadWatchdog: main thread responsive again after \d+\.\d s$/);
  }, 30000);
});
