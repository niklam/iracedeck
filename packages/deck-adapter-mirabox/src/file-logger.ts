/**
 * File logging for the Mirabox (VSD Craft / Stream Dock) adapter.
 *
 * Unlike Elgato — whose `streamDeck.logger` owns a managed rotating `.log` file
 * under `<sdPlugin>/logs/` — the Stream Dock host does NOT capture a plugin's
 * stdout/stderr to disk. Our Mirabox logging goes through `createConsoleLogger`
 * (i.e. `console.*`), which the host discards, so the "Enable debug logging"
 * toggle (issue #609) would have nothing to capture for support.
 *
 * `FileSink` fixes that by writing to `<plugin>/log/<YYYY.M.D>.log` — the same
 * `log/` directory convention the host's own first-party plugins use, so a
 * support log lands where users (and maintainers) already look. `withFileSink`
 * tees an existing `ILogger` to the sink, preserving the live level gating and
 * scope chaining of the wrapped console logger.
 */
import type { ILogger } from "@iracedeck/logger";
import { LogLevel } from "@iracedeck/logger";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Appends formatted log lines to a per-day file under `dir`.
 *
 * The filename matches the host convention `<YYYY.M.D>.log` with **unpadded**
 * month and day (e.g. `2026.5.31.log`, `2026.5.5.log`) so our files sit
 * naturally alongside the host's own plugin logs. Writes are synchronous
 * (`appendFileSync`) — debug logging is opt-in, so the volume is low and the
 * simplicity is worth more than streaming. The day rolls over automatically
 * because the target filename is recomputed on every write.
 */
export class FileSink {
  private ensuredDir = false;

  constructor(private readonly dir: string) {}

  /**
   * Append one line. Logging must never crash the plugin, so any I/O failure
   * is reported once to the console rather than thrown.
   */
  write(level: string, message: string): void {
    try {
      if (!this.ensuredDir) {
        mkdirSync(this.dir, { recursive: true });
        this.ensuredDir = true;
      }

      const now = new Date();
      const file = join(this.dir, `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}.log`);
      appendFileSync(file, `${now.toISOString()} ${level} ${message}\n`);
    } catch (err) {
      // Avoid recursing through the logger that's failing; surface directly.
      console.error(`[VSD FileSink] write failed: ${String(err)}`);
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
 * Wrap `base` so each call also writes to `sink`, gated by the same live
 * `level` resolver the wrapped logger uses. The base logger keeps owning
 * console output (single source of console behaviour); this only adds the file
 * tee. `withLevel` / `createScope` re-wrap so the file tee survives chaining,
 * and the scope prefix mirrors `createConsoleLogger`'s `[scope] message` format.
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
