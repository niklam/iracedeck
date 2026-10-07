/**
 * Capture CPU profile (#1338): record the plugin's main thread for a while and
 * leave two files a user can attach to a report.
 *
 * Two performance problems were found on 2026-10-04 only by attaching DevTools
 * over a debug port, which needs developer mode, a hand-edited manifest, and
 * changes the plugin under test. This module does the same measurement from
 * inside the process: an in-process `inspector.Session` connected to the main
 * thread (`session.connect()`), driving the `Profiler` domain. Node's built-in
 * inspector, so no `--inspect`, no port and no developer mode.
 *
 * The files go to a `profiles` folder the plugin injects — inside its own log
 * directory — and the settings window's button only ever says "capture", never
 * where: a command never takes a path from the page (`settings-window.md`).
 *
 * - `cpu-<ISO time>.cpuprofile` opens in Chrome DevTools.
 * - `cpu-<ISO time>.txt` is enough to read the profile in a chat: wall and busy
 *   time, then the top functions by self time with their bundle positions.
 * - The folder keeps the newest five pairs, pruned by exact name pattern after
 *   each save, so nothing else a user puts there is touched.
 *
 * The capture's state is published as the run-scoped `_profileCaptureStatus`
 * (a JSON string, like `_voicePackStatus`), which the settings window renders.
 *
 * Decision record: `docs/superpowers/specs/2026-10-04-issue-1338-built-in-profiling.md`.
 *
 * This file imports nothing but Node built-ins, erasable types and the
 * `@iracedeck/app-constants` leaf, so its integration test can run it,
 * transpiled, in a child Node process.
 */
import { PROFILE_CAPTURE_STATUS_KEY } from "@iracedeck/app-constants";
import type { ILogger } from "@iracedeck/logger";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The spec's values: 30 s at a 1 ms sampling interval (~30,000 samples), newest five pairs kept. */
export const CPU_PROFILE_DEFAULTS = {
  durationMs: 30_000,
  samplingIntervalUs: 1000,
  keep: 5,
  topFunctions: 30,
} as const;

/**
 * What the settings window renders.
 *
 * `durationMs` rides along with `capturing` so the page's countdown never
 * restates the plugin's duration; `startedAt` is wall-clock epoch ms, which the
 * page compares with its own clock on the same machine.
 */
export type ProfileCaptureStatus =
  | { state: "idle" }
  | { state: "capturing"; startedAt: number; durationMs: number }
  | { state: "saved"; startedAt: number; file: string }
  | { state: "failed"; startedAt?: number; reason: string };

export type CpuProfileCaptureResult =
  | { ok: true; profileFile: string; summaryFile: string }
  /** `busy`: a capture was already running and this request was refused. */
  | { ok: false; reason: string; busy?: boolean };

/** The slice of `inspector.Session` the capture uses. */
export interface InspectorSessionLike {
  connect(): void;
  disconnect(): void;
  post(method: string, params: object, callback: (err: Error | null, result?: unknown) => void): void;
}

export interface CpuProfileCaptureOptions {
  /** The plugin's profiles folder (`<log dir>/profiles`); created when missing. Never from a page. */
  profilesDir: string;
  logger: ILogger;
  /** Writes a partial into global settings — the plugin binds `updateGlobalSettings`. */
  writeSettings: (partial: Record<string, unknown>) => void;
  durationMs?: number;
  samplingIntervalUs?: number;
  /** How many capture pairs the folder keeps. */
  keep?: number;
  /** Wall clock, for the file names and `startedAt`. */
  now?: () => Date;
  /** @internal Builds the `.txt` from the profile; defaults to `summarizeCpuProfile` + `formatCpuProfileSummary`. For tests. */
  summarize?: (profile: CpuProfile, stem: string) => string;
  /** Opens an unconnected session; defaults to `new (await import("node:inspector")).Session()`. Throws when unavailable. */
  openSession?: () => Promise<InspectorSessionLike>;
}

export interface CpuProfileCapture {
  /** Run one capture. A request while one is running is refused, never queued. */
  capture(): Promise<CpuProfileCaptureResult>;
  isCapturing(): boolean;
  /** The state last published (`idle` before the first capture). */
  status(): ProfileCaptureStatus;
  /**
   * Hear every published state, the same one `_profileCaptureStatus` carries,
   * typed rather than as a JSON string — how the Telemetry Control key follows a
   * capture started from the settings window (#1338). Returns an unsubscribe.
   * A throwing listener is logged and skipped.
   */
  onStatus(listener: (status: ProfileCaptureStatus) => void): () => void;
}

/** One node of a V8 CPU profile (`Profiler.Profile`). Line and column are 0-based. */
export interface CpuProfileNode {
  id: number;
  callFrame: { functionName: string; scriptId?: string; url: string; lineNumber: number; columnNumber: number };
  hitCount?: number;
  children?: number[];
}

/** A V8 CPU profile as `Profiler.stop` returns it. Times are microseconds. */
export interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

/** Matches a capture this module wrote, and nothing else: `cpu-<ISO, filename-safe>.<ext>`. */
const CAPTURE_FILE_PATTERN = /^(cpu-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.(cpuprofile|txt)$/;

/** V8's pseudo-frames: listed in the summary, but labelled, since none of them is plugin code. */
/**
 * A `Map`, never an object literal: the lookup key is whatever name V8 gave a
 * function, and a native frame named `toString` or `constructor` would find
 * `Object.prototype`'s member in a plain object.
 */
const PSEUDO_FRAME_LABELS: ReadonlyMap<string, string> = new Map([
  ["(idle)", "not code: the thread was waiting for work"],
  ["(program)", "not plugin code: V8 and native work outside JavaScript"],
  ["(garbage collector)", "not plugin code: garbage collection"],
  ["(root)", "not code: the profile's root"],
]);

/**
 * The file stem for a capture started at `date`: `cpu-2026-10-04T12-30-05-123Z`.
 * The ISO time with `:` and `.` replaced, so it is a valid Windows file name and
 * still sorts chronologically as a string.
 *
 * @internal Exported for testing
 */
export function captureFileStem(date: Date): string {
  return `cpu-${date.toISOString().replace(/[:.]/g, "-")}`;
}

/** One function's share of a profile. */
export interface CpuProfileEntry {
  functionName: string;
  url: string;
  /** 1-based, as an editor shows it. */
  line: number;
  column: number;
  selfUs: number;
  /** The pseudo-frame label, for `(idle)`, `(program)`, `(garbage collector)` and `(root)`. */
  label?: string;
}

export interface CpuProfileSummary {
  wallUs: number;
  /** Sampled time not spent idle. */
  busyUs: number;
  sampleCount: number;
  /** Every function by self time, largest first. */
  entries: CpuProfileEntry[];
}

/**
 * Self time per function. A sample's duration is the gap to the next sample's
 * timestamp (the last one runs to `endTime`), the way DevTools reads a profile.
 * Nodes are merged by function and position, since one function appears once
 * per distinct caller path.
 *
 * @internal Exported for testing
 */
export function summarizeCpuProfile(profile: CpuProfile): CpuProfileSummary {
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const nodeById = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfByNode = new Map<number, number>();
  const timestamps: number[] = [];
  let t = profile.startTime;

  for (let i = 0; i < samples.length; i++) {
    t += deltas[i] ?? 0;
    timestamps.push(t);
  }

  for (let i = 0; i < samples.length; i++) {
    const end = i + 1 < samples.length ? timestamps[i + 1] : profile.endTime;
    const duration = Math.max(0, end - timestamps[i]);
    selfByNode.set(samples[i], (selfByNode.get(samples[i]) ?? 0) + duration);
  }

  const byFunction = new Map<string, CpuProfileEntry>();

  for (const [nodeId, selfUs] of selfByNode) {
    const frame = nodeById.get(nodeId)?.callFrame;

    if (!frame) continue;

    const key = `${frame.functionName}\u0000${frame.url}\u0000${frame.lineNumber}\u0000${frame.columnNumber}`;
    const existing = byFunction.get(key);

    if (existing) {
      existing.selfUs += selfUs;
      continue;
    }

    const entry: CpuProfileEntry = {
      functionName: frame.functionName,
      url: frame.url,
      line: frame.lineNumber + 1,
      column: frame.columnNumber + 1,
      selfUs,
    };
    const label = PSEUDO_FRAME_LABELS.get(frame.functionName);

    if (label && frame.url === "") entry.label = label;

    byFunction.set(key, entry);
  }

  const entries = [...byFunction.values()].sort((a, b) => b.selfUs - a.selfUs);
  const sampledUs = entries.reduce((sum, entry) => sum + entry.selfUs, 0);
  const idleUs = entries
    .filter((entry) => entry.label && entry.functionName === "(idle)")
    .reduce((sum, entry) => sum + entry.selfUs, 0);

  return {
    wallUs: Math.max(0, profile.endTime - profile.startTime),
    busyUs: sampledUs - idleUs,
    sampleCount: samples.length,
    entries,
  };
}

/**
 * The `.txt` beside the profile: enough to read it in a chat without tools.
 *
 * @internal Exported for testing
 */
export function formatCpuProfileSummary(
  summary: CpuProfileSummary,
  options: { stem: string; samplingIntervalUs: number; top?: number },
): string {
  const top = options.top ?? CPU_PROFILE_DEFAULTS.topFunctions;
  const ms = (us: number): string => (us / 1000).toFixed(1);
  const pct = (us: number): string => (summary.wallUs > 0 ? ((us / summary.wallUs) * 100).toFixed(1) : "0.0");
  const lines = [
    `iRaceDeck CPU profile ${options.stem}`,
    "",
    `Wall time:  ${(summary.wallUs / 1e6).toFixed(2)} s`,
    `Busy time:  ${(summary.busyUs / 1e6).toFixed(2)} s (${pct(summary.busyUs)}% of wall time)`,
    `Samples:    ${summary.sampleCount} at a ${options.samplingIntervalUs} µs interval`,
    "",
    `Top ${top} functions by self time (% of wall time). Positions are bundle positions (line:column):`,
    "",
  ];

  for (const entry of summary.entries.slice(0, top)) {
    const name = entry.functionName || "(anonymous)";
    const where = entry.label ? `[${entry.label}]` : `${entry.url || "(native)"}:${entry.line}:${entry.column}`;
    lines.push(`${ms(entry.selfUs).padStart(9)} ms ${pct(entry.selfUs).padStart(5)}%  ${name}  ${where}`);
  }

  if (summary.entries.length === 0) lines.push("  (no samples)");

  return `${lines.join("\n")}\n`;
}

/**
 * Delete all but the newest `keep` capture pairs in `dir`. Only names this
 * module writes are considered, so a user's own files are never touched.
 * Failures are swallowed: pruning must never fail a capture that was saved.
 *
 * @internal Exported for testing
 */
export async function pruneCpuProfiles(dir: string, keep: number): Promise<void> {
  let names: string[];

  try {
    names = await readdir(dir);
  } catch {
    return;
  }

  const stems = new Set<string>();

  for (const name of names) {
    const match = CAPTURE_FILE_PATTERN.exec(name);

    if (match) stems.add(match[1]);
  }

  const doomed = [...stems].sort().reverse().slice(keep);

  for (const stem of doomed) {
    for (const ext of ["cpuprofile", "txt"]) {
      try {
        await rm(join(dir, `${stem}.${ext}`), { force: true });
      } catch {
        // A locked or vanished file is left for the next prune.
      }
    }
  }
}

async function openInspectorSession(): Promise<InspectorSessionLike> {
  // Loaded on demand: a Node built without the inspector throws on load, and
  // that must fail one capture, not the plugin's startup.
  const inspector = await import("node:inspector");

  return new inspector.Session() as unknown as InspectorSessionLike;
}

function post<T>(session: InspectorSessionLike, method: string, params: object = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    session.post(method, params, (err, result) => (err ? reject(err) : resolve(result as T)));
  });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Create the capture service. One per plugin; it holds the one-at-a-time lock. */
export function createCpuProfileCapture(options: CpuProfileCaptureOptions): CpuProfileCapture {
  const { profilesDir, logger, writeSettings } = options;
  const durationMs = options.durationMs ?? CPU_PROFILE_DEFAULTS.durationMs;
  const samplingIntervalUs = options.samplingIntervalUs ?? CPU_PROFILE_DEFAULTS.samplingIntervalUs;
  const keep = options.keep ?? CPU_PROFILE_DEFAULTS.keep;
  const now = options.now ?? (() => new Date());
  const openSession = options.openSession ?? openInspectorSession;
  const summarize =
    options.summarize ??
    ((profile: CpuProfile, stem: string) =>
      formatCpuProfileSummary(summarizeCpuProfile(profile), { stem, samplingIntervalUs }));
  let capturing = false;
  /** The running capture's start, so even the last-resort failure reports when it began. */
  let currentStartedAt: number | undefined;

  let lastStatus: ProfileCaptureStatus = { state: "idle" };
  const listeners = new Set<(status: ProfileCaptureStatus) => void>();

  const publish = (status: ProfileCaptureStatus): void => {
    lastStatus = status;

    for (const listener of [...listeners]) {
      try {
        listener(status);
      } catch (err) {
        logger.debug(`A CPU profile capture status listener failed: ${describeError(err)}`);
      }
    }

    try {
      writeSettings({ [PROFILE_CAPTURE_STATUS_KEY]: JSON.stringify(status) });
    } catch (err) {
      logger.debug(`Publishing the CPU profile capture status failed: ${describeError(err)}`);
    }
  };

  const fail = (startedAt: number | undefined, reason: string): CpuProfileCaptureResult => {
    logger.warn(`CPU profile capture failed: ${reason}`);
    publish({ state: "failed", startedAt, reason });

    return { ok: false, reason };
  };

  const run = async (): Promise<CpuProfileCaptureResult> => {
    const started = now();
    const startedAt = started.getTime();
    currentStartedAt = startedAt;
    const stem = captureFileStem(started);

    publish({ state: "capturing", startedAt, durationMs });
    logger.info("CPU profile capture started");

    let session: InspectorSessionLike;

    try {
      session = await openSession();
      session.connect();
    } catch (err) {
      return fail(startedAt, `the Node.js inspector is not available (${describeError(err)})`);
    }

    let profile: CpuProfile;

    try {
      await post(session, "Profiler.enable");
      await post(session, "Profiler.setSamplingInterval", { interval: samplingIntervalUs });
      await post(session, "Profiler.start");
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      ({ profile } = await post<{ profile: CpuProfile }>(session, "Profiler.stop"));
    } catch (err) {
      return fail(startedAt, `the profiler failed (${describeError(err)})`);
    } finally {
      try {
        await post(session, "Profiler.disable");
      } catch {
        // Disconnecting below ends the profiler with the session anyway.
      }

      try {
        session.disconnect();
      } catch {
        // Already gone.
      }
    }

    const profileFile = join(profilesDir, `${stem}.cpuprofile`);
    const summaryFile = join(profilesDir, `${stem}.txt`);
    // Outside the write's try: a summary that cannot be built is a bug, not a
    // write failure, and goes to the last-resort catch in `capture()`.
    const summaryText = summarize(profile, stem);

    try {
      await mkdir(profilesDir, { recursive: true });
      await writeFile(profileFile, JSON.stringify(profile));
      await writeFile(summaryFile, summaryText);
    } catch (err) {
      return fail(startedAt, `the profile could not be written (${describeError(err)})`);
    }

    await pruneCpuProfiles(profilesDir, keep);

    logger.info("CPU profile saved");
    logger.debug(`CPU profile saved to ${profileFile}`);
    publish({ state: "saved", startedAt, file: `${stem}.cpuprofile` });

    return { ok: true, profileFile, summaryFile };
  };

  return {
    capture: async () => {
      if (capturing) {
        logger.debug("CPU profile capture already running; request refused");

        return { ok: false, reason: "a capture is already running", busy: true };
      }

      capturing = true;
      currentStartedAt = undefined;

      try {
        return await run();
      } catch (err) {
        // Nothing above should throw, but the lock must never stay held, and
        // the failure still reports when the capture began, not when it died.
        return fail(currentStartedAt, describeError(err));
      } finally {
        capturing = false;
        currentStartedAt = undefined;
      }
    },
    isCapturing: () => capturing,
    status: () => lastStatus,
    onStatus: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The plugin's one capture service (#1338): the settings window and the Telemetry Control key share it. */
let sharedCapture: CpuProfileCapture | undefined;

/**
 * Create the plugin's capture service. Called once by the shared bootstrap
 * (`plugin-runtime`'s settings phase, `phases/settings.ts`), the
 * same shape as `initializeAudio`; consumers reach it with
 * {@link getCpuProfileCapture}, so "one capture at a time", the status key and
 * the files are the same for the settings-window button and the deck key.
 */
export function initializeCpuProfileCapture(options: CpuProfileCaptureOptions): CpuProfileCapture {
  if (sharedCapture) throw new Error("CPU profile capture already initialized");

  sharedCapture = createCpuProfileCapture(options);

  return sharedCapture;
}

/** The shared capture service. Throws before {@link initializeCpuProfileCapture}. */
export function getCpuProfileCapture(): CpuProfileCapture {
  if (!sharedCapture) throw new Error("CPU profile capture not initialized");

  return sharedCapture;
}

export function isCpuProfileCaptureInitialized(): boolean {
  return sharedCapture !== undefined;
}

/** @internal For test isolation only. */
export function _resetCpuProfileCapture(): void {
  sharedCapture = undefined;
}
