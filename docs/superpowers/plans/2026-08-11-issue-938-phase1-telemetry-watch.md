# Issue #938 Phase 1 — `telemetry-watch` CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A committed, reusable CLI in `@iracedeck/iracing-sdk` that records selected telemetry variables at full rate (per deduped `SessionTick` frame) to JSONL, so the #938 incident-flag model can be validated from a real driving session.

**Architecture:** A thin CLI entry (`telemetry-watch.ts`) over `SDKController` (the exact 10 ms/`SessionTick`-deduped cadence the plugin's translator sees), with every piece of testable logic in a pure sibling module (`watch-core.ts`): arg parsing, change detection, record building, file naming, summary formatting. No decoding — raw values only; analysis happens on the captured file.

**Tech Stack:** TypeScript ESM (`"type": "module"`, imports use `.js` suffixes), Node ≥ 24, Vitest, existing `createSDK()` factory. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-11-issue-938-incident-sequence-totals-design.md`

## Global Constraints

- Worktree: `C:/Users/Niklas/Projects/iRaceDeck/ir-938` (branch `ir-938`). The shell cwd resets between commands — always use absolute paths / `git -C` / `pnpm --dir`.
- No new dependencies; exact versions only if one were ever needed (`.npmrc` has `save-exact=true`).
- Tests are required for all new code (`foo.ts` → `foo.test.ts`, Vitest `describe`/`it`/`expect`).
- Run tests from the repo root with `pnpm exec vitest run <path>` (per-package `pnpm --filter` test scripts can silently no-op).
- `pnpm lint:fix` and `pnpm format:fix` (run with `--dir` against the worktree) before committing.
- Full `pnpm build` must pass before a commit is considered done. If it fails with EPERM on `iracing_native.node`, a deck-host app (Stream Deck / UlanziStudio) is holding the native module — ask Niklas to quit it.
- The SDK logger stays `silentLogger` in this CLI regardless of `--verbose` — `consoleLogger` writes to stdout, which would corrupt JSONL when streaming to stdout. `--verbose` only prints CLI-level status lines to **stderr**.
- All stderr/stdout discipline: records → the sink (file or stdout); status, warnings, summary → stderr.

---

### Task 1: `watch-core.ts` pure helpers (TDD)

**Files:**
- Create: `packages/iracing-sdk/src/cli/watch-core.ts`
- Test: `packages/iracing-sdk/src/cli/watch-core.test.ts`

**Interfaces:**
- Consumes: `snapshotTimestamp(now)` from `../snapshot.js`; `TelemetryData` from `../types.js`.
- Produces (Task 2 relies on these exact names):
  - `type WatchMode = "changes" | "all"`
  - `interface WatchOptions { vars: string[]; mode: WatchMode; output: string | null; outputDir: string | null; help: boolean; verbose: boolean }`
  - `parseWatchArgs(args: string[]): { options: WatchOptions; error: string | null }`
  - `pickWatchValues(telemetry: TelemetryData, vars: string[]): Record<string, unknown>`
  - `watchValuesChanged(prev: Record<string, unknown> | null, next: Record<string, unknown>): boolean`
  - `findMissingVars(telemetry: TelemetryData, vars: string[]): string[]`
  - `buildMetaRecord(startedAt: Date, vars: string[], mode: WatchMode): WatchMetaRecord`
  - `buildTickRecord(ts: number, telemetry: TelemetryData, vars: string[]): WatchTickRecord`
  - `buildConnectionRecord(ts: number, connected: boolean): WatchConnectionRecord`
  - `watchBaseName(now?: Date): string`
  - `formatWatchSummary(tickCount: number, durationMs: number): string`

- [ ] **Step 1: Write the failing test file**

`packages/iracing-sdk/src/cli/watch-core.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import type { TelemetryData } from "../types.js";
import {
  buildConnectionRecord,
  buildMetaRecord,
  buildTickRecord,
  findMissingVars,
  formatWatchSummary,
  parseWatchArgs,
  pickWatchValues,
  watchBaseName,
  watchValuesChanged,
} from "./watch-core.js";

describe("parseWatchArgs", () => {
  it("parses vars, mode, output, and flags", () => {
    const { options, error } = parseWatchArgs([
      "--vars=PlayerIncidents,PlayerCarMyIncidentCount",
      "--mode=all",
      "--output=capture.jsonl",
      "--verbose",
    ]);

    expect(error).toBeNull();
    expect(options.vars).toEqual(["PlayerIncidents", "PlayerCarMyIncidentCount"]);
    expect(options.mode).toBe("all");
    expect(options.output).toBe("capture.jsonl");
    expect(options.outputDir).toBeNull();
    expect(options.verbose).toBe(true);
  });

  it("defaults mode to changes and outputs to null", () => {
    const { options, error } = parseWatchArgs(["--vars=Speed"]);

    expect(error).toBeNull();
    expect(options.mode).toBe("changes");
    expect(options.output).toBeNull();
    expect(options.outputDir).toBeNull();
    expect(options.verbose).toBe(false);
  });

  it("trims var names and drops empty entries", () => {
    const { options } = parseWatchArgs(["--vars= Speed , ,Gear "]);

    expect(options.vars).toEqual(["Speed", "Gear"]);
  });

  it("errors when --vars is missing", () => {
    const { error } = parseWatchArgs([]);

    expect(error).toMatch(/--vars/);
  });

  it("errors when --vars is empty", () => {
    const { error } = parseWatchArgs(["--vars=,"]);

    expect(error).toMatch(/--vars/);
  });

  it("errors on an invalid mode", () => {
    const { error } = parseWatchArgs(["--vars=Speed", "--mode=sometimes"]);

    expect(error).toMatch(/mode/i);
  });

  it("errors on an unknown argument", () => {
    const { error } = parseWatchArgs(["--vars=Speed", "--frobnicate"]);

    expect(error).toMatch(/--frobnicate/);
  });

  it("help short-circuits validation", () => {
    const { options, error } = parseWatchArgs(["--help"]);

    expect(error).toBeNull();
    expect(options.help).toBe(true);
  });

  it("accepts -h and -v shorthands", () => {
    const { options } = parseWatchArgs(["--vars=Speed", "-h", "-v"]);

    expect(options.help).toBe(true);
    expect(options.verbose).toBe(true);
  });
});

describe("pickWatchValues", () => {
  it("extracts requested vars in request order", () => {
    const telemetry = { Gear: 3, Speed: 42.5 } as TelemetryData;

    const values = pickWatchValues(telemetry, ["Speed", "Gear"]);

    expect(Object.keys(values)).toEqual(["Speed", "Gear"]);
    expect(values).toEqual({ Speed: 42.5, Gear: 3 });
  });

  it("records missing vars as null so the record shape stays stable", () => {
    const telemetry = { Speed: 42.5 } as TelemetryData;

    expect(pickWatchValues(telemetry, ["Speed", "NoSuchVar"])).toEqual({ Speed: 42.5, NoSuchVar: null });
  });
});

describe("watchValuesChanged", () => {
  it("always reports change when there is no previous record", () => {
    expect(watchValuesChanged(null, { Speed: 0 })).toBe(true);
  });

  it("reports no change for identical primitives", () => {
    expect(watchValuesChanged({ Speed: 42.5, Live: true }, { Speed: 42.5, Live: true })).toBe(false);
  });

  it("detects a primitive change", () => {
    expect(watchValuesChanged({ Speed: 42.5 }, { Speed: 43 })).toBe(true);
  });

  it("compares arrays by content", () => {
    expect(watchValuesChanged({ Flags: [1, 2] }, { Flags: [1, 2] })).toBe(false);
    expect(watchValuesChanged({ Flags: [1, 2] }, { Flags: [1, 3] })).toBe(true);
  });

  it("treats a var flipping to null as a change", () => {
    expect(watchValuesChanged({ Speed: 42.5 }, { Speed: null })).toBe(true);
  });
});

describe("findMissingVars", () => {
  it("lists requested vars absent from the frame", () => {
    const telemetry = { Speed: 1 } as TelemetryData;

    expect(findMissingVars(telemetry, ["Speed", "Bogus", "AlsoBogus"])).toEqual(["Bogus", "AlsoBogus"]);
  });

  it("returns an empty list when everything is present", () => {
    const telemetry = { Speed: 1 } as TelemetryData;

    expect(findMissingVars(telemetry, ["Speed"])).toEqual([]);
  });
});

describe("record builders", () => {
  it("builds the meta record", () => {
    const startedAt = new Date("2026-08-11T18:00:00.000Z");

    expect(buildMetaRecord(startedAt, ["A", "B"], "changes")).toEqual({
      type: "meta",
      startedAt: "2026-08-11T18:00:00.000Z",
      vars: ["A", "B"],
      mode: "changes",
    });
  });

  it("builds a tick record with SessionTick/SessionTime lifted out", () => {
    const telemetry = { SessionTick: 1234, SessionTime: 56.78, PlayerIncidents: 5 } as TelemetryData;

    expect(buildTickRecord(1700000000000, telemetry, ["PlayerIncidents"])).toEqual({
      type: "tick",
      ts: 1700000000000,
      sessionTick: 1234,
      sessionTime: 56.78,
      values: { PlayerIncidents: 5 },
    });
  });

  it("null-fills SessionTick/SessionTime when the frame lacks them", () => {
    const telemetry = { PlayerIncidents: 0 } as TelemetryData;

    const record = buildTickRecord(1, telemetry, ["PlayerIncidents"]);

    expect(record.sessionTick).toBeNull();
    expect(record.sessionTime).toBeNull();
  });

  it("builds a connection record", () => {
    expect(buildConnectionRecord(42, true)).toEqual({ type: "connection", ts: 42, connected: true });
  });
});

describe("watchBaseName", () => {
  it("formats a filesystem-safe, millisecond-unique name", () => {
    const now = new Date(2026, 7, 11, 18, 5, 7, 42);

    expect(watchBaseName(now)).toBe("telemetry-watch-20260811-180507-042");
  });
});

describe("formatWatchSummary", () => {
  it("formats sub-minute durations in seconds", () => {
    expect(formatWatchSummary(12, 42_000)).toBe("Recorded 12 tick records in 42s");
  });

  it("formats longer durations as minutes and seconds", () => {
    expect(formatWatchSummary(345, 272_000)).toBe("Recorded 345 tick records in 4m 32s");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --dir "C:/Users/Niklas/Projects/iRaceDeck/ir-938" exec vitest run packages/iracing-sdk/src/cli/watch-core.test.ts`
Expected: FAIL — cannot resolve `./watch-core.js`.

- [ ] **Step 3: Implement `watch-core.ts`**

```typescript
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
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg.startsWith("--vars=")) {
      options.vars = arg
        .slice("--vars=".length)
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
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
export function watchValuesChanged(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown>,
): boolean {
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
  const duration =
    totalSeconds < 60 ? `${totalSeconds}s` : `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;

  return `Recorded ${tickCount} tick records in ${duration}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --dir "C:/Users/Niklas/Projects/iRaceDeck/ir-938" exec vitest run packages/iracing-sdk/src/cli/watch-core.test.ts`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-938" add packages/iracing-sdk/src/cli/watch-core.ts packages/iracing-sdk/src/cli/watch-core.test.ts
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-938" commit -m "feat(sdk): add telemetry-watch core helpers (#938)"
```

---

### Task 2: `telemetry-watch.ts` CLI entry + package scripts

**Files:**
- Create: `packages/iracing-sdk/src/cli/telemetry-watch.ts`
- Modify: `packages/iracing-sdk/package.json` (scripts block — add `telemetry-watch`)
- Modify: `package.json` (root scripts block, next to `telemetry-snapshot` — add `telemetry-watch`)

**Interfaces:**
- Consumes: everything Task 1 produces; `createSDK(logger)` from `../factory.js`; `silentLogger` from `@iracedeck/logger`.
- Produces: the runnable CLI (`node dist/cli/telemetry-watch.js`), reachable as `pnpm --filter @iracedeck/iracing-sdk telemetry-watch` and root `pnpm telemetry-watch`.

- [ ] **Step 1: Implement the CLI entry**

`packages/iracing-sdk/src/cli/telemetry-watch.ts`:

```typescript
#!/usr/bin/env node
/**
 * CLI tool to continuously record selected iRacing telemetry variables to
 * JSONL, one record per deduped SessionTick frame (issue #938).
 *
 * Subscribes to SDKController — the same 10 ms poll / SessionTick dedupe
 * the plugin's translator runs on — so a capture shows exactly what
 * production code observes. Records raw values only; analysis decodes.
 *
 * Usage:
 *   pnpm --filter @iracedeck/iracing-sdk telemetry-watch -- --vars=Var1,Var2 [options]
 *
 * Options:
 *   --vars=<v1,v2,...>   Variables to record (required)
 *   --mode=changes|all   Record only changed frames (default) or every frame
 *   --output=<file>      Append JSONL to this file
 *   --output-dir=<dir>   Auto-named JSONL file in this directory
 *   --verbose, -v        Status lines on stderr
 *   --help, -h           Show help
 *
 * With no --output/--output-dir, records stream to stdout. Status and the
 * exit summary always go to stderr. Stop with Ctrl+C.
 */
import { silentLogger } from "@iracedeck/logger";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join, resolve } from "node:path";

import { createSDK } from "../factory.js";
import {
  buildConnectionRecord,
  buildMetaRecord,
  buildTickRecord,
  findMissingVars,
  formatWatchSummary,
  parseWatchArgs,
  pickWatchValues,
  watchBaseName,
  watchValuesChanged,
} from "./watch-core.js";

const SUBSCRIBER_ID = "telemetry-watch-cli";

function showHelp(): void {
  console.log(`
iRacing Telemetry Watch

Continuously records selected telemetry variables to JSONL, one record per
deduped SessionTick frame (~60 Hz). Waits for iRacing if it isn't running
yet, and rides out reconnects. Stop with Ctrl+C.

Usage:
  pnpm --filter @iracedeck/iracing-sdk telemetry-watch -- --vars=Var1,Var2 [options]
  pnpm telemetry-watch --vars=Var1,Var2          (from the repo root; writes to local/)

Options:
  --vars=<v1,v2,...>   Variables to record (required)
  --mode=changes|all   'changes' records a frame only when a requested var
                       changed (default; lossless for step-valued vars).
                       'all' records every frame.
  --output=<file>      Append JSONL to this file
  --output-dir=<dir>   Auto-named telemetry-watch-<timestamp>.jsonl in this directory
  --verbose, -v        Status lines on stderr
  --help, -h           Show this help

Record types (one JSON object per line):
  {"type":"meta",...}        capture header: vars, mode, start time
  {"type":"tick",...}        ts (wall ms), sessionTick, sessionTime, values
  {"type":"connection",...}  SDK connection edges

Example — the #938 incident-model capture:
  pnpm telemetry-watch --vars=PlayerIncidents,PlayerCarMyIncidentCount,PlayerTrackSurface,SessionFlags,IsOnTrack,OnPitRoad
`);
}

async function main(): Promise<void> {
  const { options, error } = parseWatchArgs(process.argv.slice(2));

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  if (error !== null) {
    console.error(`Error: ${error}`);
    console.error("Run with --help for usage.");
    process.exit(1);
  }

  // Resolve the sink. --output wins over --output-dir (same precedence as
  // telemetry-snapshot); neither means stdout. INIT_CWD keeps paths
  // relative to where the user typed the command, not the package dir
  // pnpm --filter runs in.
  const baseCwd = process.env.INIT_CWD || process.cwd();
  let fileStream: WriteStream | null = null;
  let outputPath: string | null = null;

  if (options.output) {
    outputPath = resolve(baseCwd, options.output);
  } else if (options.outputDir) {
    const dir = resolve(baseCwd, options.outputDir);
    mkdirSync(dir, { recursive: true });
    outputPath = join(dir, `${watchBaseName()}.jsonl`);
  }

  if (outputPath) {
    fileStream = createWriteStream(outputPath, { flags: "a" });
    console.error(`Recording to: ${outputPath}`);
  }

  const writeLine = (record: unknown): void => {
    const line = `${JSON.stringify(record)}\n`;

    if (fileStream) {
      fileStream.write(line);
    } else {
      process.stdout.write(line);
    }
  };

  const status = (message: string): void => {
    if (options.verbose) {
      console.error(message);
    }
  };

  // The SDK logger stays silent even under --verbose: consoleLogger writes
  // to stdout, which would corrupt JSONL in stdout mode. All CLI status
  // goes to stderr via status().
  const { controller } = createSDK(silentLogger);

  const startedAtMs = Date.now();
  let tickCount = 0;
  let prevValues: Record<string, unknown> | null = null;
  let lastConnected: boolean | null = null;
  let warnedMissing = false;

  writeLine(buildMetaRecord(new Date(startedAtMs), options.vars, options.mode));
  status(`Watching ${options.vars.join(", ")} (mode: ${options.mode}). Waiting for iRacing...`);

  controller.subscribe(SUBSCRIBER_ID, (telemetry, isConnected) => {
    const ts = Date.now();

    if (lastConnected === null || isConnected !== lastConnected) {
      lastConnected = isConnected;
      writeLine(buildConnectionRecord(ts, isConnected));
      status(isConnected ? "iRacing connected." : "iRacing disconnected.");
    }

    if (!telemetry) {
      return;
    }

    if (!warnedMissing) {
      warnedMissing = true;
      const missing = findMissingVars(telemetry, options.vars);

      if (missing.length > 0) {
        console.error(
          `Warning: not present in the first frame (recorded as null until they appear): ${missing.join(", ")}`,
        );
      }
    }

    const values = pickWatchValues(telemetry, options.vars);

    if (options.mode === "changes" && !watchValuesChanged(prevValues, values)) {
      return;
    }

    prevValues = values;
    tickCount += 1;
    writeLine(buildTickRecord(ts, telemetry, options.vars));
  });

  const shutdown = (): void => {
    controller.unsubscribe(SUBSCRIBER_ID);
    const summary = formatWatchSummary(tickCount, Date.now() - startedAtMs);

    if (fileStream) {
      fileStream.end(() => {
        console.error(summary);
        process.exit(0);
      });
    } else {
      console.error(summary);
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
```

- [ ] **Step 2: Add the package scripts**

In `packages/iracing-sdk/package.json`, after the `telemetry-snapshot` script line:

```json
"telemetry-snapshot": "node dist/cli/telemetry-snapshot.js",
"telemetry-watch": "node dist/cli/telemetry-watch.js"
```

In the root `package.json`, after the root `telemetry-snapshot` convenience script:

```json
"telemetry-snapshot": "pnpm --filter @iracedeck/iracing-sdk telemetry-snapshot -- --include-session --output-dir=local",
"telemetry-watch": "pnpm --filter @iracedeck/iracing-sdk telemetry-watch -- --output-dir=local"
```

- [ ] **Step 3: Build the package and smoke-test the CLI**

```bash
pnpm --dir "C:/Users/Niklas/Projects/iRaceDeck/ir-938" --filter @iracedeck/iracing-sdk build
node "C:/Users/Niklas/Projects/iRaceDeck/ir-938/packages/iracing-sdk/dist/cli/telemetry-watch.js" --help
node "C:/Users/Niklas/Projects/iRaceDeck/ir-938/packages/iracing-sdk/dist/cli/telemetry-watch.js"
```

Expected: help text prints and exits 0; the no-args run exits 1 with the `--vars` error. Then a brief stdout-mode run (no iRacing needed — it should emit the meta record and wait):

Run with a 3-second timeout and confirm the first line is the `{"type":"meta",...}` record:

```bash
node "C:/Users/Niklas/Projects/iRaceDeck/ir-938/packages/iracing-sdk/dist/cli/telemetry-watch.js" --vars=Speed
```

(Terminate after a few seconds; on Windows without iRacing the mock/native connect fails and the reconnect poll keeps the process alive — that IS the expected waiting behavior.)

- [ ] **Step 4: Full verification**

```bash
pnpm --dir "C:/Users/Niklas/Projects/iRaceDeck/ir-938" exec vitest run packages/iracing-sdk/src/cli/watch-core.test.ts
pnpm --dir "C:/Users/Niklas/Projects/iRaceDeck/ir-938" lint:fix
pnpm --dir "C:/Users/Niklas/Projects/iRaceDeck/ir-938" format:fix
cd "C:/Users/Niklas/Projects/iRaceDeck/ir-938" && set -o pipefail && pnpm build 2>&1 | tail -20
```

Expected: tests green, lint/format clean, full build exits 0 (check the exit code, not just the tail output). EPERM on `iracing_native.node` → deck-host app is running; ask Niklas to quit it.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-938" add packages/iracing-sdk/src/cli/telemetry-watch.ts packages/iracing-sdk/package.json package.json
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-938" commit -m "feat(sdk): add telemetry-watch CLI for full-rate capture (#938)"
```

---

### Task 3: Hand off the capture to Niklas

**Files:** none (checkpoint task).

- [ ] **Step 1: Verify the worktree is clean and tests/build are green** (re-run Task 2 Step 4 checks if anything changed since).

- [ ] **Step 2: Hand Niklas the capture instructions** — the exact command (run from the `ir-938` worktree root so `local/` resolves there):

```bash
pnpm telemetry-watch --vars=PlayerIncidents,PlayerCarMyIncidentCount,PlayerTrackSurface,SessionFlags,IsOnTrack,OnPitRoad
```

and the driving protocol from the spec: (a) lone off-track, wait clean; (b) off-track → gather for ~2 s → wall hit; (c) escalation into AI-car contact if possible; (d) one long sustained off-track; note the on-screen incident indication timing if possible. **STOP and wait** — do not start Phase 2 until the capture file is analyzed and the model is locked (checkpoint with Niklas if it deviates from the spec).

---

## Self-review notes

- Spec coverage: every Phase 1 spec bullet (CLI behavior, record shapes, modes, sinks, SIGINT summary, SDKController cadence, pure-helper testing, package scripts) maps to Task 1 or Task 2; the capture protocol is Task 3. Phase 2 is deliberately a separate plan, written after the capture analysis.
- Types/names are consistent between Task 1's exports and Task 2's imports.
- No placeholders; all code is complete.
