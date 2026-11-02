/**
 * The engine's own feed of telemetry to the speed state (#1427).
 *
 * The pending speed (`replay-speed-state.ts`) ends on the first sample that
 * shows it, and the remembered speed follows telemetry. Both need every tick,
 * not only the ones a surface happens to read: a pending speed nobody read
 * past would stand for its whole hold and mask a change made from iRacing's
 * own replay bar after telemetry had shown the send, and the remembered speed
 * would miss a speed set while no Replay Control context was on screen. So
 * the engine subscribes to the controller itself, started and replaced by
 * `configureReplayEngine` beside the watch for leaving the replay
 * (`replay-left.ts`), and hands the speed state every tick that is in a
 * replay — the controller's debounced replay state, read as the leave watch
 * reads it. Out of a replay `ReplayPlaySpeed` says nothing about a replay, so
 * those ticks, and ticks with no telemetry or no connection, are not fed.
 *
 * The controller delivers a tick only when `SessionTick` advances, so a paused
 * replay may deliver none; a read of the live speed settles the pending speed
 * as a tick does (`resolveLiveSpeed`).
 */
import { replaySpeedFromTelemetry, type TelemetryData } from "@iracedeck/iracing-sdk";

import { now } from "./engine-clock.js";
import type { ReplayEngineController } from "./replay-engine-env.js";
import { noteTelemetrySpeed } from "./replay-speed-state.js";

/** The id the feed subscribes to the controller under. */
export const REPLAY_SPEED_FEED_SUBSCRIBER_ID = "replay-engine-speed";

/** The controller the feed stands over; null when none does. */
let fed: ReplayEngineController | null = null;

function inReplay(controller: ReplayEngineController): boolean {
  try {
    return controller.getReplayState().inReplay;
  } catch {
    return false;
  }
}

function onTick(controller: ReplayEngineController, telemetry: TelemetryData | null, isConnected: boolean): void {
  if (fed !== controller || !isConnected || telemetry === null) return;

  const sample = replaySpeedFromTelemetry(telemetry);

  if (sample === null || !inReplay(controller)) return;

  noteTelemetrySpeed(sample, now());
}

/** Feeds `controller`'s ticks to the speed state, replacing any feed already standing, so there is one per process. */
export function startReplaySpeedFeed(controller: ReplayEngineController): void {
  stopReplaySpeedFeed();

  fed = controller;
  controller.subscribe(REPLAY_SPEED_FEED_SUBSCRIBER_ID, (telemetry, isConnected) =>
    onTick(controller, telemetry, isConnected),
  );
}

/** Stops the feed, if one stands. */
export function stopReplaySpeedFeed(): void {
  const controller = fed;

  if (controller === null) return;

  fed = null;

  try {
    controller.unsubscribe(REPLAY_SPEED_FEED_SUBSCRIBER_ID);
  } catch {
    // A controller that cannot unsubscribe has nothing more to deliver to a feed that no longer stands.
  }
}

/** @internal For tests: stops the feed. */
export function _resetReplaySpeedFeed(): void {
  stopReplaySpeedFeed();
}
