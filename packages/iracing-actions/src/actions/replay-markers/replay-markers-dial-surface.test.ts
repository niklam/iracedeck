import { ReplayPosMode, replaySpeedToSdk, type TelemetryData } from "@iracedeck/iracing-sdk";
import type { ReplayMarker, ReplaySessionStore } from "@iracedeck/replay-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _configureReplayCommandGate, _resetReplayCommandGate } from "../../shared/replay-command-gate.js";
import {
  _resetReplayCursor,
  cancelReplayCursorOwner,
  claimReplayCursor,
  currentReplayCursorOwner,
} from "../../shared/replay-cursor.js";
import { _resetReplayPositionState, pendingReplayTarget } from "../../shared/replay-position-state.js";
import { steppedReplayState } from "../../shared/test-support/replay-state.js";
import { buildTriggerDescription, ReplayMarkersDialSurface } from "./replay-markers-dial-surface.js";
import {
  CONFIRMATION_FLASH_MS,
  readReplayContext,
  REPLAY_EXIT_GRACE_MS,
  resolveJumpTarget,
} from "./replay-markers-ops.js";
import { ReplayMarkersDialSettings } from "./replay-markers-settings.js";

const mocks = vi.hoisted(() => ({
  setPlayPosition: vi.fn((_mode: number, _frame: number) => true),
  setPlaySpeed: vi.fn((_speed: number, _slowMotion?: boolean) => true),
  getGlobalSettings: vi.fn((): Record<string, unknown> => ({})),
  thresholdMs: { value: 500 },
}));

// The dial surface reads the replay commands through deck-iracing; this suite
// mocks deck-core without a ConnectionStateAwareAction, so the real barrel (whose
// SimIRacingAction extends it) cannot load.
vi.mock("@iracedeck/deck-iracing", () => ({
  getCommands: () => ({ replay: { setPlayPosition: mocks.setPlayPosition, setPlaySpeed: mocks.setPlaySpeed } }),
}));

// The jump sequence reads the Replay jump playback setting and its timeout from here.
vi.mock("@iracedeck/settings", () => ({
  getGlobalSettings: mocks.getGlobalSettings,
}));

vi.mock("@iracedeck/deck-core", async () => {
  // deck-core's dial-gesture and icon-update-throttle modules, reached by PATH
  // rather than through the mocked barrel (the `mouse-to-sim.test.ts`
  // pattern): the hold preview's timer, the release classifier and the 10/s
  // throttle are what is under test, so the REAL ones run. Neither module has
  // imports of its own. The paths are inlined because `vi.mock` is hoisted.
  const dialGesture = await vi.importActual<typeof import("../../../../deck-core/src/dial-gesture.js")>(
    "../../../../deck-core/src/dial-gesture.js",
  );
  const throttle = await vi.importActual<typeof import("../../../../deck-core/src/icon-update-throttle.js")>(
    "../../../../deck-core/src/icon-update-throttle.js",
  );
  const { z } = await import("zod");

  return {
    CommonSettings: { extend: (shape: never) => z.object(shape).passthrough() },
    createHoldPreview: dialGesture.createHoldPreview,
    NOOP_HOLD_PREVIEW: dialGesture.NOOP_HOLD_PREVIEW,
    classifyDialRelease: dialGesture.classifyDialRelease,
    IconUpdateThrottle: throttle.IconUpdateThrottle,
    getDualPressThresholdMs: () => mocks.thresholdMs.value,
    applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
    escapeXml: (str: string) => str,
    // Identity, so a test reads the pushed SVG straight off `setDialCanvas`.
    svgToDataUri: (svg: string) => svg,
  };
});

vi.mock("@iracedeck/replay-store", () => ({
  MARKER_DEDUPE_FRAMES: 60,
  MARKER_DELETE_WINDOW_FRAMES: 600,
  MARKER_NEXT_MIN_AHEAD_FRAMES: 60,
  MARKER_PREVIOUS_MIN_BEHIND_FRAMES: 120,
}));

// The store's own pure marker functions, by path past the mocked barrel (the
// module has no imports), so the fake store answers add / delete exactly as
// the real one does. Next and previous are the shared walk over list() (#1426).
const markerFns = await vi.importActual<typeof import("../../../../replay-store/src/replay-markers.js")>(
  "../../../../replay-store/src/replay-markers.js",
);

const STRIP = { id: "sd-plus-strip", width: 200, height: 100 } as const;
const KNOB = { id: "stream-dock-knob", width: 176, height: 112 } as const;

const env = {
  connected: true,
  storeReady: true,
  telemetry: null as TelemetryData | null,
  markers: [] as ReplayMarker[],
  /** The store's active record; null as before the SDK reported a session. */
  active: { subSessionId: 42 } as { subSessionId: number } | null,
};

const storeMarkers = {
  add: vi.fn((marker: ReplayMarker, _scope?: unknown) => markerFns.addMarker(env.markers, marker)),
  deleteNearest: vi.fn((frame: number, _scope?: unknown) => markerFns.deleteNearestMarker(env.markers, frame)),
  list: vi.fn((_scope?: unknown) => env.markers.map((m) => ({ ...m }))),
};
const store = { markers: storeMarkers, getActiveSession: () => env.active } as unknown as ReplaySessionStore;

function setMarkers(frames: number[]): void {
  env.markers = frames.map((frame) => ({ frame, pressFrame: frame, sessionNum: 0, sessionTimeMs: 0 }));
}

/** A replay paused on `frame`: a jump from here sends its seek within the turn. */
function replayAt(frame: number): TelemetryData {
  return {
    IsReplayPlaying: true,
    ReplayFrameNum: frame,
    ReplayFrameNumEnd: 100_000,
    ReplayPlaySpeed: 0,
    ReplayPlaySlowMotion: false,
    ReplaySessionNum: 1,
    ReplaySessionTime: 300,
  } as TelemetryData;
}

const LIVE = {
  IsReplayPlaying: false,
  ReplayFrameNum: 0,
  ReplayFrameNumEnd: 50_000,
  SessionNum: 2,
  SessionTime: 900,
} as TelemetryData;

const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** A replay speed as telemetry reports it. */
interface SimSpeed {
  ReplayPlaySpeed: number;
  ReplayPlaySlowMotion: boolean;
}

const PAUSED: SimSpeed = { ReplayPlaySpeed: 0, ReplayPlaySlowMotion: false };
const AT_1X: SimSpeed = { ReplayPlaySpeed: 1, ReplayPlaySlowMotion: false };
/** iRacing reports 1/4x as raw 3 with the slow-motion flag (#1202); `setPlaySpeed(4, true)` sets it. */
const QUARTER: SimSpeed = { ReplayPlaySpeed: 3, ReplayPlaySlowMotion: true };
const FORWARD_8: SimSpeed = { ReplayPlaySpeed: 8, ReplayPlaySlowMotion: false };
const REWIND_8: SimSpeed = { ReplayPlaySpeed: -8, ReplayPlaySlowMotion: false };

/** Setting, the replay before the turn, its speed, what is sent before the seek, what after the landing, the speed left. */
const JUMP_PLAYBACK_CASES: ReadonlyArray<readonly [string, string, SimSpeed, string[], string[], SimSpeed]> = [
  ["remember", "paused", PAUSED, [], [], PAUSED],
  ["remember", "playing at 1x", AT_1X, ["speed 0"], ["speed 1"], AT_1X],
  ["remember", "in slow motion at 1/4x", QUARTER, ["speed 0"], ["speed 4 slow"], QUARTER],
  ["remember", "fast-forwarding at 8x", FORWARD_8, ["speed 0"], ["speed 8"], FORWARD_8],
  ["remember", "rewinding at -8x", REWIND_8, ["speed 0"], ["speed -8"], REWIND_8],
  ["play", "paused", PAUSED, [], ["speed 1"], AT_1X],
  ["play", "playing at 1x", AT_1X, ["speed 0"], ["speed 1"], AT_1X],
  ["play", "in slow motion at 1/4x", QUARTER, ["speed 0"], ["speed 1"], AT_1X],
  ["play", "fast-forwarding at 8x", FORWARD_8, ["speed 0"], ["speed 1"], AT_1X],
  ["play", "rewinding at -8x", REWIND_8, ["speed 0"], ["speed 1"], AT_1X],
  ["stopped", "paused", PAUSED, [], [], PAUSED],
  ["stopped", "playing at 1x", AT_1X, ["speed 0"], [], PAUSED],
  ["stopped", "in slow motion at 1/4x", QUARTER, ["speed 0"], [], PAUSED],
  ["stopped", "fast-forwarding at 8x", FORWARD_8, ["speed 0"], [], PAUSED],
  ["stopped", "rewinding at -8x", REWIND_8, ["speed 0"], [], PAUSED],
];

/**
 * A sim behind the mocked replay commands that acts on one only at a later
 * update, `lagMs` on — the shape that makes waiting for the pause and for the
 * landing matter. It starts `env.telemetry` as a replay at `speed` and writes
 * what a command did back to it. `calls` is every command in the order it was
 * sent. A refused command returns false; an ignored one is accepted and never
 * shows.
 */
function fakeSim(speed: SimSpeed, options: { frame?: number; lagMs?: number; seekLagMs?: number } = {}) {
  const lagMs = options.lagMs ?? 20;
  const seekLagMs = options.seekLagMs ?? lagMs;
  const sim = {
    calls: [] as string[],
    refuse: { speed: false, seek: false },
    ignore: { speed: false, seek: false },
  };
  const show = (change: Partial<TelemetryData>): void => {
    env.telemetry = { ...env.telemetry, ...change } as TelemetryData;
  };

  env.telemetry = { ...replayAt(options.frame ?? 500), ...speed };
  mocks.setPlaySpeed.mockImplementation((value: number, slowMotion: boolean = false) => {
    sim.calls.push(`speed ${value}${slowMotion ? " slow" : ""}`);

    if (sim.refuse.speed) return false;

    if (!sim.ignore.speed) {
      setTimeout(
        () => show({ ReplayPlaySpeed: replaySpeedToSdk(value, slowMotion), ReplayPlaySlowMotion: slowMotion }),
        lagMs,
      );
    }

    return true;
  });
  mocks.setPlayPosition.mockImplementation((_mode: number, frame: number) => {
    sim.calls.push(`seek ${frame}`);

    if (sim.refuse.seek) return false;

    if (!sim.ignore.seek) setTimeout(() => show({ ReplayFrameNum: frame }), seekLagMs);

    return true;
  });

  return sim;
}

function makeSurface(): ReplayMarkersDialSurface {
  const replay = steppedReplayState(() => env.telemetry);

  return new ReplayMarkersDialSurface({
    logger: logger as never,
    readTelemetry: () => env.telemetry,
    readReplayContext: () =>
      readReplayContext({
        getConnectionStatus: () => env.connected,
        getCurrentTelemetry: () => env.telemetry,
        getSessionInfo: () => ({ WeekendInfo: { SubSessionID: 42 } }),
        getReplayState: replay.getReplayState,
        isStoreInitialized: () => env.storeReady,
        getStore: () => store,
      }),
  });
}

function dialContext(id = "dial-1", canvas: typeof STRIP | typeof KNOB | null = STRIP) {
  return {
    id,
    isKey: () => false,
    isDial: () => true,
    dialCanvas: () => canvas,
    setDialCanvas: vi.fn((_uri: string) => Promise.resolve()),
    setImage: vi.fn((_svg: string) => Promise.resolve()),
    setTriggerDescription: vi.fn((_d: unknown) => Promise.resolve()),
  };
}

type DialContext = ReturnType<typeof dialContext>;

function dial(overrides: Record<string, unknown> = {}): ReplayMarkersDialSettings {
  return ReplayMarkersDialSettings.parse(overrides);
}

function lastBox(ctx: DialContext): string {
  return ctx.setDialCanvas.mock.calls.at(-1)?.[0] ?? "";
}

/** The value slot's text: the biggest `<text>` that is not the label or the caption. */
function shownValue(svg: string): string {
  const texts = [...svg.matchAll(/<text(?! data-caption)[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

  return texts.filter((t) => t !== "MARKERS").at(-1) ?? "";
}

function sides(svg: string): { left: boolean; right: boolean } {
  const lit = (side: string) => {
    const poly = new RegExp(`<polygon data-side="${side}"[^>]*>`).exec(svg)?.[0] ?? "";

    return poly !== "" && !poly.includes("opacity");
  };

  return { left: lit("left"), right: lit("right") };
}

/** Lets the throttle's trailing flush and any settled promise run. */
async function settle(ms = 100): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

async function appear(surface: ReplayMarkersDialSurface, ctx: DialContext, d = dial()): Promise<void> {
  await surface.willAppear(ctx as never, d);
  await settle();
}

async function press(surface: ReplayMarkersDialSurface, ctx: DialContext, d: ReplayMarkersDialSettings, holdMs = 0) {
  surface.down(ctx as never, d);

  if (holdMs > 0) await vi.advanceTimersByTimeAsync(holdMs);

  await surface.up(ctx.id);
}

describe("ReplayMarkersDialSurface", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    _resetReplayCursor();
    _resetReplayCommandGate();
    _resetReplayPositionState();
    // The gate reads the replay the surface reads: the same telemetry, and the
    // same debounced replay state over it (#1430).
    const gateReplay = steppedReplayState(() => env.telemetry);
    _configureReplayCommandGate({
      readTelemetry: () => env.telemetry,
      inReplay: () => gateReplay.getReplayState().inReplay,
      connected: () => env.connected,
    });
    env.connected = true;
    env.storeReady = true;
    env.telemetry = replayAt(500);
    env.active = { subSessionId: 42 };
    setMarkers([]);
    mocks.thresholdMs.value = 500;
    mocks.setPlayPosition.mockReturnValue(true);
    mocks.setPlaySpeed.mockReturnValue(true);
    mocks.getGlobalSettings.mockReturnValue({});
  });

  afterEach(() => {
    _resetReplayCommandGate();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("rotation", () => {
    it.each([
      ["clockwise", "next", 1],
      ["counter-clockwise", "previous", -1],
    ] as const)("%s jumps to the marker the keypad's %s picks from the same frame", async (_name, mode, ticks) => {
      setMarkers([1_000, 3_000, 5_000]);
      env.telemetry = replayAt(3_050);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      surface.rotate(ctx as never, dial(), ticks, false);

      const context = readReplayContext({
        getConnectionStatus: () => true,
        getCurrentTelemetry: () => env.telemetry,
        getSessionInfo: () => null,
        getReplayState: steppedReplayState(() => env.telemetry).getReplayState,
        isStoreInitialized: () => true,
        getStore: () => store,
      });
      const keypadTarget = context.ok ? resolveJumpTarget(mode, context) : null;

      expect(keypadTarget).not.toBeNull();
      expect(mocks.setPlayPosition).toHaveBeenCalledTimes(1);
      expect(mocks.setPlayPosition).toHaveBeenCalledWith(ReplayPosMode.Begin, keypadTarget!.frame);
    });

    it("ticks = 3 walks three markers and sends once", async () => {
      setMarkers([1_000, 2_000, 3_000, 4_000, 5_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      surface.rotate(ctx as never, dial(), 3, false);

      expect(mocks.setPlayPosition).toHaveBeenCalledTimes(1);
      expect(mocks.setPlayPosition).toHaveBeenCalledWith(ReplayPosMode.Begin, 3_000);
    });

    it("ticks = 9 walks nine markers with no cap", async () => {
      setMarkers(Array.from({ length: 12 }, (_, i) => (i + 1) * 1_000));
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      surface.rotate(ctx as never, dial(), 9, false);

      expect(mocks.setPlayPosition).toHaveBeenCalledTimes(1);
      expect(mocks.setPlayPosition).toHaveBeenCalledWith(ReplayPosMode.Begin, 9_000);
    });

    it("stops at the end of the list instead of wrapping, either way", async () => {
      setMarkers([1_000, 2_000, 3_000]);
      env.telemetry = replayAt(1_500);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      surface.rotate(ctx as never, dial(), 9, false);
      expect(mocks.setPlayPosition).toHaveBeenLastCalledWith(ReplayPosMode.Begin, 3_000);

      // The jump lands, then the replay moves on to 2 500.
      env.telemetry = replayAt(3_000);
      await settle();
      env.telemetry = replayAt(2_500);
      surface.rotate(ctx as never, dial(), -9, false);
      expect(mocks.setPlayPosition).toHaveBeenLastCalledWith(ReplayPosMode.Begin, 1_000);
    });

    it("sends nothing with no marker in that direction", async () => {
      setMarkers([1_000]);
      env.telemetry = replayAt(5_000);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      surface.rotate(ctx as never, dial(), 1, false);

      expect(mocks.setPlayPosition).not.toHaveBeenCalled();
    });

    it("sends nothing from the car, where iRacing ignores replay commands", async () => {
      setMarkers([1_000, 60_000]);
      env.telemetry = LIVE;
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      surface.rotate(ctx as never, dial(), 1, false);
      surface.rotate(ctx as never, dial(), -1, false);

      expect(mocks.setPlayPosition).not.toHaveBeenCalled();
    });

    it.each([
      ["no telemetry", () => (env.telemetry = null)],
      ["no store", () => (env.storeReady = false)],
      ["no connection", () => (env.connected = false)],
    ])("sends nothing with %s", async (_name, breakIt) => {
      setMarkers([1_000, 2_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);
      breakIt();

      surface.rotate(ctx as never, dial(), 1, false);

      expect(mocks.setPlayPosition).not.toHaveBeenCalled();
    });

    it("a zero-tick event sends nothing", async () => {
      setMarkers([1_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      surface.rotate(ctx as never, dial(), 0, false);

      expect(mocks.setPlayPosition).not.toHaveBeenCalled();
    });
  });

  describe("the pending target (#1230, #1430)", () => {
    it("a second event before telemetry catches up steps from the last target, not the stale frame", async () => {
      setMarkers([1_000, 2_000, 3_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      surface.rotate(ctx as never, dial(), 1, false);
      surface.rotate(ctx as never, dial(), 1, false);
      surface.rotate(ctx as never, dial(), -1, false);

      expect(mocks.setPlayPosition.mock.calls.map((c) => c[1])).toEqual([1_000, 2_000, 1_000]);
    });

    it("a jump still on its way anchors however long it takes, with no hold of its own (#1430)", async () => {
      setMarkers([1_000, 2_000, 3_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      surface.rotate(ctx as never, dial(), 1, false);
      // Well past the second the marker surfaces once held a landing for.
      await vi.advanceTimersByTimeAsync(2_500);
      surface.rotate(ctx as never, dial(), 1, false);

      // The first jump has not read back and has not given up: the turn steps on from its marker.
      expect(mocks.setPlayPosition.mock.calls.map((c) => c[1])).toEqual([1_000, 2_000]);
    });

    it("after a jump that never landed has given up, the live frame anchors again", async () => {
      setMarkers([1_000, 2_000, 3_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      surface.rotate(ctx as never, dial(), 1, false);
      await vi.advanceTimersByTimeAsync(3_100);
      surface.rotate(ctx as never, dial(), 1, false);

      // The replay never moved off 500, so the store's Next from there is 1 000 again.
      expect(mocks.setPlayPosition.mock.calls.map((c) => c[1])).toEqual([1_000, 1_000]);
    });

    it("once the target's frame reads back, the live frame anchors again (#1430)", async () => {
      setMarkers([1_000, 2_000, 3_000, 4_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      surface.rotate(ctx as never, dial(), 2, false);
      // The target ends on its own frame reading back from the replay, not on a frame near it.
      env.telemetry = replayAt(2_000);
      surface.onTick(ctx.id);
      // The driver then moves the replay on by other means, straight away.
      env.telemetry = replayAt(3_500);
      surface.rotate(ctx as never, dial(), 1, false);

      expect(mocks.setPlayPosition.mock.calls.map((c) => c[1])).toEqual([2_000, 4_000]);
    });

    it("a jump that was not sent leaves no target: the next turn measures from the live frame", async () => {
      setMarkers([1_000, 2_000, 3_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      mocks.setPlayPosition.mockReturnValueOnce(false);
      surface.rotate(ctx as never, dial(), 1, false);
      // The refused jump clears the target it recorded once it has ended.
      await settle(0);
      surface.rotate(ctx as never, dial(), 1, false);

      expect(mocks.setPlayPosition.mock.calls.map((c) => c[1])).toEqual([1_000, 1_000]);
    });

    it("is one value shared by every dial: a second dial steps on from the first dial's target", async () => {
      setMarkers([1_000, 2_000, 3_000]);
      const first = makeSurface();
      const second = makeSurface();
      const a = dialContext("dial-a");
      const b = dialContext("dial-b");
      await appear(first, a);
      await appear(second, b);

      first.rotate(a as never, dial(), 1, false);
      second.rotate(b as never, dial(), 1, false);
      first.rotate(a as never, dial(), 1, false);

      expect(mocks.setPlayPosition.mock.calls.map((c) => c[1])).toEqual([1_000, 2_000, 3_000]);
    });

    it("a tick with no replay context leaves the target standing (#1430)", async () => {
      setMarkers([1_000, 2_000, 3_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      surface.rotate(ctx as never, dial(), 1, false);
      // The store goes away for a tick: the dial has no context, and the replay is still headed for 1 000.
      env.storeReady = false;
      surface.onTick(ctx.id);
      expect(pendingReplayTarget()).toMatchObject({ frame: 1_000 });

      env.storeReady = true;
      surface.rotate(ctx as never, dial(), 1, false);

      expect(mocks.setPlayPosition.mock.calls.map((c) => c[1])).toEqual([1_000, 2_000]);
    });

    it("a cursor take by a key that sends no replay command leaves the target standing (#1430)", async () => {
      setMarkers([1_000, 2_000, 3_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      surface.rotate(ctx as never, dial(), 1, false);
      // Jump to My Car, say: it takes the cursor in its own name and sends no replay command.
      cancelReplayCursorOwner("jump-to-my-car");
      surface.rotate(ctx as never, dial(), 1, false);

      // The replay is still headed for the 1 000 the dial sent, so the turn steps on from there.
      expect(mocks.setPlayPosition.mock.calls.map((c) => c[1])).toEqual([1_000, 2_000]);
    });
  });

  describe("the Replay jump playback setting (#1276)", () => {
    /** A dial on a replay at `speed`, behind the fake sim, with markers every 1 000 frames. */
    async function dialAt(speed: SimSpeed, options?: { frame?: number; lagMs?: number; seekLagMs?: number }) {
      setMarkers([1_000, 2_000, 3_000, 4_000, 5_000]);
      const sim = fakeSim(speed, options);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      return { surface, ctx, sim };
    }

    it.each(JUMP_PLAYBACK_CASES)("%s, from a replay %s", async (setting, _state, before, pause, after, left) => {
      mocks.getGlobalSettings.mockReturnValue({ replayJumpPlayback: setting });
      const { surface, ctx, sim } = await dialAt(before);

      surface.rotate(ctx as never, dial(), 1, false);
      await settle(1_000);

      expect(sim.calls).toEqual([...pause, "seek 1000", ...after]);
      expect(env.telemetry).toMatchObject({ ReplayFrameNum: 1_000, ...left });
      expect(logger.warn).not.toHaveBeenCalled();
      expect(currentReplayCursorOwner()).toBeNull();
    });

    it("with no setting stored, remembers the speed — counter-clockwise too", async () => {
      mocks.getGlobalSettings.mockReturnValue({});
      const { surface, ctx, sim } = await dialAt(REWIND_8, { frame: 2_500 });

      surface.rotate(ctx as never, dial(), -1, false);
      expect(currentReplayCursorOwner()).toBe("dial-previous");
      await settle(1_000);

      expect(sim.calls).toEqual(["speed 0", "seek 2000", "speed -8"]);
    });

    it("a turn returns with the jump under way", async () => {
      const { surface, ctx, sim } = await dialAt(AT_1X);

      surface.rotate(ctx as never, dial(), 1, false);

      // Paused, not yet sought; the target already anchors the next detent, under the dial's own origin token.
      expect(sim.calls).toEqual(["speed 0"]);
      expect(currentReplayCursorOwner()).toBe("dial-next");
      expect(pendingReplayTarget()).toMatchObject({ frame: 1_000, origin: "dial-1" });
      expect(logger.info).toHaveBeenCalledWith("Dial jumped to next marker");
    });

    it("a paused replay still gets its seek within the turn", async () => {
      const { surface, ctx, sim } = await dialAt(PAUSED);

      surface.rotate(ctx as never, dial(), 1, false);

      expect(sim.calls).toEqual(["seek 1000"]);
    });

    it("sends nothing between the seek and the landing", async () => {
      mocks.getGlobalSettings.mockReturnValue({ replayJumpPlayback: "play" });
      const { surface, ctx, sim } = await dialAt(PAUSED, { seekLagMs: 400 });

      surface.rotate(ctx as never, dial(), 1, false);
      await settle(350);
      expect(sim.calls).toEqual(["seek 1000"]);

      await settle(650);
      expect(sim.calls).toEqual(["seek 1000", "speed 1"]);
    });

    it("says at debug how the jump landed", async () => {
      const { surface, ctx } = await dialAt(QUARTER);

      surface.rotate(ctx as never, dial(), 1, false);
      await settle(1_000);

      expect(logger.debug).toHaveBeenCalledWith(
        "Dial next marker: landed on frame 1000; speed=4 slowMotion=true command=sent",
      );
    });

    it.each(["remember", "play", "stopped"])(
      "%s: a landing that times out warns, sends nothing after the seek and leaves the replay paused",
      async (setting) => {
        mocks.getGlobalSettings.mockReturnValue({ replayJumpPlayback: setting });
        const { surface, ctx, sim } = await dialAt(AT_1X);

        sim.ignore.seek = true;
        surface.rotate(ctx as never, dial(), 1, false);
        await settle(5_000);

        expect(sim.calls).toEqual(["speed 0", "seek 1000"]);
        expect(env.telemetry).toMatchObject(PAUSED);
        expect(logger.warn).toHaveBeenCalledExactlyOnceWith("Dial next marker: jump did not land; nothing more sent");
        // The last frame seen is in the detail.
        expect(logger.debug).toHaveBeenCalledWith(
          "Dial next marker: reason=seek-timeout target=1000 lastFrame=500 lastSpeed=0",
        );
        expect(currentReplayCursorOwner()).toBeNull();

        // The seek went out, so its target was left to its own wait, which has given it up:
        // the next detent targets the same marker again.
        expect(pendingReplayTarget()).toBeNull();
        surface.rotate(ctx as never, dial(), 1, false);
        expect(sim.calls).toEqual(["speed 0", "seek 1000", "seek 1000"]);
      },
    );

    it("a replay that never pauses gets no seek", async () => {
      const { surface, ctx, sim } = await dialAt(AT_1X);

      sim.ignore.speed = true;
      surface.rotate(ctx as never, dial(), 1, false);
      await settle(5_000);

      expect(sim.calls).toEqual(["speed 0"]);
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith("Dial next marker: replay did not pause; jump not sent");
      expect(pendingReplayTarget()).toBeNull();
    });

    it("another replay command during the wait ends the jump with nothing more sent", async () => {
      const { surface, ctx, sim } = await dialAt(AT_1X, { seekLagMs: 400 });

      surface.rotate(ctx as never, dial(), 1, false);
      await settle(200);
      expect(sim.calls).toEqual(["speed 0", "seek 1000"]);

      // The driver's own command: the jump must not put its speed over it.
      expect(cancelReplayCursorOwner("play-pause")).toBe("dial-next");
      await settle(5_000);

      expect(sim.calls).toEqual(["speed 0", "seek 1000"]);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith("Dial next marker: jump to frame 1000 cancelled by play-pause");
    });

    describe("a fast spin", () => {
      it("two detents while playing: the second steps on from the first's marker, and the replay ends playing there", async () => {
        const { surface, ctx, sim } = await dialAt(AT_1X, { seekLagMs: 400 });

        surface.rotate(ctx as never, dial(), 1, false);
        // The first jump has paused the replay and sent its seek, which has not landed.
        await settle(80);
        expect(sim.calls).toEqual(["speed 0", "seek 1000"]);
        expect(env.telemetry).toMatchObject({ ReplayFrameNum: 500, ...PAUSED });

        surface.rotate(ctx as never, dial(), 1, false);
        await settle(1_000);

        expect(logger.debug).toHaveBeenCalledWith("ticks=1, anchor=500, target=1000");
        expect(logger.debug).toHaveBeenCalledWith("ticks=1, anchor=1000, target=2000");
        expect(logger.debug).toHaveBeenCalledWith("Dial next marker: jump to frame 1000 cancelled by dial-next");
        // The second jump sends its seek alone — a pause would end the first one's
        // seek where it stands — and the speed comes back once, after the second landing.
        expect(sim.calls).toEqual(["speed 0", "seek 1000", "seek 2000", "speed 1"]);
        expect(env.telemetry).toMatchObject({ ReplayFrameNum: 2_000, ...AT_1X });
        expect(logger.warn).not.toHaveBeenCalled();
      });

      it("a second detent before the first one's seek has gone out still steps on, and sends no second pause (#1430)", async () => {
        const { surface, ctx, sim } = await dialAt(AT_1X);

        surface.rotate(ctx as never, dial(), 1, false);
        // The first jump is still waiting for its pause to show.
        await settle(10);
        expect(sim.calls).toEqual(["speed 0"]);

        surface.rotate(ctx as never, dial(), 1, false);
        await settle(1_000);

        expect(logger.debug).toHaveBeenCalledWith("Dial next marker: jump to frame 1000 cancelled by dial-next");
        // The gate sends no pause into a jump under way: the first one's pause is already on its
        // way. Only the second jump's seek goes out, once that pause shows.
        expect(sim.calls).toEqual(["speed 0", "seek 2000", "speed 1"]);
        expect(env.telemetry).toMatchObject({ ReplayFrameNum: 2_000, ...AT_1X });
      });

      it("a spin while fast-forwarding ends fast-forwarding on the last marker", async () => {
        const { surface, ctx, sim } = await dialAt(FORWARD_8);

        for (let detent = 0; detent < 4; detent++) {
          surface.rotate(ctx as never, dial(), 1, false);
          await settle(30);
        }

        await settle(1_000);

        // The second and fourth detents take over a jump still under way and send
        // their seek alone. The second lands before the third arrives, so that one
        // follows a finished jump and pauses the replay it had set going again.
        expect(sim.calls).toEqual([
          "speed 0",
          "seek 1000",
          "seek 2000",
          "speed 8",
          "speed 0",
          "seek 3000",
          "seek 4000",
          "speed 8",
        ]);
        expect(env.telemetry).toMatchObject({ ReplayFrameNum: 4_000, ...FORWARD_8 });
      });
    });

    it("a dial that disappears mid-jump still has its jump finished", async () => {
      const { surface, ctx, sim } = await dialAt(AT_1X);

      surface.rotate(ctx as never, dial(), 1, false);
      surface.willDisappear(ctx.id);
      await settle(1_000);

      expect(sim.calls).toEqual(["speed 0", "seek 1000", "speed 1"]);
      expect(currentReplayCursorOwner()).toBeNull();
    });

    it("a seek that throws is a seek refused: it warns, hands the cursor back and leaves no target (#1430)", async () => {
      const { surface, ctx } = await dialAt(PAUSED);

      mocks.setPlayPosition.mockImplementation(() => {
        throw new Error("broadcast failed");
      });
      surface.rotate(ctx as never, dial(), 1, false);
      await settle(0);

      // The gate catches the throw, so the jump resolves stopped rather than rejecting.
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith("Dial next marker: jump not sent");
      expect(logger.error).not.toHaveBeenCalled();
      expect(currentReplayCursorOwner()).toBeNull();
      expect(pendingReplayTarget()).toBeNull();
    });
  });

  describe("the post-seek telemetry blip", () => {
    /** What telemetry reads for ~300 ms after every `setPlayPosition`: not playing, `ReplayFrameNumEnd` the frames LEFT. */
    const BLIP = { ...replayAt(0), IsReplayPlaying: false } as TelemetryData;

    it("turns in the blip still jump, each stepping on from the marker just jumped to", async () => {
      setMarkers([1_000, 2_000, 3_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      surface.rotate(ctx as never, dial(), 1, false);
      env.telemetry = BLIP;
      await vi.advanceTimersByTimeAsync(80);
      surface.rotate(ctx as never, dial(), 1, false);
      await vi.advanceTimersByTimeAsync(80);
      surface.rotate(ctx as never, dial(), 1, false);

      expect(mocks.setPlayPosition.mock.calls.map((c) => c[1])).toEqual([1_000, 2_000, 3_000]);
    });

    it("no from-the-car caption flashes on the strip during the blip", async () => {
      setMarkers([1_000, 3_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);
      expect(lastBox(ctx)).not.toContain("data-caption");

      env.telemetry = BLIP;
      await vi.advanceTimersByTimeAsync(300);
      surface.onTick(ctx.id);
      await settle();

      expect(lastBox(ctx)).not.toContain("data-caption");
    });

    it("a full second of not playing is the car: the caption shows, a turn sends nothing, and a replay is back at once", async () => {
      setMarkers([1_000, 3_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      env.telemetry = BLIP;
      await vi.advanceTimersByTimeAsync(300);
      surface.onTick(ctx.id);
      await vi.advanceTimersByTimeAsync(REPLAY_EXIT_GRACE_MS);
      surface.onTick(ctx.id);
      await settle();

      expect(lastBox(ctx)).toMatch(/data-caption="true"[^>]*>ADD /);
      surface.rotate(ctx as never, dial(), 1, false);
      expect(mocks.setPlayPosition).not.toHaveBeenCalled();

      env.telemetry = replayAt(500);
      surface.onTick(ctx.id);
      await settle();

      expect(lastBox(ctx)).not.toContain("data-caption");
      surface.rotate(ctx as never, dial(), 1, false);
      expect(mocks.setPlayPosition).toHaveBeenCalledWith(ReplayPosMode.Begin, 1_000);
    });

    it("from the car with no replay before: the caption shows at once", async () => {
      setMarkers([1_000]);
      env.telemetry = LIVE;
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      expect(lastBox(ctx)).toMatch(/data-caption="true"[^>]*>ADD /);
    });
  });

  describe("the replay cursor", () => {
    it("is cancelled under the dial's name before every send", async () => {
      setMarkers([1_000, 2_000, 3_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);
      const cancelledBy: string[] = [];
      const sentWhenCancelled: number[] = [];
      claimReplayCursor("fastest-lap", (by) => {
        cancelledBy.push(by);
        sentWhenCancelled.push(mocks.setPlayPosition.mock.calls.length);
      });

      surface.rotate(ctx as never, dial(), 2, false);
      // The replay lands on the dial's target, so the next turn measures from there.
      env.telemetry = replayAt(2_000);
      claimReplayCursor("fastest-lap", (by) => {
        cancelledBy.push(by);
        sentWhenCancelled.push(mocks.setPlayPosition.mock.calls.length);
      });
      surface.rotate(ctx as never, dial(), -1, false);

      expect(cancelledBy).toEqual(["dial-next", "dial-previous"]);
      // Each cancel came before its own send.
      expect(sentWhenCancelled).toEqual([0, 1]);
    });

    it("is never cancelled when nothing is sent", async () => {
      setMarkers([1_000]);
      env.telemetry = replayAt(5_000);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);
      claimReplayCursor("fastest-lap");

      surface.rotate(ctx as never, dial(), 1, false);
      // From the car: past the post-seek grace, so the replay counts as left.
      env.telemetry = LIVE;
      await vi.advanceTimersByTimeAsync(REPLAY_EXIT_GRACE_MS);
      surface.rotate(ctx as never, dial(), -1, false);

      expect(currentReplayCursorOwner()).toBe("fastest-lap");
    });
  });

  describe("gestures", () => {
    it("a short press adds with the dial's own Seconds back", async () => {
      env.telemetry = LIVE;
      const surface = makeSurface();
      const ctx = dialContext();
      const d = dial({ secondsBack: 3 });
      await appear(surface, ctx, d);

      await press(surface, ctx, d);

      expect(storeMarkers.add).toHaveBeenCalledWith(
        expect.objectContaining({ frame: 50_000 - 180, pressFrame: 50_000 }),
        { subSessionId: 42 },
      );
    });

    it("a long press deletes the marker pickMarkerToDelete names", async () => {
      setMarkers([1_000, 5_000]);
      env.telemetry = replayAt(5_300);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      await press(surface, ctx, dial(), 600);

      expect(storeMarkers.deleteNearest).toHaveBeenCalledWith(5_000, { subSessionId: 42 });
      expect(env.markers.map((m) => m.frame)).toEqual([1_000]);
    });

    it("push + turn steps like a plain turn and its release fires nothing", async () => {
      setMarkers([1_000, 2_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      const d = dial();
      await appear(surface, ctx, d);

      surface.down(ctx as never, d);
      surface.rotate(ctx as never, d, 1, true);
      await vi.advanceTimersByTimeAsync(600);
      await surface.up(ctx.id);

      expect(mocks.setPlayPosition).toHaveBeenCalledWith(ReplayPosMode.Begin, 1_000);
      expect(storeMarkers.add).not.toHaveBeenCalled();
      expect(storeMarkers.deleteNearest).not.toHaveBeenCalled();
    });

    it("None does nothing", async () => {
      env.telemetry = LIVE;
      const surface = makeSurface();
      const ctx = dialContext();
      const d = dial({ pressAction: "none", longPressAction: "none" });
      await appear(surface, ctx, d);

      await press(surface, ctx, d);
      await press(surface, ctx, d, 600);

      expect(storeMarkers.add).not.toHaveBeenCalled();
      expect(storeMarkers.deleteNearest).not.toHaveBeenCalled();
    });

    it("a stray release with no press fires nothing", async () => {
      env.telemetry = LIVE;
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      await surface.up(ctx.id);

      expect(storeMarkers.add).not.toHaveBeenCalled();
    });

    it("the touch slots are inert by default and run their gesture when set", async () => {
      env.telemetry = LIVE;
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      surface.touchTap(ctx as never, dial(), false);
      surface.touchTap(ctx as never, dial(), true);
      expect(storeMarkers.add).not.toHaveBeenCalled();

      surface.touchTap(ctx as never, dial({ tapAction: "add" }), false);
      expect(storeMarkers.add).toHaveBeenCalledTimes(1);
    });

    it("the threshold is the plugin-wide long-press setting", async () => {
      mocks.thresholdMs.value = 1_000;
      setMarkers([5_000]);
      env.telemetry = replayAt(5_300);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      await press(surface, ctx, dial(), 600);

      // 600 ms is short against a 1 s threshold: Add, not Delete.
      expect(storeMarkers.deleteNearest).not.toHaveBeenCalled();
      expect(storeMarkers.add).toHaveBeenCalledTimes(1);
    });

    describe("with the extended gestures compiled out (Mirabox, Ulanzi)", () => {
      it("no release classifies as long, and the touch slots are inert", async () => {
        vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
        setMarkers([5_000]);
        env.telemetry = replayAt(5_300);
        const surface = makeSurface();
        const ctx = dialContext("knob", KNOB);
        await appear(surface, ctx);

        await press(surface, ctx, dial(), 2_000);
        surface.touchTap(ctx as never, dial({ tapAction: "delete" }), false);

        expect(storeMarkers.deleteNearest).not.toHaveBeenCalled();
        expect(storeMarkers.add).toHaveBeenCalledTimes(1);
      });

      it("Delete stays reachable by assigning it to Press", async () => {
        vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
        setMarkers([5_000]);
        env.telemetry = replayAt(5_300);
        const surface = makeSurface();
        const ctx = dialContext("knob", KNOB);
        const d = dial({ pressAction: "delete" });
        await appear(surface, ctx, d);

        await press(surface, ctx, d);

        expect(env.markers).toEqual([]);
      });
    });
  });

  describe("a late input event never re-creates a disappeared context (#1329)", () => {
    const d = () => dial({ tapAction: "add", longTouchAction: "add" });

    async function appearThenDisappear(id: string) {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", true);
      setMarkers([1_000, 3_000, 5_000]);
      env.telemetry = replayAt(3_050);
      const surface = makeSurface();
      await appear(surface, dialContext(id), d());
      surface.willDisappear(id);
      vi.clearAllMocks();

      return { surface, late: dialContext(id) };
    }

    function expectNothingSent(late: DialContext) {
      expect(late.setDialCanvas).not.toHaveBeenCalled();
      expect(late.setTriggerDescription).not.toHaveBeenCalled();
      expect(mocks.setPlayPosition).not.toHaveBeenCalled();
      expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
      expect(storeMarkers.add).not.toHaveBeenCalled();
      expect(storeMarkers.deleteNearest).not.toHaveBeenCalled();
    }

    it("drops a rotate: no entry, no seek, no frame", async () => {
      const { surface, late } = await appearThenDisappear("late-rotate");

      surface.rotate(late as never, d(), 1, false);
      await settle();

      expect(surface["contexts"].has("late-rotate")).toBe(false);
      expectNothingSent(late);
    });

    it("drops a down: no entry and no hold-preview timer armed", async () => {
      const { surface, late } = await appearThenDisappear("late-down");
      const timersBefore = vi.getTimerCount();

      surface.down(late as never, d());

      expect(vi.getTimerCount()).toBe(timersBefore);
      await vi.advanceTimersByTimeAsync(1000);
      await surface.up("late-down");

      expect(surface["contexts"].has("late-down")).toBe(false);
      expectNothingSent(late);
    });

    it("drops a touchTap: no entry, no marker added", async () => {
      const { surface, late } = await appearThenDisappear("late-tap");

      surface.touchTap(late as never, d(), false);
      await settle();

      expect(surface["contexts"].has("late-tap")).toBe(false);
      expectNothingSent(late);
    });

    it("still acts on a live context", async () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", true);
      setMarkers([1_000, 3_000, 5_000]);
      env.telemetry = replayAt(3_050);
      const surface = makeSurface();
      const ctx = dialContext("live");
      await appear(surface, ctx, d());

      surface.rotate(ctx as never, d(), 1, false);

      expect(surface["contexts"].has("live")).toBe(true);
      expect(mocks.setPlayPosition).toHaveBeenCalledTimes(1);
    });
  });

  describe("hold preview", () => {
    it("at the threshold shows the marker a release would delete", async () => {
      setMarkers([1_000, 5_000]);
      env.telemetry = replayAt(5_300);
      const surface = makeSurface();
      const ctx = dialContext();
      const d = dial();
      await appear(surface, ctx, d);

      surface.down(ctx as never, d);
      await vi.advanceTimersByTimeAsync(499);
      expect(lastBox(ctx)).not.toContain("data-pending-bar");

      await vi.advanceTimersByTimeAsync(1);
      expect(lastBox(ctx)).toContain(">DELETE 2 / 2</text>");
      expect(lastBox(ctx)).toContain("data-pending-bar");
      expect(storeMarkers.deleteNearest).not.toHaveBeenCalled();
    });

    it("previews a non-duplicate Add", async () => {
      env.telemetry = LIVE;
      const surface = makeSurface();
      const ctx = dialContext();
      const d = dial({ longPressAction: "add", secondsBack: 7 });
      await appear(surface, ctx, d);

      surface.down(ctx as never, d);
      await vi.advanceTimersByTimeAsync(500);

      expect(shownValue(lastBox(ctx))).toBe("ADD −7 s");
      expect(lastBox(ctx)).toContain("data-pending-bar");
    });

    it("previews an Add of 0 s back without a negative zero", async () => {
      env.telemetry = LIVE;
      const surface = makeSurface();
      const ctx = dialContext();
      const d = dial({ longPressAction: "add", secondsBack: 0 });
      await appear(surface, ctx, d);

      surface.down(ctx as never, d);
      await vi.advanceTimersByTimeAsync(500);

      expect(shownValue(lastBox(ctx))).toBe("ADD 0 s");
    });

    it.each([
      [
        "a duplicate Add",
        () => {
          env.telemetry = LIVE;
          setMarkers([50_000 - 300 + 30]);
        },
        { longPressAction: "add" },
      ],
      [
        "no marker within the delete window",
        () => {
          setMarkers([1_000]);
          env.telemetry = replayAt(9_000);
        },
        {},
      ],
      ["absent telemetry", () => (env.telemetry = null), {}],
      [
        "an Add the store would refuse, with no active record",
        () => {
          env.telemetry = LIVE;
          env.active = null;
        },
        { longPressAction: "add" },
      ],
      ["a long press set to None", () => setMarkers([500]), { longPressAction: "none" }],
    ])("leaves the screen still for %s", async (_name, arrange, overrides) => {
      arrange();
      const surface = makeSurface();
      const ctx = dialContext();
      const d = dial(overrides);
      await appear(surface, ctx, d);
      ctx.setDialCanvas.mockClear();

      surface.down(ctx as never, d);
      await vi.advanceTimersByTimeAsync(800);

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
    });

    it.each([
      [
        "a release that deletes",
        async (s: ReplayMarkersDialSurface, ctx: DialContext) => {
          await s.up(ctx.id);
        },
      ],
      [
        "a release whose marker went meanwhile",
        async (s: ReplayMarkersDialSurface, ctx: DialContext) => {
          setMarkers([]);
          await s.up(ctx.id);
        },
      ],
      [
        "a push + turn",
        async (s: ReplayMarkersDialSurface, ctx: DialContext) => {
          s.rotate(ctx as never, dial(), 1, true);
          await s.up(ctx.id);
        },
      ],
      [
        "a settings change mid-hold",
        async (s: ReplayMarkersDialSurface, ctx: DialContext) => {
          await s.didReceiveSettings(ctx as never, dial({ longPressAction: "none" }));
          await s.up(ctx.id);
        },
      ],
    ])("reverts on %s", async (_name, finish) => {
      setMarkers([5_000]);
      env.telemetry = replayAt(5_300);
      const surface = makeSurface();
      const ctx = dialContext();
      const d = dial();
      await appear(surface, ctx, d);

      surface.down(ctx as never, d);
      await vi.advanceTimersByTimeAsync(500);
      expect(lastBox(ctx)).toContain("data-pending-bar");

      await finish(surface, ctx);
      await settle();

      expect(lastBox(ctx)).not.toContain("data-pending-bar");
    });

    it("survives a tick mid-hold", async () => {
      setMarkers([5_000]);
      env.telemetry = replayAt(5_300);
      const surface = makeSurface();
      const ctx = dialContext();
      const d = dial();
      await appear(surface, ctx, d);

      surface.down(ctx as never, d);
      await vi.advanceTimersByTimeAsync(500);
      env.telemetry = replayAt(5_301);
      surface.onTick(ctx.id);
      await settle();

      expect(lastBox(ctx)).toContain("data-pending-bar");
    });

    it("with the extended gestures compiled out, constructs no helper: no timer, no frame", async () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
      setMarkers([5_000]);
      env.telemetry = replayAt(5_300);
      const surface = makeSurface();
      const ctx = dialContext("knob", KNOB);
      const d = dial();
      await appear(surface, ctx, d);
      ctx.setDialCanvas.mockClear();
      const timersBefore = vi.getTimerCount();

      surface.down(ctx as never, d);

      expect(vi.getTimerCount()).toBe(timersBefore);
      await vi.advanceTimersByTimeAsync(800);
      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
    });
  });

  describe("display", () => {
    async function shown(frames: number[], telemetry: TelemetryData | null, d = dial()): Promise<string> {
      setMarkers(frames);
      env.telemetry = telemetry;
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx, d);

      return lastBox(ctx);
    }

    it("labels the box MARKERS", async () => {
      expect(await shown([1_000], replayAt(500))).toContain(">MARKERS</text>");
    });

    it("shows k / N at a marker and up to 2 s past it, N outside that window", async () => {
      expect(shownValue(await shown([1_000, 2_000], replayAt(2_000)))).toBe("2 / 2");
      expect(shownValue(await shown([1_000, 2_000], replayAt(2_120)))).toBe("2 / 2");
      expect(shownValue(await shown([1_000, 2_000], replayAt(2_121)))).toBe("2");
      expect(shownValue(await shown([1_000, 2_000], replayAt(999)))).toBe("2");
    });

    it("shows NONE with no markers", async () => {
      expect(shownValue(await shown([], replayAt(500)))).toBe("NONE");
    });

    it.each([500, 2_000, 3_050, 3_200, 9_000])(
      "lights the side marks exactly where a turn would jump (frame %i)",
      async (frame) => {
        const svg = await shown([1_000, 3_000], replayAt(frame));
        const context = readReplayContext({
          getConnectionStatus: () => true,
          getCurrentTelemetry: () => replayAt(frame),
          getSessionInfo: () => null,
          getReplayState: steppedReplayState(() => replayAt(frame)).getReplayState,
          isStoreInitialized: () => true,
          getStore: () => store,
        });

        expect(context.ok).toBe(true);

        if (!context.ok) return;

        expect(sides(svg)).toEqual({
          left: resolveJumpTarget("previous", context) !== null,
          right: resolveJumpTarget("next", context) !== null,
        });
      },
    );

    it("from the car: both marks dimmed, the count, and the Add caption with the dial's Seconds back", async () => {
      const svg = await shown([1_000, 3_000], LIVE, dial({ secondsBack: 8 }));

      expect(sides(svg)).toEqual({ left: false, right: false });
      expect(shownValue(svg)).toBe("2");
      expect(svg).toMatch(/data-caption="true"[^>]*>ADD −8 s<\/text>/);
      expect(svg).not.toContain("data-dimmed");
    });

    it("captions an Add of 0 s back as ADD 0 s, never a negative zero", async () => {
      const svg = await shown([1_000], LIVE, dial({ secondsBack: 0 }));

      expect(svg).toMatch(/data-caption="true"[^>]*>ADD 0 s<\/text>/);
      expect(svg).not.toContain("−0");
    });

    it("no caption in a replay, nor when Press does not add", async () => {
      expect(await shown([1_000], replayAt(500))).not.toContain("data-caption");
      expect(await shown([1_000], LIVE, dial({ pressAction: "delete" }))).not.toContain("data-caption");
    });

    it.each([
      ["no store", () => (env.storeReady = false)],
      ["no telemetry", () => (env.telemetry = null)],
    ])("dims the whole box with %s", async (_name, breakIt) => {
      setMarkers([1_000]);
      breakIt();
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      expect(lastBox(ctx)).toContain('data-dimmed="true"');
    });

    it.each([
      ["strip", STRIP],
      ["knob", KNOB],
    ] as const)("a dimmed, empty box on the %s draws no side marks over the label", async (_name, canvas) => {
      setMarkers([1_000]);
      env.connected = false;
      const surface = makeSurface();
      const ctx = dialContext("dial-1", canvas);
      await appear(surface, ctx);

      expect(lastBox(ctx)).toContain('data-dimmed="true"');
      expect(lastBox(ctx)).not.toContain("data-side");
    });

    it("flashes ADDED k / N for CONFIRMATION_FLASH_MS, then shows the count", async () => {
      setMarkers([1_000]);
      env.telemetry = LIVE;
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      await press(surface, ctx, dial());
      await settle();
      expect(shownValue(lastBox(ctx))).toBe("ADDED 2 / 2");

      await vi.advanceTimersByTimeAsync(CONFIRMATION_FLASH_MS - 101);
      expect(shownValue(lastBox(ctx))).toBe("ADDED 2 / 2");

      await settle(1);
      await settle();
      expect(shownValue(lastBox(ctx))).toBe("2");
    });

    it("flashes DELETED after a delete; a press that does nothing flashes nothing", async () => {
      setMarkers([5_000]);
      env.telemetry = replayAt(5_300);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      await press(surface, ctx, dial(), 600);
      await settle();
      expect(shownValue(lastBox(ctx))).toBe("DELETED");

      await vi.advanceTimersByTimeAsync(CONFIRMATION_FLASH_MS);
      ctx.setDialCanvas.mockClear();
      await press(surface, ctx, dial(), 600);
      await settle();
      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
    });

    it("a playing replay with an unchanged display pushes no frame", async () => {
      setMarkers([1_000, 90_000]);
      env.telemetry = replayAt(5_000);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);
      ctx.setDialCanvas.mockClear();

      for (let frame = 5_000; frame < 5_600; frame += 1) {
        env.telemetry = replayAt(frame);
        surface.onTick(ctx.id);
        await vi.advanceTimersByTimeAsync(16);
      }

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
    });

    it("a change seen on a tick is pushed (another key added a marker)", async () => {
      setMarkers([1_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      setMarkers([1_000, 3_000]);
      surface.onTick(ctx.id);
      await settle();

      expect(shownValue(lastBox(ctx))).toBe("2");
    });

    it("a changed tick reads the replay context once: the flush draws the frame the tick built", async () => {
      setMarkers([1_000]);
      const inner = makeSurface()["host"];
      const readReplayContext = vi.fn(() => inner.readReplayContext());
      const surface = new ReplayMarkersDialSurface({
        logger: logger as never,
        readReplayContext,
        readTelemetry: () => inner.readTelemetry(),
      });
      const ctx = dialContext();
      await appear(surface, ctx);
      ctx.setDialCanvas.mockClear();
      readReplayContext.mockClear();

      setMarkers([1_000, 3_000]);
      surface.onTick(ctx.id);
      await settle();

      expect(ctx.setDialCanvas).toHaveBeenCalledTimes(1);
      expect(shownValue(lastBox(ctx))).toBe("2");
      expect(readReplayContext).toHaveBeenCalledTimes(1);
    });

    it("throttles pushes to at most 10 per second", async () => {
      setMarkers(Array.from({ length: 60 }, (_, i) => (i + 1) * 1_000));
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);
      ctx.setDialCanvas.mockClear();

      // Fifty detents in one second, each changing the display (k / N follows the target).
      for (let i = 0; i < 50; i++) {
        surface.rotate(ctx as never, dial(), 1, false);
        await vi.advanceTimersByTimeAsync(20);
      }

      await settle();

      expect(ctx.setDialCanvas.mock.calls.length).toBeLessThanOrEqual(11);
      expect(ctx.setDialCanvas.mock.calls.length).toBeGreaterThan(0);
      // The trailing flush shows the final state.
      expect(shownValue(lastBox(ctx))).toBe("50 / 60");
    });

    it("pushes nothing where the dial has no screen", async () => {
      setMarkers([1_000]);
      env.telemetry = LIVE;
      const surface = makeSurface();
      const ctx = dialContext("ulanzi", null);
      await appear(surface, ctx);
      await press(surface, ctx, dial());
      surface.onTick(ctx.id);
      await settle();

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
    });

    it("draws the knob at its own size", async () => {
      setMarkers([1_000]);
      const surface = makeSurface();
      const ctx = dialContext("knob", KNOB);
      await appear(surface, ctx);

      expect(lastBox(ctx)).toContain('viewBox="0 0 176 112"');
    });

    it("a context that disappeared is not drawn by a pending flush", async () => {
      setMarkers([1_000, 2_000]);
      env.telemetry = LIVE;
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);
      await press(surface, ctx, dial());
      ctx.setDialCanvas.mockClear();

      surface.willDisappear(ctx.id);
      await vi.advanceTimersByTimeAsync(CONFIRMATION_FLASH_MS * 2);

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
    });
  });

  describe("trigger descriptions", () => {
    it("describe rotation and the gestures, the long press as a hold hint", () => {
      expect(buildTriggerDescription(dial())).toEqual({
        rotate: "Next / previous marker",
        push: "Add marker (hold: Delete marker)",
      });
      expect(
        buildTriggerDescription(
          dial({ pressAction: "none", longPressAction: "add", tapAction: "delete", longTouchAction: "add" }),
        ),
      ).toEqual({
        rotate: "Next / previous marker",
        push: "Hold: Add marker",
        touch: "Delete marker",
        longTouch: "Add marker",
      });
    });

    it("are pushed on Elgato only", async () => {
      const surface = makeSurface();
      const elgato = dialContext("sd");
      await appear(surface, elgato);
      expect(elgato.setTriggerDescription).toHaveBeenCalledWith(buildTriggerDescription(dial()));

      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
      const knob = dialContext("knob", KNOB);
      await appear(surface, knob);
      expect(knob.setTriggerDescription).not.toHaveBeenCalled();
    });
  });
});
