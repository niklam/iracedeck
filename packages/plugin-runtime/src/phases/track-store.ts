/**
 * Phase 2 (#1112): the per-track store the learned pit-lane landmarks persist
 * in — one file per TrackID under `%LOCALAPPDATA%\iRaceDeck\Track Data`,
 * shared by every deck host — with its exit flush and the bus subscription
 * that feeds it.
 *
 * It runs before the sim phase because the translator takes the store's
 * reader when it is constructed (`loadPitLaneLandmarks`), and after the core
 * phase because it needs the bus and a logger. Nothing reaches the file until
 * the translator accepts an edge on a live tick, which the host's connect at
 * the end of startup is what makes possible.
 */
import { initializeTrackStore, resolveTrackDataDirectory } from "@iracedeck/track-store";

import type { Core, TrackData } from "../types.js";

/**
 * The simulator the TrackIDs belong to, written to every track file's
 * envelope. This package chooses the sim (#1349), so it names it here.
 */
const TRACK_STORE_SIM = "iracing";

export function initTrackStore(core: Core): TrackData {
  // Not per ecosystem, unlike the settings and replay stores: a pit lane is a
  // fact about a track, and the store merges on every write, so two deck
  // hosts share one folder (spec decision 3).
  const directory = resolveTrackDataDirectory({ env: process.env });
  const store = initializeTrackStore({
    directory,
    sim: TRACK_STORE_SIM,
    logger: core.adapter.createLogger("TrackStore"),
  });

  // Writes are debounced (2 s, at most 10 s from the first unsaved sample),
  // so the last pit stop of a session would be lost without a synchronous
  // flush on the way out — the same flush the settings and replay stores get.
  process.on("exit", () => store.flushSync());

  // Every edge the translator accepts, from any car, is folded into the
  // track's file. The payload's summary is the translator's own view and is
  // not read: the store folds the raw sample with the same model.
  core.bus.subscribe("pitLane.landmarkLearned", (ev) => {
    store.recordSample(ev.data);
  });

  return { store, directory };
}
