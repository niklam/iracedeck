/**
 * The engine set up for its own tests of the lap presses (#1467): a fake SDK
 * controller over the reads a case replaces, the replay and camera a case
 * hands it, a spy logger per scope and the settings, with every engine module
 * reset first (`resetEngine`). Engine-local; never imported by production
 * code.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { type Mock, vi } from "vitest";

import type {
  ReplayCameraSurface,
  ReplayCommandSurface,
  ReplayEngineController,
  ReplayEngineReads,
  ReplayEngineSettings,
} from "./replay-engine-env.js";
import { resetEngine } from "./replay-engine-reset.test-support.js";
import type { SteppedReplayState } from "./replay-state.test-support.js";

/** A logger whose every level is a spy. */
export type SpyLogger = ILogger & {
  trace: Mock<(message: string) => void>;
  debug: Mock<(message: string) => void>;
  info: Mock<(message: string) => void>;
  warn: Mock<(message: string) => void>;
  error: Mock<(message: string) => void>;
};

/** A logger that records every line; each scope it creates is another one. */
export function spyLogger(): SpyLogger {
  const logger: SpyLogger = {
    trace: vi.fn<(message: string) => void>(),
    debug: vi.fn<(message: string) => void>(),
    info: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
    withLevel: () => logger,
    createScope: () => spyLogger(),
  };

  return logger;
}

/**
 * The reads a test's controller gives: telemetry and session info, which a
 * case replaces at will, and the debounced replay state stepped from them
 * (`withSteppedReplayState`), which a case steps itself to sight a replay tick.
 */
export type TestControllerReads = {
  getCurrentTelemetry: () => TelemetryData | null;
  getSessionInfo: () => unknown;
} & SteppedReplayState;

export interface TestEngineOptions {
  /** The controller the engine reads, through its members at every call. */
  readonly controller: TestControllerReads;
  readonly replay?: ReplayCommandSurface;
  readonly camera?: ReplayCameraSurface;
  /** The two settings, read at the time of use. Omitted, each reads undefined (its default). */
  readonly settings?: Partial<ReplayEngineSettings>;
  /** Reads that replace the controller's for the rest of the engine: the gate's replay on screen, say. */
  readonly reads?: Partial<ReplayEngineReads>;
}

/** What a test reads back from the engine it configured. */
export interface TestEngine {
  /** The engine's `ReplayControl` scope: every line the lap presses and walks log. */
  readonly logger: SpyLogger;
}

/**
 * Every engine module reset, then the engine configured over `options`. The
 * controller's connection reads connected, and its subscriptions record and
 * deliver nothing: these presses read the controller fresh.
 */
export function configureTestEngine(options: TestEngineOptions): TestEngine {
  const { controller: reads, replay, camera, settings, reads: readOverrides } = options;
  const controller: ReplayEngineController = {
    getCurrentTelemetry: () => reads.getCurrentTelemetry(),
    getSessionInfo: () => reads.getSessionInfo() as ReturnType<ReplayEngineController["getSessionInfo"]>,
    getReplayState: (nowMs?: number) => reads.getReplayState(nowMs),
    noteReplayLeftForLive: (nowMs?: number) => reads.noteReplayLeftForLive(nowMs),
    getConnectionStatus: () => true,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  };
  const logger = spyLogger();
  const root: SpyLogger = {
    ...spyLogger(),
    createScope: (scope) => (scope === "ReplayControl" ? logger : spyLogger()),
  };

  resetEngine({
    controller,
    replay: replay === undefined ? undefined : () => replay,
    camera: camera === undefined ? undefined : () => camera,
    logger: root,
    settings: {
      replayJumpPlayback: () => undefined,
      fastestLapSearchDelayMs: () => undefined,
      ...settings,
    },
    ...readOverrides,
  });

  return { logger };
}
