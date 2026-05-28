/**
 * Dev diagnostic (issue #603): dump the previous + current telemetry tick to
 * disk whenever the player's computed race position changes, so a real race can
 * be diffed offline to find why the order shifted (a quitter, a pit-lane remap,
 * a lapped car, …).
 *
 * Gated at the call site by the `__FEATURE_TELEMETRY_POSITION_DUMP__` build flag
 * (default `false` in both committed `platform-features.json` → tree-shaken out
 * of production by `@rollup/plugin-replace` + terser, so this module's
 * `node:fs` imports never reach a shipped bundle). Enable locally via
 * `feature-flags.local.json`.
 *
 * Files: `<SessionUniqueID>_<SessionTick>.json` under the OS temp dir, one per
 * tick — so the previous/current pair sorts adjacently and a whole session is
 * in order. Writes are async and fire-and-forget; they never block the 60 Hz
 * tick loop, and a failure logs and is swallowed.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where dumps land — resolved lazily (not at module top level) so the whole
 * module, including its `node:fs`/`node:os` imports, tree-shakes out of
 * production: a top-level `join(tmpdir(), …)` would be treated as a side effect
 * and kept even when the only entry point is eliminated by the `if (false)`
 * gate. The full path is logged on each write so it's easy to find.
 */
let dumpDir: string | null = null;
let dirReady = false;

function getDumpDir(): string {
  return (dumpDir ??= join(tmpdir(), "iracedeck-pos-dumps"));
}

/**
 * Fire-and-forget dump of the previous + current tick. Never throws — failures
 * are logged. The previous tick is skipped when unavailable (first tick after
 * connect).
 */
export function dumpPositionChange(previous: TelemetryData | null, current: TelemetryData, logger: ILogger): void {
  void writeBoth(previous, current, logger);
}

async function writeBoth(previous: TelemetryData | null, current: TelemetryData, logger: ILogger): Promise<void> {
  try {
    if (!dirReady) {
      await mkdir(getDumpDir(), { recursive: true });
      dirReady = true;
    }

    await Promise.all([writeTick(current, logger), previous ? writeTick(previous, logger) : Promise.resolve()]);
  } catch (err) {
    logger.error(`Telemetry position-dump failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function writeTick(telemetry: TelemetryData, logger: ILogger): Promise<void> {
  const sessionId = typeof telemetry.SessionUniqueID === "number" ? telemetry.SessionUniqueID : 0;
  const tick = typeof telemetry.SessionTick === "number" ? telemetry.SessionTick : 0;
  // Zero-pad the tick so the files sort lexically in tick order.
  const file = join(getDumpDir(), `${sessionId}_${String(tick).padStart(9, "0")}.json`);

  await writeFile(file, JSON.stringify(telemetry, null, 2), "utf-8");
  logger.debug(`Telemetry dumped: ${file}`);
}
