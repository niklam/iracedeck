/**
 * One reset for a test (#1467): nothing under way in any engine module, then
 * the engine configured with `overrides`. A test calls this wherever it resets
 * the engine, so no case can start on the previous case's overrides — the
 * pairing of a module reset with a reconfigure is not left to each file.
 */
import { _configureReplayEngine } from "./replay-engine-env.js";
import { _resetReplayEngine } from "./replay-engine-reset.js";

/** What a test configures the engine with: `_configureReplayEngine`'s overrides. */
export type ReplayEngineTestOverrides = Parameters<typeof _configureReplayEngine>[0];

/** Every engine module back to nothing under way, then the engine configured from the unconfigured default plus `overrides`. */
export function resetEngine(overrides: ReplayEngineTestOverrides = {}): void {
  _resetReplayEngine();
  _configureReplayEngine(overrides);
}
