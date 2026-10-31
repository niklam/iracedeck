/**
 * The replay engine wired to deck-iracing as plugin-runtime's `initReplay`
 * wires it (#1467), for the tests of the actions that drive the engine. Every
 * read goes to `getController()` and every send to `getCommands()` at the time
 * of use, so a test file's `vi.mock("@iracedeck/deck-iracing")` reaches the
 * gate as it did when the gate read deck-iracing itself.
 *
 * A test file takes its pair of calls from {@link engineOverDeck}, once, with
 * what every call must carry (its settings bridge, where it has one), and then
 * only ever resets through `resetEngine`: each engine module back to nothing
 * under way, and the engine configured again, in one call.
 */
import { getCommands, getController } from "@iracedeck/deck-iracing";
import type { ILogger } from "@iracedeck/logger";
import type { ReplayEngineController, ReplayEngineEnv } from "@iracedeck/replay-engine";
import { _configureReplayEngine, type ReplayEngineTestOverrides, resetEngine } from "@iracedeck/replay-engine/testing";

/**
 * An engine logger whose `ReplayControl` scope is `logger` itself (#1467):
 * the Jump to Fastest Lap and Jump to Race Start presses moved into the engine
 * and log to that scope, and a Replay Control test reads their lines on the action's logger,
 * as in the plugin both read as `ReplayControl`. Every other scope is the one
 * `logger` creates, so the gate's lines stay out of it.
 */
export function replayControlScopeOn(logger: ILogger): ILogger {
  return {
    ...logger,
    createScope: (scope: string) => (scope === "ReplayControl" ? logger : logger.createScope(scope)),
  };
}

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

/** A test file's two ways to set the engine up over its deck-iracing mocks. */
export interface EngineOverDeck {
  /** Configure the engine: the deck, the file's `base`, then `extra` for a case. Nothing is reset. */
  configureEngine(extra?: ReplayEngineTestOverrides): void;
  /** Reset every engine module, then configure as {@link EngineOverDeck.configureEngine} does. */
  resetEngine(extra?: ReplayEngineTestOverrides): void;
}

/**
 * The engine over the deck mocks, with `base` (the file's settings bridge) on
 * every call. A call starts from the unconfigured engine, so `extra` replaces
 * one read or the replay for a case and everything else is restated.
 */
export function engineOverDeck(base: ReplayEngineTestOverrides = {}): EngineOverDeck {
  return {
    configureEngine: (extra = {}) => _configureReplayEngine({ ...deckReplayEngine, ...base, ...extra }),
    resetEngine: (extra = {}) => resetEngine({ ...deckReplayEngine, ...base, ...extra }),
  };
}
