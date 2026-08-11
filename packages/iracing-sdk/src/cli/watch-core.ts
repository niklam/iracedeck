/**
 * Pure helpers for the telemetry-watch CLI (issue #938).
 *
 * Everything that doesn't require the native SDK or the filesystem lives
 * here so it can be unit-tested: argument parsing, change detection, JSONL
 * record building, output naming, and the exit summary. The CLI entry
 * (`telemetry-watch.ts`) stays a thin shell over these plus `SDKController`.
 */
import { snapshotTimestamp } from "../snapshot.js";
import type { TelemetryData } from "../types.js";

export type WatchMode = "changes" | "all";

export interface WatchOptions {
  vars: string[];
  mode: WatchMode;
  output: string | null;
  outputDir: string | null;
  help: boolean;
  verbose: boolean;
}

/** First line of every capture — identifies what was recorded and how. */
export interface WatchMetaRecord {
  type: "meta";
  startedAt: string;
  vars: string[];
  mode: WatchMode;
}

/** One recorded telemetry frame (all frames in `all` mode, changed frames in `changes` mode). */
export interface WatchTickRecord {
  type: "tick";
  ts: number;
  sessionTick: number | null;
  sessionTime: number | null;
  values: Record<string, unknown>;
}

/** Emitted on every SDK connection edge (and once for the initial state). */
export interface WatchConnectionRecord {
  type: "connection";
  ts: number;
  connected: boolean;
}

export function parseWatchArgs(args: string[]): { options: WatchOptions; error: string | null } {
  const options: WatchOptions = {
    vars: [],
    mode: "changes",
    output: null,
    outputDir: null,
    help: false,
    verbose: false,
  };
  let error: string | null = null;

  for (const arg of args) {
    if (arg === "--") {
      // pnpm run forwards a `--` separator to the script verbatim — skip it.
      continue;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg.startsWith("--vars=")) {
      // Split on commas AND whitespace: pnpm run mangles a comma-separated
      // value into a space-separated one when forwarding args to a script,
      // so `--vars=A,B` can arrive as `--vars=A B`. Repeated flags append.
      options.vars.push(
        ...arg
          .slice("--vars=".length)
          .split(/[\s,]+/)
          .filter((v) => v.length > 0),
      );
    } else if (arg.startsWith("--mode=")) {
      const mode = arg.slice("--mode=".length);

      if (mode === "changes" || mode === "all") {
        options.mode = mode;
      } else {
        error ??= `Invalid mode: ${mode}. Use 'changes' or 'all'.`;
      }
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    } else {
      error ??= `Unknown argument: ${arg}`;
    }
  }

  if (!options.help && error === null && options.vars.length === 0) {
    error = "At least one variable is required: --vars=Var1,Var2,...";
  }

  return { options, error: options.help ? null : error };
}

/**
 * Extracts the requested vars from a frame, in request order. A var the
 * frame doesn't carry records as `null` so every tick record has the same
 * shape — analysis code never needs existence checks.
 */
export function pickWatchValues(telemetry: TelemetryData, vars: string[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  for (const name of vars) {
    values[name] = telemetry[name] ?? null;
  }

  return values;
}

/**
 * Change detection for `changes` mode. Strict equality per key; arrays are
 * compared by JSON content (telemetry arrays are flat primitive arrays).
 * `prev === null` (first frame) always counts as changed.
 */
export function watchValuesChanged(prev: Record<string, unknown> | null, next: Record<string, unknown>): boolean {
  if (prev === null) {
    return true;
  }

  for (const [key, value] of Object.entries(next)) {
    const before = prev[key];

    if (Array.isArray(before) && Array.isArray(value)) {
      if (JSON.stringify(before) !== JSON.stringify(value)) {
        return true;
      }
    } else if (before !== value) {
      return true;
    }
  }

  return false;
}

/** Requested vars absent from the frame — for the one-time startup warning. */
export function findMissingVars(telemetry: TelemetryData, vars: string[]): string[] {
  return vars.filter((name) => !(name in telemetry));
}

export function buildMetaRecord(startedAt: Date, vars: string[], mode: WatchMode): WatchMetaRecord {
  return { type: "meta", startedAt: startedAt.toISOString(), vars, mode };
}

export function buildTickRecord(ts: number, telemetry: TelemetryData, vars: string[]): WatchTickRecord {
  const sessionTick = telemetry.SessionTick;
  const sessionTime = telemetry.SessionTime;

  return {
    type: "tick",
    ts,
    sessionTick: typeof sessionTick === "number" ? sessionTick : null,
    sessionTime: typeof sessionTime === "number" ? sessionTime : null,
    values: pickWatchValues(telemetry, vars),
  };
}

export function buildConnectionRecord(ts: number, connected: boolean): WatchConnectionRecord {
  return { type: "connection", ts, connected };
}

/**
 * Base filename (without extension) for an auto-named capture. Mirrors
 * `snapshotBaseName` including the millisecond suffix so two captures
 * started within the same second never collide.
 */
export function watchBaseName(now: Date = new Date()): string {
  const ms = String(now.getMilliseconds()).padStart(3, "0");

  return `telemetry-watch-${snapshotTimestamp(now)}-${ms}`;
}

export function formatWatchSummary(tickCount: number, durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const duration = totalSeconds < 60 ? `${totalSeconds}s` : `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;

  return `Recorded ${tickCount} tick records in ${duration}`;
}
