/**
 * Configuring the engine (#1467): the env, then the watch for leaving the
 * replay over its controller (`replay-left.ts`). A module of its own because
 * the env cannot import the watch: the watch reads the engine clock and the
 * position state, which read the env.
 */
import { type ReplayEngineEnv, setReplayEngineEnv } from "./replay-engine-env.js";
import { startReplayLeftWatch, stopReplayLeftWatch } from "./replay-left.js";

/**
 * Inject what the engine reads and sends through. Called once, by
 * plugin-runtime's `initReplay` phase. A second call replaces the watch over
 * the controller rather than adding one, so each departure is emitted once.
 */
export function configureReplayEngine(next: ReplayEngineEnv): void {
  stopReplayLeftWatch();
  setReplayEngineEnv(next);

  if (next.controller !== null) startReplayLeftWatch(next.controller);
}
