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
