/**
 * Test support (#1467): the engine's watch for leaving the replay over a
 * stand-in controller, which a test ticks itself as `SDKController`'s poll
 * would. Never imported by production code.
 */
import type { ReplayState, TelemetryData } from "@iracedeck/iracing-sdk";
import { type Mock, vi } from "vitest";

import type { ReplayEngineController } from "./replay-engine-env.js";
import { startReplayLeftWatch } from "./replay-left.js";

/** What the stand-in controller reads. */
export interface ReplayLeftControllerReads {
  /** The debounced replay state: `steppedReplayState(...).getReplayState`, or a plain flag. */
  replayState(): Pick<ReplayState, "inReplay">;
  /** The telemetry a tick delivers and a fresh read returns. */
  telemetry(): TelemetryData | null;
  /** Whether the controller reads connected. Default: always. */
  connected?(): boolean;
}

/** A stand-in controller with the watch started over it. */
export interface WatchedReplayController {
  readonly controller: ReplayEngineController;
  readonly subscribe: Mock<
    (id: string, callback: (telemetry: TelemetryData | null, connected: boolean) => void) => void
  >;
  readonly unsubscribe: Mock<(id: string) => void>;
  /** One tick of the controller's poll: `telemetry` and `connected` default to the reads'. */
  tick(telemetry?: TelemetryData | null, connected?: boolean): void;
}

/** A stand-in controller over `reads`, with nothing started. Its `subscribe` delivers at once, as the real one does. */
export function replayLeftController(reads: ReplayLeftControllerReads): WatchedReplayController {
  let callback: ((telemetry: TelemetryData | null, connected: boolean) => void) | null = null;
  const connected = (): boolean => reads.connected?.() ?? true;
  const subscribe = vi.fn((_id: string, cb: (telemetry: TelemetryData | null, connected: boolean) => void) => {
    callback = cb;
    cb(reads.telemetry(), connected());
  });
  const unsubscribe = vi.fn((_id: string) => {
    callback = null;
  });
  const controller = {
    getCurrentTelemetry: () => reads.telemetry(),
    getSessionInfo: () => null,
    getReplayState: () => reads.replayState() as ReplayState,
    getConnectionStatus: connected,
    noteReplayLeftForLive: () => {},
    subscribe,
    unsubscribe,
  } as unknown as ReplayEngineController;

  return {
    controller,
    subscribe,
    unsubscribe,
    tick: (telemetry = reads.telemetry(), isConnected = connected()) => callback?.(telemetry, isConnected),
  };
}

/** A stand-in controller over `reads` with the engine's watch started over it. `resetEngine` stops it. */
export function watchReplayLeft(reads: ReplayLeftControllerReads): WatchedReplayController {
  const watched = replayLeftController(reads);

  startReplayLeftWatch(watched.controller);

  return watched;
}
