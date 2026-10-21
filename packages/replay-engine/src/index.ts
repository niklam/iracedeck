/**
 * @iracedeck/replay-engine (#1467): the iRacing replay engine, injected once
 * by plugin-runtime's `initReplay` phase.
 */
export {
  _configureReplayEngine,
  _resetReplayEngineEnv,
  configureReplayEngine,
  engineEnv,
  engineLogger,
  engineReads,
  type ReplayCameraSurface,
  type ReplayCommandSurface,
  type ReplayEngineController,
  type ReplayEngineEnv,
  type ReplayEngineReads,
  type ReplayEngineSettings,
} from "./replay-engine-env.js";
