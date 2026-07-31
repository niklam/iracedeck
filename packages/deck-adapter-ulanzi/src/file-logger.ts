/**
 * File logging for the Ulanzi (UlanziStudio) adapter.
 *
 * Like Mirabox's Stream Dock host — and unlike Elgato, whose `streamDeck.logger`
 * owns a managed rotating `.log` file — the UlanziStudio host does NOT capture a
 * plugin's stdout/stderr to disk. Our Ulanzi logging goes through
 * `createConsoleLogger` (i.e. `console.*`), which the host discards, so the
 * "Enable debug logging" toggle (issue #609) would have nothing to capture for
 * support.
 *
 * `FileSink` fixes that by writing to `<plugin>/log/<YYYY.M.D>.log`.
 * `withFileSink` tees an existing `ILogger` to the sink, preserving the live
 * level gating and scope chaining of the wrapped console logger.
 */
import type { ILogger } from "@iracedeck/logger";
import { LogLevel } from "@iracedeck/logger";
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Per-day log files older than this many days are deleted on the sink's first write (issue #904). */
export const LOG_RETENTION_DAYS = 14;

/** Matches the per-day filenames this sink writes: `<YYYY.M.D>.log`, unpadded month/day. */
const LOG_FILE_PATTERN = /^(\d{4})\.(\d{1,2})\.(\d{1,2})\.log$/;

/**
 * Appends formatted log lines to a per-day file under `dir`.
 *
 * The filename matches the host convention `<YYYY.M.D>.log` with **unpadded**
 * month and day (e.g. `2026.5.31.log`, `2026.5.5.log`). Writes are synchronous
 * (`appendFileSync`) — debug logging is opt-in, so the volume is low and the
 * simplicity is worth more than streaming. The day rolls over automatically
 * because the target filename is recomputed on every write.
 *
 * The first write also prunes files older than `LOG_RETENTION_DAYS` (issue
 * #904) — without it, per-day files accumulate on user machines forever.
 */
export class FileSink {
  private ensuredDir = false;

  constructor(private readonly dir: string) {}

  /**
   * Append one line. Logging must never crash the plugin, so any I/O failure is
   * reported once to the console rather than thrown.
   */
  write(level: string, message: string): void {
    try {
      const now = new Date();

      if (!this.ensuredDir) {
        mkdirSync(this.dir, { recursive: true });
        this.ensuredDir = true;
        this.prune(now);
      }

      const file = join(this.dir, `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}.log`);
      appendFileSync(file, `${now.toISOString()} ${level} ${message}\n`);
    } catch (err) {
      // Avoid recursing through the logger that's failing; surface directly.
      console.error(`[Ulanzi FileSink] write failed: ${String(err)}`);
    }
  }

  /**
   * Delete per-day log files whose filename date is older than
   * `LOG_RETENTION_DAYS`. Runs once per sink (piggybacked on the first write's
   * directory ensure). Only names matching the exact `<YYYY.M.D>.log` pattern
   * are touched; the comparison is date-only, so a file exactly at the
   * retention boundary is kept for the whole day. Failures are swallowed the
   * same way write failures are — a stale log must never crash the plugin —
   * and per file, so one locked or undeletable entry doesn't stop the rest.
   */
  private prune(now: Date): void {
    try {
      const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - LOG_RETENTION_DAYS);

      for (const name of readdirSync(this.dir)) {
        const match = LOG_FILE_PATTERN.exec(name);

        if (!match) continue;

        const fileDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));

        if (fileDate >= cutoff) continue;

        try {
          unlinkSync(join(this.dir, name));
        } catch (err) {
          console.error(`[Ulanzi FileSink] prune of ${name} failed: ${String(err)}`);
        }
      }
    } catch (err) {
      console.error(`[Ulanzi FileSink] prune failed: ${String(err)}`);
    }
  }
}

/** Maps each log method to its threshold and file-level label. */
const LEVELS = [
  { method: "trace", threshold: LogLevel.Trace, label: "TRACE" },
  { method: "debug", threshold: LogLevel.Debug, label: "DEBUG" },
  { method: "info", threshold: LogLevel.Info, label: "INFO" },
  { method: "warn", threshold: LogLevel.Warn, label: "WARN" },
  { method: "error", threshold: LogLevel.Error, label: "ERROR" },
] as const;

/**
 * Wrap `base` so each call also writes to `sink`, gated by the same live `level`
 * resolver the wrapped logger uses. The base logger keeps owning console output;
 * this only adds the file tee. `withLevel` / `createScope` re-wrap so the file
 * tee survives chaining, and the scope prefix mirrors `createConsoleLogger`'s
 * `[scope] message` format.
 */
export function withFileSink(base: ILogger, scope: string, level: () => LogLevel, sink: FileSink): ILogger {
  const format = (message: string): string => (scope ? `[${scope}] ${message}` : message);

  const tee: Partial<Record<(typeof LEVELS)[number]["method"], (message: string) => void>> = {};

  for (const { method, threshold, label } of LEVELS) {
    tee[method] = (message: string) => {
      base[method](message);

      if (level() <= threshold) sink.write(label, format(message));
    };
  }

  return {
    trace: tee.trace!,
    debug: tee.debug!,
    info: tee.info!,
    warn: tee.warn!,
    error: tee.error!,
    withLevel: (newLevel: LogLevel) => withFileSink(base.withLevel(newLevel), scope, () => newLevel, sink),
    createScope: (childScope: string) =>
      withFileSink(base.createScope(childScope), scope ? `${scope}:${childScope}` : childScope, level, sink),
  };
}
