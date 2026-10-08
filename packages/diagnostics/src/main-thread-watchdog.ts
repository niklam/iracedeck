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
 * plugin needs a second Rollup entry. Its source is assembled from four plain
 * functions in this file, each stringified with `Function.prototype.toString()`
 * and passed as an argument expression: `watchdogWorkerMain(watchdogStep,
 * initialWatchdogState, watchdogDailyLogFileName)`. The decision logic lives
 * in `watchdogStep`, a pure reducer the unit tests drive directly;
 * `watchdogWorkerMain` is only the thin interpreter of its effects (timers,
 * the inspector session, the file append). Passing the functions as argument
 * expressions rather than by name keeps the source valid after minification
 * renames them. All four must therefore use nothing from module scope — no
 * imports, no constants, no helpers — only their own parameters, locals and
 * globals. The tests run the assembled source in a real `Worker`, and the
 * terser-minified module through a real stall.
 */
import type { LogLocation } from "@iracedeck/app-constants";
import type { ILogger } from "@iracedeck/logger";
import type { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";

/** Where the worker appends its report: the same file the host's own logger writes, so the adapter contract's {@link LogLocation}. */
export type WatchdogLogTarget = LogLocation;

export interface MainThreadWatchdogOptions {
  /** Main-thread logger, for the start-up and worker-health lines. The reports never go through it. */
  logger: ILogger;
  target: WatchdogLogTarget;
  /** Heartbeat and sampling interval. */
  heartbeatMs?: number;
  /** How long the heartbeat must stand still before it is a stall. */
  stallMs?: number;
  /** How long a pause may stay pending before the stall is reported as native without waiting for it. */
  pauseTimeoutMs?: number;
  /** A pause that lands later than this after it was requested was held up by native code. */
  jsPauseLatencyMs?: number;
}

export interface MainThreadWatchdog {
  /** Stop the heartbeat and terminate the worker. */
  stop(): Promise<void>;
}

/** The spec's values (#1330); the pause latency is 20× the 12 ms the proof of concept measured. */
export const WATCHDOG_DEFAULTS = {
  heartbeatMs: 500,
  stallMs: 5000,
  pauseTimeoutMs: 2000,
  jsPauseLatencyMs: 250,
} as const;

/** One call frame as the inspector's `Debugger.paused` reports it (0-based line and column). */
export interface WatchdogFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

/** Every `now` is a monotonic clock reading (`performance.now()`), never wall time. */
export type WatchdogEvent =
  /** A sample of the heartbeat counter. */
  | { type: "tick"; beat: number; now: number }
  /** The inspector reported the main thread paused. */
  | { type: "paused"; now: number; frames: WatchdogFrame[] }
  /** Pause `id` did not land within `pauseTimeoutMs`. */
  | { type: "pauseTimeout"; id: number; now: number }
  /** Opening the session or posting the pause threw. */
  | { type: "pauseFailed"; now: number; reason: string };

export type WatchdogEffect =
  | { type: "write"; level: "ERROR" | "WARN"; lines: string[] }
  /** Open the session, enable the debugger, request a pause and arm pause `id`'s timeout. */
  | { type: "pause"; id: number }
  /** Clear the pending pause timeout. */
  | { type: "cancelPauseTimeout" }
  | { type: "resume" }
  /** Clear the pause timeout, disable the debugger and disconnect the session. */
  | { type: "teardown" };

export interface WatchdogState {
  lastBeat: number;
  /** When the heartbeat last moved, as the worker saw it. */
  lastChangeAt: number;
  /** When the worker last sampled; a long gap means the whole process was suspended. */
  lastTickAt: number;
  stalled: boolean;
  /** Where the diagnosis of the current stall stands. */
  pause: "none" | "pending" | "timedOut" | "landed" | "failed";
  /** The id of the latest pause request, so a stale timeout is recognised. */
  pauseId: number;
  pausePostedAt: number;
}

export interface WatchdogConfig {
  heartbeatMs: number;
  stallMs: number;
  jsPauseLatencyMs: number;
  /** False when the inspector is unavailable: stalls are reported without a location. */
  diagnose: boolean;
}

/**
 * The state before the first sample. Self-contained: it is stringified into the worker.
 *
 * @internal Exported for testing
 */
export function initialWatchdogState(beat: number, now: number): WatchdogState {
  return {
    lastBeat: beat,
    lastChangeAt: now,
    lastTickAt: now,
    stalled: false,
    pause: "none",
    pauseId: 0,
    pausePostedAt: 0,
  };
}

/**
 * The watchdog's decision logic: one event in, the next state and the effects
 * to run out. Pure, and self-contained because it is stringified into the
 * worker — every helper it needs is declared inside it.
 *
 * - The heartbeat moving after a stall writes the recovery line and tears the
 *   session down; moving otherwise only re-arms.
 * - A gap between the worker's own samples of more than 3 heartbeats means the
 *   whole process was suspended (sleep), not that the main thread stalled, so
 *   the stall clock restarts.
 * - Standing still for `stallMs` starts ONE diagnosis per stall: a pause, or,
 *   without the inspector, an undiagnosed report straight away.
 * - A pause is classified by how long it took to land. Within
 *   `jsPauseLatencyMs` the thread was running JavaScript; later, it was held in
 *   native code and has just returned, so the report says native and gives
 *   where it resumed. A pause still pending at the timeout is reported as
 *   native at once, and the frames follow if it ever lands.
 * - Every pause is answered with a resume, whatever the state — the main
 *   thread must never be left paused by the watchdog — and a timeout for any
 *   pause but the current one is ignored.
 *
 * @internal Exported for testing
 */
export function watchdogStep(
  state: WatchdogState,
  event: WatchdogEvent,
  config: WatchdogConfig,
): { state: WatchdogState; effects: WatchdogEffect[] } {
  const MAX_FRAMES = 25;
  const SUSPEND_GAP_HEARTBEATS = 3;
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
    const sampled: WatchdogState = { ...state, lastTickAt: event.now };

    if (event.beat !== state.lastBeat) {
      const next: WatchdogState = {
        ...sampled,
        lastBeat: event.beat,
        lastChangeAt: event.now,
        stalled: false,
        pause: "none",
      };

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

    if (!state.stalled && event.now - state.lastTickAt > SUSPEND_GAP_HEARTBEATS * config.heartbeatMs) {
      return { state: { ...sampled, lastChangeAt: event.now }, effects: [] };
    }

    if (state.stalled || event.now - state.lastChangeAt < config.stallMs) return { state: sampled, effects: [] };

    if (!config.diagnose) {
      return {
        state: { ...sampled, stalled: true },
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

    const pauseId = state.pauseId + 1;

    return {
      state: { ...sampled, stalled: true, pause: "pending", pauseId, pausePostedAt: event.now },
      effects: [{ type: "pause", id: pauseId }],
    };
  }

  const blockedFor = seconds(event.now - state.lastChangeAt);

  if (event.type === "paused") {
    if (state.pause === "pending") {
      const lines =
        event.now - state.pausePostedAt <= config.jsPauseLatencyMs
          ? [`main thread blocked for ${blockedFor} s in JavaScript`, ...frameLines(event.frames)]
          : [
              `main thread blocked for ${seconds(state.pausePostedAt - state.lastChangeAt)} s in native code`,
              `main thread resumed after ${blockedFor} s; the pause landed at:`,
              ...frameLines(event.frames),
            ];

      return {
        state: { ...state, pause: "landed" },
        effects: [{ type: "cancelPauseTimeout" }, { type: "write", level: "ERROR", lines }, { type: "resume" }],
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
    if (state.pause !== "pending" || event.id !== state.pauseId) return { state, effects: [] };

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

/**
 * The name of a daily target's file for a report written at `now`: the name the
 * Mirabox and Ulanzi `FileSink` writes, `<YYYY.M.D>.log` with an unpadded
 * month and day in local time. Their adapters' tests check the two agree.
 * Self-contained: it is stringified into the worker.
 */
export function watchdogDailyLogFileName(now: Date): string {
  return `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}.log`;
}

/** What the main thread hands the worker. Serialisable, apart from the shared heartbeat. */
interface WatchdogWorkerData {
  heartbeat: SharedArrayBuffer;
  target: WatchdogLogTarget;
  pauseTimeoutMs: number;
  /** `diagnose` here is the caller's permission; the worker drops it if the inspector is unusable. */
  config: WatchdogConfig;
}

/** The one message the worker sends: why it reports stalls without a location. */
interface DiagnosisUnavailableMessage {
  type: "diagnosisUnavailable";
  reason: string;
}

/**
 * The worker's body: the interpreter of `watchdogStep`'s effects. Runs in an
 * eval worker, so it must stay self-contained (see the file header).
 */
function watchdogWorkerMain(
  step: typeof watchdogStep,
  initialState: typeof initialWatchdogState,
  dailyLogFileName: typeof watchdogDailyLogFileName,
): void {
  // An eval worker runs as CommonJS, unless the process was started with
  // `--input-type=module`, which the worker inherits and which leaves no
  // `require`. `process.getBuiltinModule` covers that case on Node >= 20.16.
  const load = (id: string): unknown =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- this source cannot `import`
    typeof require === "function" ? require(id) : process.getBuiltinModule(id);
  const { parentPort, workerData } = load("node:worker_threads") as typeof import("node:worker_threads");
  const fs = load("node:fs") as typeof import("node:fs");
  const path = load("node:path") as typeof import("node:path");
  const data = workerData as WatchdogWorkerData;
  const beats = new Int32Array(data.heartbeat);
  const config: WatchdogConfig = { ...data.config };

  let inspector: typeof import("node:inspector") | undefined;

  if (config.diagnose) {
    let reason = "";

    try {
      inspector = load("node:inspector") as typeof import("node:inspector");

      if (typeof inspector.Session?.prototype?.connectToMainThread !== "function") {
        inspector = undefined;
        reason = "this Node's inspector has no Session.connectToMainThread";
      }
    } catch (err) {
      inspector = undefined;
      reason = `node:inspector cannot be loaded (${String(err)})`;
    }

    if (!inspector) {
      config.diagnose = false;
      const message: DiagnosisUnavailableMessage = { type: "diagnosisUnavailable", reason };
      parentPort?.postMessage(message);
    }
  }

  // Stall arithmetic runs on the monotonic clock, so a wall-clock step can
  // neither fake a stall nor hide one; the log lines keep wall time.
  let state = initialState(Atomics.load(beats, 0), performance.now());
  let session: import("node:inspector").Session | undefined;
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;
  // A paused call frame names its script by id only (its own `url` is
  // deprecated and empty), so the urls come from `Debugger.scriptParsed`,
  // which `Debugger.enable` replays for every loaded script.
  let scriptUrls = new Map<string, string>();

  const write = (level: string, lines: string[]): void => {
    try {
      const now = new Date();
      const file = data.target.kind === "file" ? data.target.path : path.join(data.target.dir, dailyLogFileName(now));
      const prefix = `${now.toISOString()} ${level.padEnd(5)} MainThreadWatchdog: `;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, lines.map((line) => `${prefix}${line}\n`).join(""));
    } catch {
      // Nowhere left to report it: the main-thread logger may be the thing that is stuck.
    }
  };

  const cancelPauseTimeout = (): void => {
    if (pauseTimer !== undefined) clearTimeout(pauseTimer);

    pauseTimer = undefined;
  };

  const teardown = (): void => {
    cancelPauseTimeout();

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
      case "cancelPauseTimeout":
        cancelPauseTimeout();
        break;
      case "teardown":
        teardown();
        break;
      case "pause":
        // A previous stall's session and timer are gone by now; this makes sure.
        teardown();

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
            dispatch({ type: "paused", now: performance.now(), frames });
          });
          opened.post("Debugger.enable");
          opened.post("Debugger.pause");
          const id = effect.id;
          pauseTimer = setTimeout(() => {
            pauseTimer = undefined;
            dispatch({ type: "pauseTimeout", id, now: performance.now() });
          }, data.pauseTimeoutMs);
        } catch (err) {
          dispatch({ type: "pauseFailed", now: performance.now(), reason: String(err) });
        }

        break;
    }
  };

  setInterval(
    () => dispatch({ type: "tick", beat: Atomics.load(beats, 0), now: performance.now() }),
    config.heartbeatMs,
  );
}

/**
 * The worker's full source, assembled from the self-contained functions above.
 *
 * @internal Exported for testing
 */
export function createWatchdogWorkerSource(): string {
  const parts = [watchdogStep, initialWatchdogState, watchdogDailyLogFileName].map((fn) => fn.toString());

  return `(${watchdogWorkerMain.toString()})(${parts.join(", ")});\n`;
}

/**
 * Wire the main thread's side of the worker: one WARN when the worker reports
 * that it cannot diagnose, and, when the worker dies (`error` or `exit`), one
 * WARN plus `onStopped` so the caller stops the heartbeat. Call `expectExit()`
 * before terminating the worker on purpose, so that exit is not reported.
 *
 * @internal Exported for testing
 */
export function superviseWatchdogWorker(
  worker: EventEmitter,
  logger: ILogger,
  onStopped: () => void,
): { expectExit(): void } {
  let finished = false;

  const stopped = (why: string): void => {
    if (finished) return;

    finished = true;
    onStopped();
    logger.warn(`Main-thread watchdog stopped: ${why}`);
  };

  worker.on("message", (message: unknown) => {
    const m = message as Partial<DiagnosisUnavailableMessage> | null;

    if (m?.type === "diagnosisUnavailable") {
      logger.warn(`Main-thread watchdog cannot tell where a stall is stuck, only that it happened: ${m.reason}`);
    }
  });
  worker.on("error", (err: unknown) => stopped(String(err)));
  worker.on("exit", (code: number) => stopped(`the worker exited with code ${code}`));

  return {
    expectExit: () => {
      finished = true;
    },
  };
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
  const jsPauseLatencyMs = options.jsPauseLatencyMs ?? WATCHDOG_DEFAULTS.jsPauseLatencyMs;

  const heartbeat = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const beats = new Int32Array(heartbeat);
  const workerData: WatchdogWorkerData = {
    heartbeat,
    target,
    pauseTimeoutMs,
    config: { heartbeatMs, stallMs, jsPauseLatencyMs, diagnose: true },
  };

  let worker: Worker;

  try {
    worker = new Worker(createWatchdogWorkerSource(), { eval: true, workerData, name: "MainThreadWatchdog" });
  } catch (err) {
    logger.warn(`Main-thread watchdog could not start: ${String(err)}`);

    return { stop: async () => {} };
  }

  const timer = setInterval(() => Atomics.add(beats, 0, 1), heartbeatMs);
  timer.unref();
  worker.unref();
  const supervision = superviseWatchdogWorker(worker, logger, () => clearInterval(timer));

  logger.info("Main-thread watchdog started");
  logger.debug(`Main-thread watchdog: heartbeat ${heartbeatMs} ms, stall after ${stallMs} ms, target ${target.kind}`);

  return {
    stop: async () => {
      supervision.expectExit();
      clearInterval(timer);
      await worker.terminate();
    },
  };
}
