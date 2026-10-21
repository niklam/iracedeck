/**
 * What the replay engine reads and sends through (#1467): one env, injected
 * once by plugin-runtime's `initReplay` phase, so the engine depends on the
 * sim SDK's types and on nothing in the deck layer or the settings. It
 * replaces the gate's `ReplayGateEnv` and the search queue's env, and
 * `_configureReplayEngine` replaces their test hooks.
 *
 * Until it is configured the engine reads nothing (no telemetry, no replay
 * on screen, connected) and refuses to send.
 */
import type { ReplayPosMode, SDKController, TelemetryData } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";

/** The replay commands the gate sends; the `replay` of deck-iracing's `getCommands()` is one. */
export interface ReplayCommandSurface {
  setPlaySpeed(speed: number, slowMotion?: boolean): boolean;
  setPlayPosition(mode: ReplayPosMode, frameNumber: number): boolean;
  play(): boolean;
  pause(): boolean;
  nextFrame(): boolean;
  prevFrame(): boolean;
  goToStart(): boolean;
  goToEnd(): boolean;
  nextLap(): boolean;
  prevLap(): boolean;
  nextSession(): boolean;
  prevSession(): boolean;
  nextIncident(): boolean;
  prevIncident(): boolean;
}

/** The camera command the engine sends; `getCommands().camera` is one. */
export interface ReplayCameraSurface {
  switchNum(carNum: number, group: number, camera: number): boolean;
}

/** The part of the SDK controller the engine reads. */
export type ReplayEngineController = Pick<
  SDKController,
  | "getCurrentTelemetry"
  | "getSessionInfo"
  | "getReplayState"
  | "getConnectionStatus"
  | "noteReplayLeftForLive"
  | "subscribe"
  | "unsubscribe"
>;

/**
 * The settings the engine reads, as closures read at the time of use, so a
 * change in the Settings window takes effect without re-wiring. Raw values:
 * each reader sanitises its own.
 */
export interface ReplayEngineSettings {
  replayJumpPlayback(): unknown;
  fastestLapSearchDelayMs(): unknown;
}

/** Everything the engine is given. */
export interface ReplayEngineEnv {
  /** The SDK controller; null until configured. */
  controller: ReplayEngineController | null;
  /** The replay broadcast surface. Only the gate sends through it. */
  replay(): ReplayCommandSurface;
  camera(): ReplayCameraSurface;
  /** The engine clock: every engine module reads time here, never `Date.now()`. */
  now(): number;
  /** The engine's root logger; modules scope their own with {@link engineLogger}. */
  logger: ILogger;
  settings: ReplayEngineSettings;
}

/** The reads the engine derives from the controller, each catching a throwing one. */
export interface ReplayEngineReads {
  /** A fresh telemetry reading (a native read), or null. */
  readTelemetry(): TelemetryData | null;
  /** Whether a replay is on screen: the controller's debounced replay state (#1324). */
  inReplay(): boolean;
  /** Whether the SDK is connected to the sim. */
  connected(): boolean;
  /** Tells the debounced replay state that the plugin itself left the replay for live (#1324). */
  leftForLive(): void;
}

function notConfigured(): never {
  throw new Error("replay engine not configured");
}

const UNCONFIGURED: ReplayEngineEnv = {
  controller: null,
  replay: notConfigured,
  camera: notConfigured,
  now: () => Date.now(),
  logger: silentLogger,
  settings: { replayJumpPlayback: () => undefined, fastestLapSearchDelayMs: () => undefined },
};

let env: ReplayEngineEnv = UNCONFIGURED;

/** The reads derived from whatever controller the env holds at the time of the read. */
const derivedReads: ReplayEngineReads = {
  readTelemetry: () => {
    try {
      return env.controller?.getCurrentTelemetry() ?? null;
    } catch {
      return null;
    }
  },
  inReplay: () => {
    try {
      return env.controller?.getReplayState().inReplay ?? false;
    } catch {
      return false;
    }
  },
  connected: () => {
    try {
      return env.controller?.getConnectionStatus() ?? true;
    } catch {
      return true;
    }
  },
  leftForLive: () => {
    try {
      env.controller?.noteReplayLeftForLive();
    } catch {
      // No controller: nothing reads the replay state either.
    }
  },
};

let reads: ReplayEngineReads = derivedReads;

/** Scoped loggers, per root logger, so a reconfigure scopes under the new one. */
let scopedLoggers = new WeakMap<ILogger, Map<string, ILogger>>();

/** Inject what the engine reads and sends through. Called once, by plugin-runtime's `initReplay` phase. */
export function configureReplayEngine(next: ReplayEngineEnv): void {
  env = next;
  reads = derivedReads;
}

/**
 * @internal For tests: configure the engine from the unconfigured default plus
 * `overrides`, so overrides never accumulate across calls. A
 * {@link ReplayEngineReads} key replaces the read the controller would give.
 */
export function _configureReplayEngine(overrides: Partial<ReplayEngineEnv> & Partial<ReplayEngineReads>): void {
  const { readTelemetry, inReplay, connected, leftForLive, ...envOverrides } = overrides;
  const readOverrides: Partial<ReplayEngineReads> = { readTelemetry, inReplay, connected, leftForLive };

  env = { ...UNCONFIGURED, ...definedOnly(envOverrides) };
  reads = { ...derivedReads, ...definedOnly(readOverrides) };
}

/** @internal For tests: back to the unconfigured engine. */
export function _resetReplayEngineEnv(): void {
  env = UNCONFIGURED;
  reads = derivedReads;
  scopedLoggers = new WeakMap();
}

/** What the engine was given. */
export function engineEnv(): ReplayEngineEnv {
  return env;
}

/** The controller reads, or a test's overrides of them. */
export function engineReads(): ReplayEngineReads {
  return reads;
}

/** A scope of the engine's logger, created once per scope name and root logger. */
export function engineLogger(scope: string): ILogger {
  const root = env.logger;
  let scopes = scopedLoggers.get(root);

  if (!scopes) {
    scopes = new Map();
    scopedLoggers.set(root, scopes);
  }

  let logger = scopes.get(scope);

  if (!logger) {
    logger = root.createScope(scope);
    scopes.set(scope, logger);
  }

  return logger;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
