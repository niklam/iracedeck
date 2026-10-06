import type { ILogger } from "@iracedeck/logger";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createWatchdogWorkerSource,
  initialWatchdogState,
  superviseWatchdogWorker,
  WATCHDOG_DEFAULTS,
  type WatchdogConfig,
  watchdogDailyLogFileName,
  type WatchdogEffect,
  type WatchdogEvent,
  type WatchdogFrame,
  type WatchdogState,
  watchdogStep,
} from "./main-thread-watchdog.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

const DIAGNOSE: WatchdogConfig = { heartbeatMs: 500, stallMs: 5000, jsPauseLatencyMs: 250, diagnose: true };
const NO_INSPECTOR: WatchdogConfig = { ...DIAGNOSE, diagnose: false };

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

/** The worker's regular samples, every 500 ms after `from` up to and including `to`, all reading `beat`. */
function ticks(beat: number, from: number, to: number): WatchdogEvent[] {
  const events: WatchdogEvent[] = [];

  for (let now = from + 500; now <= to; now += 500) events.push(tick(beat, now));

  return events;
}

const paused = (now: number, frames: WatchdogFrame[] = []): WatchdogEvent => ({ type: "paused", now, frames });

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
    expect(WATCHDOG_DEFAULTS).toEqual({ heartbeatMs: 500, stallMs: 5000, pauseTimeoutMs: 2000, jsPauseLatencyMs: 250 });
  });
});

describe("watchdogStep", () => {
  it("does nothing while the heartbeat moves", () => {
    const events = Array.from({ length: 30 }, (_, i) => tick(i + 1, (i + 1) * 500));
    const { effects, state } = drive(events);

    expect(effects).toEqual([]);
    expect(state.stalled).toBe(false);
  });

  it("does nothing before the stall threshold", () => {
    expect(drive(ticks(0, 0, 4500)).effects).toEqual([]);
  });

  it("requests one pause when the heartbeat stands still for stallMs at the normal sampling rate", () => {
    const { effects, state } = drive(ticks(0, 0, 9000));

    expect(effects).toEqual([{ type: "pause", id: 1 }]);
    expect(state).toMatchObject({ stalled: true, pause: "pending", pausePostedAt: 5000 });
  });

  it("treats a long gap between its own samples as a suspended process, not a stall", () => {
    const resumed = drive([...ticks(0, 0, 1000), tick(0, 60000), ...ticks(0, 60000, 64500)]);

    expect(resumed.effects).toEqual([]);
    expect(resumed.state.lastChangeAt).toBe(60000);

    // ... and the stall clock runs again from the wake-up.
    expect(drive(ticks(0, 64500, 65000), DIAGNOSE, resumed.state).effects).toEqual([{ type: "pause", id: 1 }]);
  });

  it("does not restart the clock of a stall already reported when a long gap follows", () => {
    const { effects, state } = drive([...ticks(0, 0, 5000), tick(0, 60000)], NO_INSPECTOR);

    expect(writes(effects)).toHaveLength(1);
    expect(state).toMatchObject({ stalled: true, lastChangeAt: 0 });
  });

  it("reports a pause that lands at once as stuck in JavaScript, with the frames, then resumes", () => {
    const { effects } = drive([...ticks(0, 0, 5000), paused(5012, [frame("spin"), frame("")])]);

    expect(effects).toEqual([
      { type: "pause", id: 1 },
      { type: "cancelPauseTimeout" },
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

  it("counts a pause landing exactly at the latency threshold as JavaScript", () => {
    const [report] = writes(drive([...ticks(0, 0, 5000), paused(5250)]).effects);

    expect(report.lines[0]).toBe("main thread blocked for 5.3 s in JavaScript");
  });

  it("reports a pause that lands late, inside the timeout, as native code with where the thread resumed", () => {
    const { effects } = drive([...ticks(0, 0, 5000), paused(5800, [frame("callsNative")])]);

    expect(effects).toEqual([
      { type: "pause", id: 1 },
      { type: "cancelPauseTimeout" },
      {
        type: "write",
        level: "ERROR",
        lines: [
          "main thread blocked for 5.0 s in native code",
          "main thread resumed after 5.8 s; the pause landed at:",
          "    at callsNative (file:///bin/plugin.js:10:5)",
        ],
      },
      { type: "resume" },
    ]);
  });

  it("caps a deep stack and says how many frames it left out", () => {
    const frames = Array.from({ length: 30 }, (_, i) => frame(`f${i}`));
    const [report] = writes(drive([...ticks(0, 0, 5000), paused(5000, frames)]).effects);

    expect(report.lines).toHaveLength(1 + 25 + 1);
    expect(report.lines.at(-1)).toBe("    ... 5 more frames");
  });

  it("reports a pause still pending at the timeout as native code, and the frames where it lands later", () => {
    const { effects } = drive([
      ...ticks(0, 0, 5000),
      { type: "pauseTimeout", id: 1, now: 7000 },
      ...ticks(0, 5000, 12000),
      paused(12000, [frame("callsNative")]),
    ]);

    expect(effects).toEqual([
      { type: "pause", id: 1 },
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
    const { effects } = drive([...ticks(0, 0, 5000), paused(5010), { type: "pauseTimeout", id: 1, now: 7000 }]);

    expect(writes(effects)).toHaveLength(1);
  });

  it("ignores a stale timeout from an earlier stall when the pause timeout is at least the stall time", () => {
    // Stall 1 lands in JavaScript and recovers; stall 2 starts while stall 1's
    // timer (pauseTimeoutMs >= stallMs) could still be due.
    const { effects, state } = drive([
      ...ticks(0, 0, 5000),
      paused(5010),
      tick(1, 5500),
      ...ticks(1, 5500, 10500),
      { type: "pauseTimeout", id: 1, now: 10510 },
    ]);

    expect(effects.filter((e) => e.type === "pause")).toEqual([
      { type: "pause", id: 1 },
      { type: "pause", id: 2 },
    ]);
    expect(writes(effects).map((w) => w.lines[0])).toEqual([
      "main thread blocked for 5.0 s in JavaScript",
      "main thread responsive again after 5.5 s",
    ]);
    expect(state).toMatchObject({ pause: "pending", pauseId: 2 });

    const current = drive([{ type: "pauseTimeout", id: 2, now: 12500 }], DIAGNOSE, state);

    expect(current.effects).toEqual([
      { type: "write", level: "ERROR", lines: ["main thread blocked for 7.0 s in native code"] },
    ]);
  });

  it("resumes any pause it did not ask for, and writes nothing", () => {
    const healthy = drive([paused(100, [frame("debuggerStatement")])]);
    const twice = drive([...ticks(0, 0, 5000), paused(5010), paused(6000, [frame("debuggerStatement")])]);

    expect(healthy.effects).toEqual([{ type: "resume" }]);
    expect(twice.effects.filter((e) => e.type === "resume")).toHaveLength(2);
    expect(writes(twice.effects)).toHaveLength(1);
  });

  it("writes the recovery line, tears the session down and re-arms when the heartbeat moves again", () => {
    const first = drive([...ticks(0, 0, 5000), paused(5010), ...ticks(0, 5000, 8000), tick(1, 8500)]);

    expect(first.effects.slice(-2)).toEqual([
      { type: "teardown" },
      { type: "write", level: "WARN", lines: ["main thread responsive again after 8.5 s"] },
    ]);
    expect(first.state).toMatchObject({ lastBeat: 1, lastChangeAt: 8500, stalled: false, pause: "none" });

    expect(drive(ticks(1, 8500, 13000), DIAGNOSE, first.state).effects).toEqual([]);
    expect(drive(ticks(1, 8500, 13500), DIAGNOSE, first.state).effects).toEqual([{ type: "pause", id: 2 }]);
  });

  it("re-arms after a native stall whose pause never landed", () => {
    const { effects, state } = drive([
      ...ticks(0, 0, 5000),
      { type: "pauseTimeout", id: 1, now: 7000 },
      ...ticks(0, 5000, 9000),
      tick(1, 9500),
    ]);

    expect(effects.at(-1)).toEqual({
      type: "write",
      level: "WARN",
      lines: ["main thread responsive again after 9.5 s"],
    });
    expect(state.pause).toBe("none");
  });

  it("reports without a location, at once and once, when the inspector is unavailable", () => {
    const { effects } = drive([...ticks(0, 0, 9000), tick(1, 9500)], NO_INSPECTOR);

    expect(effects).toEqual([
      {
        type: "write",
        level: "ERROR",
        lines: ["main thread blocked for 5.0 s (location unknown: the inspector is unavailable)"],
      },
      { type: "teardown" },
      { type: "write", level: "WARN", lines: ["main thread responsive again after 9.5 s"] },
    ]);
  });

  it("reports a failed pause without a location and tears the session down", () => {
    const { effects, state } = drive([
      ...ticks(0, 0, 5000),
      { type: "pauseFailed", now: 5001, reason: "Error: busy" },
    ]);

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

describe("watchdogDailyLogFileName", () => {
  it("is <YYYY.M.D>.log, unpadded, in local time", () => {
    expect(watchdogDailyLogFileName(new Date(2026, 0, 5, 23, 59))).toBe("2026.1.5.log");
    expect(watchdogDailyLogFileName(new Date(2026, 11, 31, 0, 0))).toBe("2026.12.31.log");
  });
});

/** Wait until `dir` holds a `*.log` whose contents satisfy `predicate`, or fail after `timeoutMs`. */
async function waitForLog(dir: string, predicate: (text: string) => boolean, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = "";

  for (;;) {
    let names: string[] = [];

    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".log"));
    } catch {
      // Not created yet.
    }

    text = names.map((name) => readFileSync(join(dir, name), "utf-8")).join("");

    if (predicate(text)) return text;

    if (Date.now() > deadline) throw new Error(`timed out waiting for the log; it holds:\n${text}`);

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function recordingLogger(): ILogger & { warnings: string[] } {
  const warnings: string[] = [];
  const logger = {
    warnings,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((message: string) => warnings.push(message)),
    error: vi.fn(),
    withLevel: () => logger,
    createScope: () => logger,
  };

  return logger;
}

function workerData(dir: string, diagnose: boolean): Record<string, unknown> {
  return {
    heartbeat: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    target: { kind: "daily", dir },
    pauseTimeoutMs: 100,
    config: { heartbeatMs: 20, stallMs: 200, jsPauseLatencyMs: 250, diagnose },
  };
}

describe("the worker source in a real Worker", () => {
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
  it("reports a stall into the daily file, then recovery", async () => {
    const data = workerData(join(dir, "log"), false);
    worker = new Worker(createWatchdogWorkerSource(), { eval: true, workerData: data });
    const errors: unknown[] = [];
    worker.on("error", (err) => errors.push(err));

    const stalled = await waitForLog(join(dir, "log"), (text) => text.includes("blocked"));

    expect(stalled).toMatch(
      /^\d{4}-\d\d-\d\dT[\d:.]+Z ERROR MainThreadWatchdog: main thread blocked for \d+\.\d s \(location unknown: the inspector is unavailable\)\n$/,
    );

    Atomics.add(new Int32Array(data.heartbeat as SharedArrayBuffer), 0, 1);
    const recovered = await waitForLog(join(dir, "log"), (text) => text.includes("responsive again"));

    expect(recovered.split("\n")[1]).toMatch(
      / WARN {2}MainThreadWatchdog: main thread responsive again after \d+\.\d s$/,
    );
    expect(errors).toEqual([]);
  });

  it("tells the main thread once when the inspector cannot diagnose, and still reports the stall", async () => {
    // Remove the method from this worker's own copy of node:inspector, which is
    // what a Node without `connectToMainThread` looks like to the worker.
    const sabotage =
      'delete (typeof require === "function" ? require : process.getBuiltinModule)("node:inspector").Session.prototype.connectToMainThread;\n';
    worker = new Worker(sabotage + createWatchdogWorkerSource(), { eval: true, workerData: workerData(dir, true) });
    const logger = recordingLogger();
    superviseWatchdogWorker(worker, logger, () => {});

    await waitForLog(dir, (text) => text.includes("location unknown: the inspector is unavailable"));

    expect(logger.warnings).toEqual([
      "Main-thread watchdog cannot tell where a stall is stuck, only that it happened: this Node's inspector has no Session.connectToMainThread",
    ]);
  });
});

describe("superviseWatchdogWorker", () => {
  it("logs one WARN and stops the heartbeat when the worker errors, whatever follows", () => {
    const worker = new EventEmitter();
    const logger = recordingLogger();
    const onStopped = vi.fn();
    superviseWatchdogWorker(worker, logger, onStopped);

    worker.emit("error", new Error("boom"));
    worker.emit("exit", 1);

    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(logger.warnings).toEqual(["Main-thread watchdog stopped: Error: boom"]);
  });

  it("logs the exit code when the worker exits", () => {
    const worker = new EventEmitter();
    const logger = recordingLogger();
    const onStopped = vi.fn();
    superviseWatchdogWorker(worker, logger, onStopped);

    worker.emit("exit", 0);

    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(logger.warnings).toEqual(["Main-thread watchdog stopped: the worker exited with code 0"]);
  });

  it("stays silent about an exit it was told to expect", () => {
    const worker = new EventEmitter();
    const logger = recordingLogger();
    const onStopped = vi.fn();
    superviseWatchdogWorker(worker, logger, onStopped).expectExit();

    worker.emit("exit", 1);

    expect(onStopped).not.toHaveBeenCalled();
    expect(logger.warnings).toEqual([]);
  });

  it("ignores any other message", () => {
    const worker = new EventEmitter();
    const logger = recordingLogger();
    superviseWatchdogWorker(worker, logger, () => {});

    worker.emit("message", { type: "somethingElse" });
    worker.emit("message", null);

    expect(logger.warnings).toEqual([]);
  });

  it("reports a real worker that dies", async () => {
    const worker = new Worker("process.exit(3)", { eval: true });
    const logger = recordingLogger();
    const stopped = new Promise<void>((resolve) => superviseWatchdogWorker(worker, logger, resolve));

    await stopped;

    expect(logger.warnings).toEqual(["Main-thread watchdog stopped: the worker exited with code 3"]);
  });
});

interface ChildRun {
  /** The module that exports `startMainThreadWatchdog`. */
  moduleUrl: string;
  logFile: string;
  mode: "js" | "native";
  blockMs: number;
  pauseTimeoutMs: number;
}

const SOURCE_URL = pathToFileURL(join(HERE, "main-thread-watchdog.ts")).href;

/**
 * The real watchdog in a child Node process whose main thread then blocks. A
 * child, because blocking this process's own main thread would block the test.
 * The child imports the TypeScript source directly (Node's built-in type
 * stripping), which works because the module imports nothing but Node built-ins
 * and erasable types — or, for the minification test, the minified module.
 */
function runBlockingChild(run: ChildRun): Promise<void> {
  const script = `
    import { execFileSync } from "node:child_process";
    import { startMainThreadWatchdog } from ${JSON.stringify(run.moduleUrl)};

    const quiet = () => {};
    const logger = { trace: quiet, debug: quiet, info: quiet, warn: quiet, error: quiet };
    logger.withLevel = () => logger;
    logger.createScope = () => logger;

    startMainThreadWatchdog({
      logger,
      target: { kind: "file", path: ${JSON.stringify(run.logFile)} },
      heartbeatMs: 100,
      stallMs: 1000,
      pauseTimeoutMs: ${run.pauseTimeoutMs},
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
      if (${JSON.stringify(run.mode)} === "js") spinInJavaScriptForTheWatchdog(${run.blockMs});
      else blockInNativeCodeForTheWatchdog(${run.blockMs});
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
  let logFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ird-watchdog-"));
    logFile = join(dir, "logs", "com.example.plugin.0.log");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const readLines = (): string[] => readFileSync(logFile, "utf-8").trimEnd().split("\n");

  it("names the spinning function when the thread is stuck in JavaScript, then logs recovery", async () => {
    await runBlockingChild({ moduleUrl: SOURCE_URL, logFile, mode: "js", blockMs: 3000, pauseTimeoutMs: 500 });
    const lines = readLines();

    expect(lines[0]).toMatch(/ ERROR MainThreadWatchdog: main thread blocked for \d+\.\d s in JavaScript$/);
    expect(lines[1]).toMatch(/MainThreadWatchdog: {5}at spinInJavaScriptForTheWatchdog \(.+:\d+:\d+\)$/);
    expect(lines.at(-1)).toMatch(/ WARN {2}MainThreadWatchdog: main thread responsive again after \d+\.\d s$/);
    expect(lines.filter((l) => l.includes("blocked for"))).toHaveLength(1);
  }, 30000);

  it("reports native code at the timeout, then where the pause landed once the call returned, then recovery", async () => {
    await runBlockingChild({ moduleUrl: SOURCE_URL, logFile, mode: "native", blockMs: 3000, pauseTimeoutMs: 500 });
    const lines = readLines();

    expect(lines[0]).toMatch(/ ERROR MainThreadWatchdog: main thread blocked for \d+\.\d s in native code$/);
    expect(lines[1]).toMatch(/ ERROR MainThreadWatchdog: main thread resumed after \d+\.\d s; the pause landed at:$/);
    expect(lines.join("\n")).toMatch(/MainThreadWatchdog: {5}at blockInNativeCodeForTheWatchdog \(/);
    expect(lines.at(-1)).toMatch(/ WARN {2}MainThreadWatchdog: main thread responsive again after \d+\.\d s$/);
  }, 30000);

  it("reports a native block that ends inside the pause window as native, not JavaScript", async () => {
    // 1.5x the stall threshold: the pause is requested at ~1 s and lands when
    // the call returns at ~1.5 s, well inside the 2 s window.
    await runBlockingChild({ moduleUrl: SOURCE_URL, logFile, mode: "native", blockMs: 1500, pauseTimeoutMs: 2000 });
    const lines = readLines();

    expect(lines[0]).toMatch(/ ERROR MainThreadWatchdog: main thread blocked for \d+\.\d s in native code$/);
    expect(lines[1]).toMatch(/ ERROR MainThreadWatchdog: main thread resumed after \d+\.\d s; the pause landed at:$/);
    expect(lines.join("\n")).toMatch(/MainThreadWatchdog: {5}at blockInNativeCodeForTheWatchdog \(/);
    expect(lines.join("\n")).not.toContain("in JavaScript");
    expect(lines.at(-1)).toMatch(/ WARN {2}MainThreadWatchdog: main thread responsive again after \d+\.\d s$/);
  }, 30000);

  it("still works after the module is compiled and minified the way the plugins ship it", async () => {
    // The plugins' own terser, resolved through @rollup/plugin-terser from
    // @iracedeck/plugin-build — the package that declares it, whose shared Rollup
    // config minifies all three plugins — with the options it applies to an ES bundle.
    const pluginBuildRequire = createRequire(join(REPO, "packages", "plugin-build", "package.json"));
    const terserRequire = createRequire(pluginBuildRequire.resolve("@rollup/plugin-terser"));
    // terser is not a dependency of this package, so its types are not in reach: declare the one call used.
    const { minify } = terserRequire("terser") as {
      minify(code: string, options: Record<string, unknown>): Promise<{ code?: string }>;
    };
    const ts = createRequire(join(REPO, "packages", "deck-core", "package.json"))(
      "typescript",
    ) as typeof import("typescript");

    const compiled = ts.transpileModule(readFileSync(join(HERE, "main-thread-watchdog.ts"), "utf-8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    // Inside a plugin bundle only the entry's own bindings survive, so every
    // export but the one the fixture calls is made local — free to be renamed
    // and inlined, as it is in the shipped bundle.
    const bundled = compiled.replace(/^export (function|const) (?!startMainThreadWatchdog\b)/gm, "$1 ");

    expect(bundled).toMatch(/^function watchdogStep\(/m);

    const minified = await minify(bundled, { module: true, toplevel: true, compress: { passes: 3 } });
    const minifiedFile = join(dir, "watchdog.min.mjs");
    writeFileSync(minifiedFile, minified.code!);

    // The helpers really were renamed, so the source only works if it passes them by value.
    expect(minified.code).not.toContain("watchdogStep");
    expect(minified.code).not.toContain("watchdogDailyLogFileName");

    await runBlockingChild({
      moduleUrl: pathToFileURL(minifiedFile).href,
      logFile,
      mode: "js",
      blockMs: 2500,
      pauseTimeoutMs: 500,
    });
    const lines = readLines();

    expect(lines[0]).toMatch(/ ERROR MainThreadWatchdog: main thread blocked for \d+\.\d s in JavaScript$/);
    expect(lines[1]).toMatch(/MainThreadWatchdog: {5}at spinInJavaScriptForTheWatchdog \(/);
    expect(lines.at(-1)).toMatch(/ WARN {2}MainThreadWatchdog: main thread responsive again after \d+\.\d s$/);
  }, 30000);
});
