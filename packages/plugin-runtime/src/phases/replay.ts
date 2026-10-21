/**
 * Phase 8 (#1467): the replay engine, configured once with what it needs from
 * the deck layer — the SDK controller, the replay and camera command surfaces,
 * a logger — and the two settings it reads, as closures read at the time of
 * use, so a change in the Settings window takes effect without re-wiring.
 */
import { getCommands } from "@iracedeck/deck-iracing";
import { configureReplayEngine } from "@iracedeck/replay-engine";
import { getGlobalSettings } from "@iracedeck/settings";

import type { Core } from "../types.js";

export function initReplay(core: Core): void {
  configureReplayEngine({
    controller: core.controller,
    // Reached on each use, as the gate always did, rather than captured here.
    replay: () => getCommands().replay,
    camera: () => getCommands().camera,
    now: () => Date.now(),
    logger: core.adapter.createLogger("ReplayEngine"),
    settings: {
      replayJumpPlayback: () => (getGlobalSettings() as Record<string, unknown>).replayJumpPlayback,
      fastestLapSearchDelayMs: () => (getGlobalSettings() as Record<string, unknown>).fastestLapSearchDelayMs,
    },
  });
}
