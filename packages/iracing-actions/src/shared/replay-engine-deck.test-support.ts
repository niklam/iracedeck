/**
 * The replay engine wired to deck-iracing as plugin-runtime's `initReplay`
 * wires it (#1467), for the tests of the actions that drive the engine. Every
 * read goes to `getController()` and every send to `getCommands()` at the time
 * of use, so a test file's `vi.mock("@iracedeck/deck-iracing")` reaches the
 * gate as it did when the gate read deck-iracing itself.
 *
 * A test configures the engine with `_configureReplayEngine({
 * ...deckReplayEngine, settings, ... })`; the call starts from the
 * unconfigured engine, so whatever it leaves out is the unconfigured default.
 */
import { getCommands, getController } from "@iracedeck/deck-iracing";
import type { ReplayEngineController, ReplayEngineEnv } from "@iracedeck/replay-engine";

/** The controller method `key`, looked up on `getController()` at each call. */
function onEachCall<K extends keyof ReplayEngineController>(key: K): ReplayEngineController[K] {
  return ((...args: unknown[]) => {
    const controller = getController();

    return (controller[key] as (...a: unknown[]) => unknown).apply(controller, args);
  }) as ReplayEngineController[K];
}

const deckController: ReplayEngineController = {
  getCurrentTelemetry: onEachCall("getCurrentTelemetry"),
  getSessionInfo: onEachCall("getSessionInfo"),
  getReplayState: onEachCall("getReplayState"),
  getConnectionStatus: onEachCall("getConnectionStatus"),
  noteReplayLeftForLive: onEachCall("noteReplayLeftForLive"),
  subscribe: onEachCall("subscribe"),
  unsubscribe: onEachCall("unsubscribe"),
};

/** The deck side of the engine's env: the controller, and the replay and camera commands. */
export const deckReplayEngine: Pick<ReplayEngineEnv, "controller" | "replay" | "camera"> = {
  controller: deckController,
  replay: () => getCommands().replay,
  camera: () => getCommands().camera,
};
