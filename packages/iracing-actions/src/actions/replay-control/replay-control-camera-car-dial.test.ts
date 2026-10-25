/**
 * The Replay Control dial's Car # and Position modes (#1448) against the real
 * replay engine: the dial surface over the engine configured on the deck
 * mocks and `fakeReplay`, with the camera switch going out as the action
 * sends it (`camera.switchNum`). The *Testing* section of
 * `docs/superpowers/specs/2026-10-18-issue-1448-replay-dial-camera-car-modes.md`:
 * on a quiet replay a turn switches at once; behind a Replay Markers jump it
 * switches once the jump has landed on its frame and ended, from the car on
 * camera then; behind a search it switches at once; a fastest-lap walk is
 * interrupted, never cancelled, and a marker jump's run is left standing; a
 * second turn while one waits replaces it.
 *
 * The modes' targets and views are `replay-control-camera-car-modes.test.ts`'s;
 * the waiter itself is the engine's (`camera-switch-waiter.test.ts`).
 */
import { getCarNumberRawFromSessionInfo, type SessionInfo, type TelemetryData } from "@iracedeck/iracing-sdk";
import {
  claimReplayCursor,
  currentReplayCursorOwner,
  FASTEST_LAP_WALK_OWNER,
  isReplayJumpSequenceOpen,
  pressReplayCommand,
  type RecordStepSource,
  type ReplayJumpOutcome,
} from "@iracedeck/replay-engine";
import { type FakeReplay, fakeReplay, withSteppedReplayState } from "@iracedeck/replay-engine/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { engineOverDeck } from "../../shared/replay-engine-deck.test-support.js";
import { jumpToMarkerFrame } from "../replay-markers/replay-markers-ops.js";
import { ReplayControlDialSettings } from "./replay-control-dial-settings.js";
import { ReplayControlDialSurface } from "./replay-control-dial-surface.js";

vi.mock("@iracedeck/deck-iracing", () => ({ getCommands: vi.fn() }));

vi.mock("@iracedeck/deck-core", async () => {
  // The real hold preview, release classifier and throttle, by path (the dial surface test's pattern).
  const dialGesture = await vi.importActual<typeof import("../../../../deck-core/src/dial-gesture.js")>(
    "../../../../deck-core/src/dial-gesture.js",
  );
  const throttle = await vi.importActual<typeof import("../../../../deck-core/src/icon-update-throttle.js")>(
    "../../../../deck-core/src/icon-update-throttle.js",
  );

  return {
    createHoldPreview: dialGesture.createHoldPreview,
    NOOP_HOLD_PREVIEW: dialGesture.NOOP_HOLD_PREVIEW,
    classifyDialRelease: dialGesture.classifyDialRelease,
    IconUpdateThrottle: throttle.IconUpdateThrottle,
    getDualPressThresholdMs: () => 500,
    applyBindingWarning: (content: string) => content,
    escapeXml: (str: string) => str,
    svgToDataUri: (svg: string) => svg,
  };
});

vi.mock("../../shared/replay-busy-indicator.js", () => ({
  registerReplayBusySurface: vi.fn(() => () => {}),
  getReplayBusyLook: vi.fn(() => ({ kind: "rest" })),
}));

vi.mock("@iracedeck/replay-store", () => ({
  getReplaySessionStore: vi.fn(),
  isReplaySessionStoreInitialized: vi.fn(() => false),
  // Replay Markers' windows, which the marker jump's module reads.
  MARKER_DEDUPE_FRAMES: 60,
  MARKER_DELETE_WINDOW_FRAMES: 60,
}));

vi.mock("@iracedeck/settings", () => ({
  getGlobalColors: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({})),
}));

const { configureEngine, resetEngine } = engineOverDeck();

configureEngine();

/** Where the replay is when a jump is pressed. */
const START = 100_000;
/** Where the marker jump lands. */
const TARGET = 300_000;
/** The car on camera at the turn. */
const CAMERA_AT_TURN = 4;

/**
 * A saved replay's session info (the race order is the replay's own there):
 * #3 (carIdx 1), #12 (2), #42 (4), #77 (7), #94 (9). Each car's raw number is
 * its carIdx plus 100, so a `switchNum` names the car it puts on camera.
 */
const SESSION_INFO = {
  WeekendInfo: { SimMode: "replay" },
  DriverInfo: {
    Drivers: [
      { CarIdx: 1, CarNumber: "3", CarNumberRaw: 101, UserName: "a" },
      { CarIdx: 2, CarNumber: "12", CarNumberRaw: 102, UserName: "b" },
      { CarIdx: 4, CarNumber: "42", CarNumberRaw: 104, UserName: "c" },
      { CarIdx: 7, CarNumber: "77", CarNumberRaw: 107, UserName: "d" },
      { CarIdx: 9, CarNumber: "94", CarNumberRaw: 109, UserName: "e" },
    ],
  },
};

/** #12 leads, #42 second, #3 third, #94 fourth, #77 last. */
const ORDER = [0, 3, 1, 0, 2, 0, 0, 5, 0, 4];

type CameraCarMode = "car-number" | "race-position";

/** Where a clockwise and a counter-clockwise turn go from each car, by carIdx, in each mode. */
const CLOCKWISE: Record<CameraCarMode, Record<number, number>> = {
  // The lower number.
  "car-number": { 1: 9, 2: 1, 4: 2, 7: 4, 9: 7 },
  // The position above.
  "race-position": { 1: 4, 2: 7, 4: 2, 7: 9, 9: 1 },
};
const COUNTER_CLOCKWISE: Record<CameraCarMode, Record<number, number>> = {
  "car-number": { 1: 2, 2: 4, 4: 7, 7: 9, 9: 1 },
  "race-position": { 1: 9, 2: 4, 4: 1, 7: 2, 9: 7 },
};

const MODES: CameraCarMode[] = ["car-number", "race-position"];

/** Something the test saw happen, with the replay's state at that moment. */
interface Seen {
  readonly what: string;
  readonly busy: boolean;
  readonly open: boolean;
  readonly frame: number;
}

describe("the Replay Control dial's Car # and Position against a real replay (#1448)", () => {
  let sim: FakeReplay;
  let camCarIdx = CAMERA_AT_TURN;
  let seen: Seen[] = [];
  const camera = { switchNum: vi.fn<(carNum: number, group: number, cam: number) => boolean>(() => true) };
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    createScope: vi.fn(() => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  };

  function note(what: string): void {
    seen.push({ what, busy: sim.busy(), open: isReplayJumpSequenceOpen(), frame: sim.frame() });
  }

  /** The fake's telemetry, with the camera's car. */
  function read(): TelemetryData {
    return { ...sim.telemetry(), CamCarIdx: camCarIdx } as TelemetryData;
  }

  const controller = withSteppedReplayState({
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    getCurrentTelemetry: (): TelemetryData | null => read(),
    // The fixture holds only the fields the dial reads.
    getSessionInfo: (): SessionInfo | null => SESSION_INFO as unknown as SessionInfo,
    getConnectionStatus: () => true,
  });

  const recordSource = (telemetry: TelemetryData | null): RecordStepSource => ({
    store: null,
    scope: undefined,
    camCarIdx: telemetry?.CamCarIdx,
    carNumberRaw: (carIdx) => getCarNumberRawFromSessionInfo(SESSION_INFO, carIdx),
    lapApproachFrames: 60,
    lastSessionNum: null,
  });

  function makeSurface(): ReplayControlDialSurface {
    return new ReplayControlDialSurface({
      logger: logger as never,
      inReplay: () => controller.getReplayState().inReplay,
      telemetry: () => read(),
      jumpToLive: vi.fn(),
      jumpToRaceStart: vi.fn(),
      canJumpToRaceStart: () => true,
      jumpToMyCar: vi.fn(),
      canJumpToMyCar: () => true,
      refreshKeys: vi.fn(),
      replayState: (nowMs) => controller.getReplayState(nowMs),
      sessionInfo: () => SESSION_INFO,
      recordSource,
      tapBinding: vi.fn(() => Promise.resolve(true)),
      isBindingMissing: () => false,
      // As the action sends it.
      switchToCarNumber: (carNumberRaw) => camera.switchNum(carNumberRaw, 0, 0),
      racePositions: () => ORDER,
    });
  }

  function dialContext(id = "dial-1") {
    return {
      id,
      isKey: () => false,
      isDial: () => true,
      dialCanvas: () => ({ id: "sd-plus-strip", width: 200, height: 100 }) as const,
      setDialCanvas: vi.fn((_uri: string) => Promise.resolve()),
      setImage: vi.fn((_svg: string) => Promise.resolve()),
      setTriggerDescription: vi.fn((_d: unknown) => Promise.resolve()),
    };
  }

  /** A surface with one dial in `mode` on screen. */
  async function dialIn(mode: CameraCarMode) {
    const surface = makeSurface();
    const ctx = dialContext();
    const d = ReplayControlDialSettings.parse({ mode });

    await surface.willAppear(ctx as never, d);
    await vi.advanceTimersByTimeAsync(100);

    return { surface, ctx, d };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    seen = [];
    camCarIdx = CAMERA_AT_TURN;
    sim = fakeReplay({
      frame: START,
      speed: { speed: 1, slowMotion: false },
      speedLagMs: 300,
      searches: { nextLap: (from) => from + 30_000 },
    });

    const { getCommands } = await import("@iracedeck/deck-iracing");

    vi.mocked(getCommands).mockReturnValue({ replay: sim.replay, camera } as unknown as ReturnType<typeof getCommands>);
    // A camera switch puts that car on camera: its raw number is its carIdx plus 100.
    camera.switchNum.mockImplementation((carNum) => {
      note(`switchNum ${carNum}`);
      camCarIdx = carNum - 100;

      return true;
    });
    resetEngine({
      controller,
      logger: logger as never,
      replay: () => sim.replay,
      readTelemetry: () => read(),
      inReplay: () => true,
    });
  });

  afterEach(() => {
    resetEngine();
    vi.useRealTimers();
  });

  /** The switch a turn of `ticks` makes from `from` in `mode`. */
  function switchFrom(mode: CameraCarMode, from: number, ticks: number): string {
    const to = (ticks > 0 ? CLOCKWISE : COUNTER_CLOCKWISE)[mode][from];

    return `switchNum ${to + 100}`;
  }

  /** Starts a Replay Markers Next jump to {@link TARGET} and runs the clock until its seek is out and showing. */
  async function markerJumpUnderWay(): Promise<{ outcome: () => ReplayJumpOutcome | null }> {
    let outcome: ReplayJumpOutcome | null = null;

    void jumpToMarkerFrame("next", TARGET, () => read(), Date.now(), "ctx-marker").then((result) => {
      outcome = result;
      note("jump ended");
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(sim.calls.map((call) => call.split(" ")[0])).toContain("setPlayPosition");
    expect(sim.busy()).toBe(true);

    return { outcome: () => outcome };
  }

  describe.each(MODES)("%s", (mode) => {
    it("on a quiet replay switches at once, to the car the turn asks for", async () => {
      const { surface, ctx, d } = await dialIn(mode);

      surface.rotate(ctx as never, d, 1, false);
      await vi.advanceTimersByTimeAsync(0);

      expect(seen.map((entry) => entry.what)).toEqual([switchFrom(mode, CAMERA_AT_TURN, 1)]);
      expect(sim.calls).toEqual([]);
    });

    it("behind a Replay Markers jump switches once it has landed on its frame and ended, leaving its run standing", async () => {
      const { surface, ctx, d } = await dialIn(mode);
      const jump = await markerJumpUnderWay();

      surface.rotate(ctx as never, d, -1, false);
      await vi.advanceTimersByTimeAsync(100);

      // The marker jump keeps the cursor: the turn waits behind it, cancelling nothing.
      expect(seen).toEqual([]);
      expect(currentReplayCursorOwner()).toBe("next");

      await vi.advanceTimersByTimeAsync(5_000);

      expect(seen.map((entry) => entry.what)).toEqual(["jump ended", switchFrom(mode, CAMERA_AT_TURN, -1)]);
      expect(jump.outcome()).toMatchObject({ kind: "landed" });

      const [ended, switched] = seen;

      expect(ended.frame).toBe(TARGET);
      expect(switched.busy).toBe(false);
      expect(switched.open).toBe(false);
      expect(camera.switchNum).toHaveBeenCalledOnce();
      expect(sim.thrown).toBe(0);
    });

    it("switches from the car on camera when the switch goes out, not at the turn", async () => {
      const { surface, ctx, d } = await dialIn(mode);

      await markerJumpUnderWay();
      surface.rotate(ctx as never, d, 1, false);
      await vi.advanceTimersByTimeAsync(100);
      // Another car is put on camera while the switch waits.
      camCarIdx = 9;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(seen.map((entry) => entry.what)).toEqual(["jump ended", switchFrom(mode, 9, 1)]);
    });

    it("behind a search on its way switches at once: a search does not swallow a camera change", async () => {
      const { surface, ctx, d } = await dialIn(mode);

      pressReplayCommand({ kind: "search", search: "nextLap" }, { by: "next-lap", origin: "key" });
      expect(sim.busy()).toBe(true);

      surface.rotate(ctx as never, d, 1, false);
      await vi.advanceTimersByTimeAsync(0);

      expect(seen.map((entry) => [entry.what, entry.busy])).toEqual([[switchFrom(mode, CAMERA_AT_TURN, 1), true]]);
    });

    it("interrupts a Jump to Fastest Lap walk under its own name, and does not cancel it", async () => {
      const { surface, ctx, d } = await dialIn(mode);
      const walk = claimReplayCursor(FASTEST_LAP_WALK_OWNER);

      surface.rotate(ctx as never, d, 1, false);
      await vi.advanceTimersByTimeAsync(100);

      expect(walk.interruptedBy).toBe(mode === "car-number" ? "dial-car-number" : "dial-race-position");
      expect(walk.cancelledBy).toBeNull();
      expect(seen.map((entry) => entry.what)).toEqual([switchFrom(mode, CAMERA_AT_TURN, 1)]);
    });

    it("a second turn while one waits replaces it: one switch, the second turn's", async () => {
      const { surface, ctx, d } = await dialIn(mode);

      await markerJumpUnderWay();
      surface.rotate(ctx as never, d, 1, false);
      surface.rotate(ctx as never, d, -1, false);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(seen.map((entry) => entry.what)).toEqual(["jump ended", switchFrom(mode, CAMERA_AT_TURN, -1)]);
      expect(camera.switchNum).toHaveBeenCalledOnce();
    });
  });
});
