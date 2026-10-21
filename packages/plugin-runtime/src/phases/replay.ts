/**
 * Phase 8 (#1467): the replay layer — the per-session replay store with its
 * exit flush and the bus subscriptions that feed it, and the replay engine,
 * configured once with what it needs from the deck layer (the SDK controller,
 * the replay and camera command surfaces, a logger) and the two settings it
 * reads, as closures read at the time of use, so a change in the Settings
 * window takes effect without re-wiring.
 */
import { getPluginPlatform } from "@iracedeck/deck-core";
import { getCommands } from "@iracedeck/deck-iracing";
import { configureReplayEngine } from "@iracedeck/replay-engine";
import { initializeReplaySessionStore, resolveReplayStoreDirectory } from "@iracedeck/replay-store";
import { getGlobalSettings } from "@iracedeck/settings";

import type { Core, Replay } from "../types.js";

export function initReplay(core: Core): Replay {
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

  // The per-session replay store (#1162, #1203, #1354, #1426): one file per SubSessionID under
  // %LOCALAPPDATA%\iRaceDeck\Replay\<ecosystem>, holding the replay markers, the lap
  // record, the greens, the session starts and the incidents. Fed the active session by the subscriber startServices wires beside the elevation
  // check; the actions read it synchronously through getReplaySessionStore().
  // Its writes are debounced like the settings store's, so it gets the same
  // synchronous flush on the way out.
  const replaySessionStore = initializeReplaySessionStore({
    directory: resolveReplayStoreDirectory({ platform: getPluginPlatform(), env: process.env }),
    logger: core.adapter.createLogger("ReplaySessionStore"),
  });

  process.on("exit", () => replaySessionStore.flushSync());

  // The translator's lap recorder (#1203) publishes each live lap start and lap
  // time; the store keeps them in the session's replay file for the fastest-lap
  // lookup. The store ignores an event whose subSessionId is not the open one.
  core.bus.subscribe("replay.lapStarted", (ev) => {
    replaySessionStore.laps.recordLapStart(ev.data);
  });
  core.bus.subscribe("replay.lapTimed", (ev) => {
    replaySessionStore.laps.recordLapTime(ev.data);
  });
  // The translator's green recorder (#1354) publishes the race start and every
  // caution restart; the store keeps them beside the laps for Jump to Race Start.
  core.bus.subscribe("replay.greenFlag", (ev) => {
    replaySessionStore.greens.record(ev.data);
  });
  // The translator's session and incident recorders (#1426) publish each session's
  // start and every incident; the store keeps them for Replay Control's session
  // steps and for comparing its incident searches with what was recorded.
  core.bus.subscribe("replay.sessionStarted", (ev) => {
    replaySessionStore.sessions.record(ev.data);
  });
  core.bus.subscribe("replay.incident", (ev) => {
    replaySessionStore.incidents.record(ev.data);
  });

  return { replayStore: replaySessionStore };
}
