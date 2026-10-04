/**
 * Main-thread watchdog (#1330).
 *
 * The plugin's main thread has frozen in the field and left no trace, because
 * everything that logs runs on that same thread. This module starts a worker
 * thread that watches a heartbeat the main thread bumps in a
 * `SharedArrayBuffer`. When the heartbeat stops, the worker pauses the main
 * thread through Node's in-process inspector (`Session.connectToMainThread()`)
 * to read where it is stuck, and appends the report straight to the host's log
 * file with `fs.appendFileSync` — a worker's `console` is relayed through the
 * main thread, so it would only appear once the freeze is over.
 *
 * Decision record: `docs/superpowers/specs/2026-10-04-issue-1330-main-thread-watchdog.md`.
 *
 * ## How the worker stays self-contained and its logic stays tested
 *
 * The worker is started from source (`new Worker(src, { eval: true })`) so no
 * plugin needs a second Rollup entry. Its source is assembled from three plain
 * functions in this file, each stringified with `Function.prototype.toString()`
 * and passed as an argument expression: `watchdogWorkerMain(watchdogStep,
 * initialWatchdogState)`. The decision logic lives in `watchdogStep`, a pure
 * reducer the unit tests drive directly; `watchdogWorkerMain` is only the thin
 * interpreter of its effects (timers, the inspector session, the file append).
 * Passing the functions as argument expressions rather than by name keeps the
 * source valid after minification renames them. All three must therefore use
 * nothing from module scope — no imports, no constants, no helpers — only their
 * own parameters, locals and globals (`require` is available in an eval
 * worker, which runs as CommonJS). The guard test in
 * `main-thread-watchdog.test.ts` runs the assembled source in a real `Worker`.
 */
import type { ILogger } from "@iracedeck/logger";
import { Worker } from "node:worker_threads";

/** Where the worker appends its report: the same file the host's own logger writes. */
export type WatchdogLogTarget =
  /** One fixed file (Elgato: `<cwd>/logs/<plugin UUID>.0.log`). */
  | { kind: "file"; path: string }
  /** A directory whose file is `<YYYY.M.D>.log`, computed per write (Mirabox, Ulanzi `FileSink`). */
  | { kind: "daily"; dir: string };

export interface MainThreadWatchdogOptions {
  /** Main-thread logger, used only for the start-up lines. The reports never go through it. */
  logger: ILogger;
  target: WatchdogLogTarget;
  /** Heartbeat and sampling interval. */
  heartbeatMs?: number;
  /** How long the heartbeat must stand still before it is a stall. */
  stallMs?: number;
  /** How long a pause may take to land before the stall is called native. */
  pauseTimeoutMs?: number;
}

export interface MainThreadWatchdog {
  /** Stop the heartbeat and terminate the worker. */
  stop(): Promise<void>;
}

/** The spec's values (#1330). */
export const WATCHDOG_DEFAULTS = { heartbeatMs: 500, stallMs: 5000, pauseTimeoutMs: 2000 } as const;

/** One call frame as the inspector's `Debugger.paused` reports it (0-based line and column). */
export interface WatchdogFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export type WatchdogEvent =
  /** A sample of the heartbeat counter. */
  | { type: "tick"; beat: number; now: number }
  /** The inspector reported the main thread paused. */
  | { type: "paused"; now: number; frames: WatchdogFrame[] }
  /** The pause did not land within `pauseTimeoutMs`. */
  | { type: "pauseTimeout"; now: number }
  /** Opening the session or posting the pause threw. */
  | { type: "pauseFailed"; now: number; reason: string };

export type WatchdogEffect =
  | { type: "write"; level: "ERROR" | "WARN"; lines: string[] }
  /** Open the session, enable the debugger, request a pause and arm the pause timeout. */
  | { type: "pause" }
  | { type: "resume" }
  /** Clear the pause timeout, disable the debugger and disconnect the session. */
  | { type: "teardown" };

export interface WatchdogState {
  lastBeat: number;
  /** When the heartbeat last moved, as the worker saw it. */
  lastChangeAt: number;
  stalled: boolean;
  /** Where the diagnosis of the current stall stands. */
  pause: "none" | "pending" | "timedOut" | "landed" | "failed";
}

export interface WatchdogConfig {
  stallMs: number;
  /** False when the inspector is unavailable: stalls are reported without a location. */
  diagnose: boolean;
}

/**
 * The state before the first sample. Self-contained: it is stringified into the worker.
 *
 * @internal Exported for testing
 */
export function initialWatchdogState(beat: number, now: number): WatchdogState {
  return { lastBeat: beat, lastChangeAt: now, stalled: false, pause: "none" };
}

/**
 * The watchdog's decision logic: one event in, the next state and the effects
 * to run out. Pure, and self-contained because it is stringified into the
 * worker — every helper it needs is declared inside it.
 *
 * - The heartbeat moving after a stall writes the recovery line and tears the
 *   session down; moving otherwise only re-arms.
 * - Standing still for `stallMs` starts ONE diagnosis per stall: a pause, or,
 *   without the inspector, an undiagnosed report straight away.
 * - A pause that lands first reports "in JavaScript"; a timeout first reports
 *   "in native code", and a pause landing after that reports where the thread
 *   resumed. Every pause is answered with a resume, whatever the state — the
 *   main thread must never be left paused by the watchdog.
 *
 * @internal Exported for testing
 */
export function watchdogStep(
  state: WatchdogState,
  event: WatchdogEvent,
  config: WatchdogConfig,
): { state: WatchdogState; effects: WatchdogEffect[] } {
  const MAX_FRAMES = 25;
  const seconds = (ms: number): string => (Math.max(0, ms) / 1000).toFixed(1);
  const frameLines = (frames: WatchdogFrame[]): string[] => {
    const lines = frames
      .slice(0, MAX_FRAMES)
      .map(
        (f) =>
          `    at ${f.functionName || "(anonymous)"} (${f.url || "<unknown>"}:${f.lineNumber + 1}:${f.columnNumber + 1})`,
      );

    if (frames.length > MAX_FRAMES) lines.push(`    ... ${frames.length - MAX_FRAMES} more frames`);

    return lines;
  };

  if (event.type === "tick") {
    if (event.beat !== state.lastBeat) {
      const next: WatchdogState = { lastBeat: event.beat, lastChangeAt: event.now, stalled: false, pause: "none" };

      if (!state.stalled) return { state: next, effects: [] };

      return {
        state: next,
        effects: [
          { type: "teardown" },
          {
            type: "write",
            level: "WARN",
            lines: [`main thread responsive again after ${seconds(event.now - state.lastChangeAt)} s`],
          },
        ],
      };
    }

    if (state.stalled || event.now - state.lastChangeAt < config.stallMs) return { state, effects: [] };

    if (!config.diagnose) {
      return {
        state: { ...state, stalled: true },
        effects: [
          {
            type: "write",
            level: "ERROR",
            lines: [
              `main thread blocked for ${seconds(event.now - state.lastChangeAt)} s (location unknown: the inspector is unavailable)`,
            ],
          },
        ],
      };
    }

    return { state: { ...state, stalled: true, pause: "pending" }, effects: [{ type: "pause" }] };
  }

  const blockedFor = seconds(event.now - state.lastChangeAt);

  if (event.type === "paused") {
    if (state.pause === "pending") {
      return {
        state: { ...state, pause: "landed" },
        effects: [
          {
            type: "write",
            level: "ERROR",
            lines: [`main thread blocked for ${blockedFor} s in JavaScript`, ...frameLines(event.frames)],
          },
          { type: "resume" },
        ],
      };
    }

    if (state.pause === "timedOut") {
      return {
        state: { ...state, pause: "landed" },
        effects: [
          {
            type: "write",
            level: "ERROR",
            lines: [`main thread resumed after ${blockedFor} s; the pause landed at:`, ...frameLines(event.frames)],
          },
          { type: "resume" },
        ],
      };
    }

    return { state, effects: [{ type: "resume" }] };
  }

  if (event.type === "pauseTimeout") {
    if (state.pause !== "pending") return { state, effects: [] };

    return {
      state: { ...state, pause: "timedOut" },
      effects: [{ type: "write", level: "ERROR", lines: [`main thread blocked for ${blockedFor} s in native code`] }],
    };
  }

  if (state.pause !== "pending") return { state, effects: [] };

  return {
    state: { ...state, pause: "failed" },
    effects: [
      { type: "teardown" },
      {
        type: "write",
        level: "ERROR",
        lines: [`main thread blocked for ${blockedFor} s (location unknown: pausing it failed: ${event.reason})`],
      },
    ],
  };
}

/** What the main thread hands the worker. Serialisable, apart from the shared heartbeat. */
interface WatchdogWorkerData {
  heartbeat: SharedArrayBuffer;
  target: WatchdogLogTarget;
  heartbeatMs: number;
  pauseTimeoutMs: number;
  config: WatchdogConfig;
}

/**
 * The worker's body: the interpreter of `watchdogStep`'s effects. Runs in an
 * eval worker, so it must stay self-contained (see the file header).
 */
function watchdogWorkerMain(step: typeof watchdogStep, initialState: typeof initialWatchdogState): void {
  // An eval worker runs as CommonJS, unless the process was started with
  // `--input-type=module`, which the worker inherits and which leaves no
  // `require`. `process.getBuiltinModule` covers that case on Node >= 20.16.
  const load = (id: string): unknown =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- this source cannot `import`
    typeof require === "function" ? require(id) : process.getBuiltinModule(id);
  const { workerData } = load("node:worker_threads") as typeof import("node:worker_threads");
  const fs = load("node:fs") as typeof import("node:fs");
  const path = load("node:path") as typeof import("node:path");
  const data = workerData as WatchdogWorkerData;
  const beats = new Int32Array(data.heartbeat);
  const config: WatchdogConfig = { stallMs: data.config.stallMs, diagnose: data.config.diagnose };

  let inspector: typeof import("node:inspector") | undefined;

  if (config.diagnose) {
    try {
      inspector = load("node:inspector") as typeof import("node:inspector");

      if (typeof inspector.Session?.prototype?.connectToMainThread !== "function") inspector = undefined;
    } catch {
      inspector = undefined;
    }

    if (!inspector) config.diagnose = false;
  }

  let state = initialState(Atomics.load(beats, 0), Date.now());
  let session: import("node:inspector").Session | undefined;
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;
  // A paused call frame names its script by id only (its own `url` is
  // deprecated and empty), so the urls come from `Debugger.scriptParsed`,
  // which `Debugger.enable` replays for every loaded script.
  let scriptUrls = new Map<string, string>();

  const logFile = (now: Date): string =>
    data.target.kind === "file"
      ? data.target.path
      : path.join(data.target.dir, `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}.log`);

  const write = (level: string, lines: string[]): void => {
    try {
      const now = new Date();
      const file = logFile(now);
      const prefix = `${now.toISOString()} ${level.padEnd(5)} MainThreadWatchdog: `;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, lines.map((line) => `${prefix}${line}\n`).join(""));
    } catch {
      // Nowhere left to report it: the main-thread logger may be the thing that is stuck.
    }
  };

  const teardown = (): void => {
    if (pauseTimer !== undefined) clearTimeout(pauseTimer);

    pauseTimer = undefined;

    if (!session) return;

    const closing = session;
    session = undefined;
    scriptUrls = new Map();

    try {
      closing.post("Debugger.disable");
    } catch {
      // The session may already be gone; disconnecting is what matters.
    }

    try {
      closing.disconnect();
    } catch {
      // Already disconnected.
    }
  };

  const dispatch = (event: WatchdogEvent): void => {
    const result = step(state, event, config);
    state = result.state;

    for (const effect of result.effects) run(effect);
  };

  const run = (effect: WatchdogEffect): void => {
    switch (effect.type) {
      case "write":
        write(effect.level, effect.lines);
        break;
      case "resume":
        try {
          session?.post("Debugger.resume");
        } catch {
          // Nothing more the worker can do.
        }

        break;
      case "teardown":
        teardown();
        break;
      case "pause":
        try {
          const opened = new inspector!.Session();
          opened.connectToMainThread();
          session = opened;
          opened.on("Debugger.scriptParsed", (message) => {
            scriptUrls.set(message.params.scriptId, message.params.url);
          });
          opened.on("Debugger.paused", (message) => {
            const frames = message.params.callFrames.map((f) => ({
              functionName: f.functionName,
              url: f.url || scriptUrls.get(f.location.scriptId) || "",
              lineNumber: f.location.lineNumber,
              columnNumber: f.location.columnNumber ?? 0,
            }));
            dispatch({ type: "paused", now: Date.now(), frames });
          });
          opened.post("Debugger.enable");
          opened.post("Debugger.pause");
          pauseTimer = setTimeout(() => {
            pauseTimer = undefined;
            dispatch({ type: "pauseTimeout", now: Date.now() });
          }, data.pauseTimeoutMs);
        } catch (err) {
          dispatch({ type: "pauseFailed", now: Date.now(), reason: String(err) });
        }

        break;
    }
  };

  setInterval(() => dispatch({ type: "tick", beat: Atomics.load(beats, 0), now: Date.now() }), data.heartbeatMs);
}

/**
 * The worker's full source, assembled from the self-contained functions above.
 *
 * @internal Exported for testing
 */
export function createWatchdogWorkerSource(): string {
  return `(${watchdogWorkerMain.toString()})(${watchdogStep.toString()}, ${initialWatchdogState.toString()});\n`;
}

/**
 * Start the watchdog for the rest of the run. Call once, after logging is up.
 *
 * Both the heartbeat timer and the worker are `unref`'d, so the watchdog never
 * keeps the plugin alive. A healthy run writes nothing beyond the start line;
 * reports are ERROR/WARN and are not gated on `debugLogging`.
 */
export function startMainThreadWatchdog(options: MainThreadWatchdogOptions): MainThreadWatchdog {
  const { logger, target } = options;
  const heartbeatMs = options.heartbeatMs ?? WATCHDOG_DEFAULTS.heartbeatMs;
  const stallMs = options.stallMs ?? WATCHDOG_DEFAULTS.stallMs;
  const pauseTimeoutMs = options.pauseTimeoutMs ?? WATCHDOG_DEFAULTS.pauseTimeoutMs;
  const diagnose = process.features.inspector === true;

  if (!diagnose) {
    logger.warn("Main-thread watchdog runs without the inspector: a stall is reported without where it was stuck");
  }

  const heartbeat = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const beats = new Int32Array(heartbeat);
  const workerData: WatchdogWorkerData = {
    heartbeat,
    target,
    heartbeatMs,
    pauseTimeoutMs,
    config: { stallMs, diagnose },
  };

  let worker: Worker;

  try {
    worker = new Worker(createWatchdogWorkerSource(), { eval: true, workerData, name: "MainThreadWatchdog" });
  } catch (err) {
    logger.warn(`Main-thread watchdog could not start: ${String(err)}`);

    return { stop: async () => {} };
  }

  worker.unref();
  worker.on("error", (err) => logger.error(`Main-thread watchdog stopped: ${String(err)}`));

  const timer = setInterval(() => Atomics.add(beats, 0, 1), heartbeatMs);
  timer.unref();

  logger.info("Main-thread watchdog started");
  logger.debug(`Main-thread watchdog: heartbeat ${heartbeatMs} ms, stall after ${stallMs} ms, target ${target.kind}`);

  return {
    stop: async () => {
      clearInterval(timer);
      await worker.terminate();
    },
  };
}
