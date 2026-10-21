/**
 * Test support for the Replay Control dial's stepping modes (#801): a fake of
 * the `io` the surface hands Lap, Session, Incident and Track Order, every member a
 * mock a test can set, so a mode is tested against the seam alone. Imported
 * only by tests; nothing in the plugin bundle reaches it.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { ReplayPosition } from "@iracedeck/replay-engine";
import type { LapStartListEntry, ReplaySessionStart, ReplaySessionStore } from "@iracedeck/replay-store";
import { type Mock, vi } from "vitest";

import type { ReplaySettledOutcome } from "../../shared/replay-command-gate.js";
import type { ReplayDialStepIo, ReplaySpeed } from "./replay-control-dial-mode.js";
import type { RecordStepResult, RecordStepSource } from "./replay-record-step.js";

/** A source over a recorded lap list for car 4 (car number 104) and a session list. */
export function recordSource(
  laps: LapStartListEntry[] | null,
  sessions: ReplaySessionStart[] | null,
  camCarIdx: number | undefined = 4,
): RecordStepSource {
  return {
    store: {
      laps: {
        listLapStarts: () => (laps === null ? { hit: false, reason: "no file" } : { hit: true, starts: laps }),
      },
      sessions: {
        list: () => (sessions === null ? { hit: false, reason: "no file" } : { hit: true, starts: sessions }),
      },
    } as unknown as ReplaySessionStore,
    scope: undefined,
    camCarIdx,
    carNumberRaw: (carIdx) => (carIdx === 4 ? 104 : null),
    lapApproachFrames: 60,
    lastSessionNum: 2,
  };
}

/** Laps 1, 2, 3 … of session 2 at `frames`, in the one instance {@link sessionsAt} records. */
export function lapsAt(frames: number[]): LapStartListEntry[] {
  return frames.map((frame, i) => ({ frame, lap: i + 1, sessionNum: 2, sessionUniqueId: 1 }));
}

/** Sessions 0, 1, 2 … of one instance at `frames`. */
export function sessionsAt(frames: number[]): ReplaySessionStart[] {
  return frames.map((frame, i) => ({ sessionNum: i, sessionUniqueId: 1, frame }));
}

/** The fake `io`, its members typed as the mocks they are. */
export type FakeStepIo = {
  [K in keyof ReplayDialStepIo]: ReplayDialStepIo[K] extends (...args: infer A) => infer R
    ? Mock<(...args: A) => R>
    : ReplayDialStepIo[K];
};

/** A fake `io`: a paused replay at frame 5000, no record, no search, bindings set, no jump under way. */
export function fakeStepIo(): FakeStepIo {
  const paused: ReplaySpeed = { speed: 0, slowMotion: false };
  const at: ReplayPosition = { frame: 5_000, time: 83.5, endFrame: 100_000, seeking: false };

  return {
    logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    liveSpeed: vi.fn((): ReplaySpeed => paused),
    telemetry: vi.fn((): TelemetryData | null => ({ IsReplayPlaying: true, ReplayFrameNum: 5_000 }) as TelemetryData),
    setSpeed: vi.fn((_owner: string, _target: ReplaySpeed) => true),
    pause: vi.fn((_owner: string) => true),
    position: vi.fn((): ReplayPosition | null => at),
    step: vi.fn((_owner: string, _direction: 1 | -1) => true),
    jumpTo: vi.fn((_owner: string, _frame: number) => true),
    recordJump: vi.fn((_owner: string, _frame: number) => Promise.resolve()),
    recordStep: vi.fn((): RecordStepResult => ({ hit: false, reason: "no store" })),
    recordSource: vi.fn(() => recordSource(null, null)),
    sessionInfo: vi.fn((): unknown => null),
    queueSearch: vi.fn(),
    isSearchRunning: vi.fn(() => false),
    pendingSearch: vi.fn((): number | null => null),
    tapBinding: vi.fn((_key: string) => Promise.resolve(true)),
    isBindingMissing: vi.fn((_keys: string | readonly string[]) => false),
    cancelCameraWalks: vi.fn(),
    jumpToMyCar: vi.fn(),
    isJumpUnderWay: vi.fn(() => false),
    waitForJumpsToSettle: vi.fn((): Promise<ReplaySettledOutcome> => Promise.resolve("settled")),
    isStillOnScreen: vi.fn(() => true),
    isSavedReplay: vi.fn(() => false),
  } as FakeStepIo;
}
