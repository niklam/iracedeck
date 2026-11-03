/**
 * Configuring the engine (#1467): the env, then the two subscriptions over its
 * controller — the watch for leaving the replay (`replay-left.ts`) and the
 * speed state's tick feed (`replay-speed-feed.ts`, #1427). A module of its own
 * because the env cannot import either: both read the engine clock, which
 * reads the env.
 */
import { type ReplayEngineEnv, setReplayEngineEnv } from "./replay-engine-env.js";
import { startReplayLeftWatch, stopReplayLeftWatch } from "./replay-left.js";
import { startReplaySpeedFeed, stopReplaySpeedFeed } from "./replay-speed-feed.js";

/**
 * Inject what the engine reads and sends through. Called once, by
 * plugin-runtime's `initReplay` phase. A second call replaces the watch and
 * the feed over the controller rather than adding to them, so each departure
 * is emitted once and each tick fed once.
 */
export function configureReplayEngine(next: ReplayEngineEnv): void {
  stopReplayLeftWatch();
  stopReplaySpeedFeed();
  setReplayEngineEnv(next);

  if (next.controller !== null) {
    startReplayLeftWatch(next.controller);
    startReplaySpeedFeed(next.controller);
  }
}
