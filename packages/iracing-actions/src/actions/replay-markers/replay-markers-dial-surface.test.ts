import type { ReplayMarker, ReplaySessionStore } from "@iracedeck/deck-core";
import { ReplayPosMode, type TelemetryData } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetReplayCursor,
  cancelReplayCursorOwner,
  claimReplayCursor,
  currentReplayCursorOwner,
} from "../../shared/replay-cursor.js";
import { buildTriggerDescription, ReplayMarkersDialSurface } from "./replay-markers-dial-surface.js";
import {
  CONFIRMATION_FLASH_MS,
  DIAL_LANDING_HOLD_MS,
  readReplayContext,
  REPLAY_EXIT_GRACE_MS,
  resolveJumpTarget,
} from "./replay-markers-ops.js";
import { ReplayMarkersDialSettings } from "./replay-markers-settings.js";

const mocks = vi.hoisted(() => ({
  setPlayPosition: vi.fn((_mode: number, _frame: number) => true),
  thresholdMs: { value: 500 },
}));

// The dial surface reads the replay commands through deck-iracing; this suite
// mocks deck-core without a ConnectionStateAwareAction, so the real barrel (whose
// SimIRacingAction extends it) cannot load.
vi.mock("@iracedeck/deck-iracing", () => ({
  getCommands: () => ({ replay: { setPlayPosition: mocks.setPlayPosition } }),
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
    classifyDialRelease: dialGesture.classifyDialRelease,
    IconUpdateThrottle: throttle.IconUpdateThrottle,
    getDualPressThresholdMs: () => mocks.thresholdMs.value,
    applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
    escapeXml: (str: string) => str,
    // Identity, so a test reads the pushed SVG straight off `setDialCanvas`.
    svgToDataUri: (svg: string) => svg,
    MARKER_DEDUPE_FRAMES: 60,
    MARKER_DELETE_WINDOW_FRAMES: 600,
    MARKER_PREVIOUS_MIN_BEHIND_FRAMES: 120,
  };
});

// The store's own pure marker functions, so the fake store answers next /
// previous / add / delete exactly as the real one does.
const markerFns = await vi.importActual<typeof import("../../../../deck-core/src/replay-markers.js")>(
  "../../../../deck-core/src/replay-markers.js",
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
  next: vi.fn((frame: number, _scope?: unknown) => markerFns.nextMarker(env.markers, frame)),
  previous: vi.fn((frame: number, _scope?: unknown) => markerFns.previousMarker(env.markers, frame)),
  list: vi.fn((_scope?: unknown) => env.markers.map((m) => ({ ...m }))),
};
const store = { markers: storeMarkers, getActiveSession: () => env.active } as unknown as ReplaySessionStore;

function setMarkers(frames: number[]): void {
  env.markers = frames.map((frame) => ({ frame, pressFrame: frame, sessionNum: 0, sessionTimeMs: 0 }));
}

function replayAt(frame: number): TelemetryData {
  return {
    IsReplayPlaying: true,
    ReplayFrameNum: frame,
    ReplayFrameNumEnd: 100_000,
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

function makeSurface(): ReplayMarkersDialSurface {
  return new ReplayMarkersDialSurface({
    logger: logger as never,
    readReplayContext: () =>
      readReplayContext({
        getConnectionStatus: () => env.connected,
        getCurrentTelemetry: () => env.telemetry,
        getSessionInfo: () => ({ WeekendInfo: { SubSessionID: 42 } }),
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
    env.connected = true;
    env.storeReady = true;
    env.telemetry = replayAt(500);
    env.active = { subSessionId: 42 };
    setMarkers([]);
    mocks.thresholdMs.value = 500;
    mocks.setPlayPosition.mockReturnValue(true);
  });

  afterEach(() => {
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

      await vi.advanceTimersByTimeAsync(DIAL_LANDING_HOLD_MS);
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

  describe("the pending landing", () => {
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

    it("after DIAL_LANDING_HOLD_MS the live frame anchors again", async () => {
      setMarkers([1_000, 2_000, 3_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      surface.rotate(ctx as never, dial(), 1, false);
      await vi.advanceTimersByTimeAsync(DIAL_LANDING_HOLD_MS);
      surface.rotate(ctx as never, dial(), 1, false);

      // The replay never moved off 500, so the store's Next from there is 1 000 again.
      expect(mocks.setPlayPosition.mock.calls.map((c) => c[1])).toEqual([1_000, 1_000]);
    });

    it("once telemetry reaches the target, the live frame anchors again", async () => {
      setMarkers([1_000, 2_000, 3_000, 4_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      surface.rotate(ctx as never, dial(), 2, false);
      env.telemetry = replayAt(2_010);
      surface.onTick(ctx.id);
      // The driver then moves the replay on by other means, inside the hold.
      env.telemetry = replayAt(3_500);
      surface.rotate(ctx as never, dial(), 1, false);

      expect(mocks.setPlayPosition.mock.calls.map((c) => c[1])).toEqual([2_000, 4_000]);
    });

    it("a jump that was not sent leaves no landing: the next turn measures from the live frame", async () => {
      setMarkers([1_000, 2_000, 3_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      mocks.setPlayPosition.mockReturnValueOnce(false);
      surface.rotate(ctx as never, dial(), 1, false);
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

    it("anything else taking the replay cursor clears it", async () => {
      setMarkers([1_000, 2_000, 3_000]);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      surface.rotate(ctx as never, dial(), 1, false);
      // A Replay Control seek, say: it takes the cursor in its own name.
      cancelReplayCursorOwner("rewind");
      surface.rotate(ctx as never, dial(), 1, false);

      // Measured from the live 500 again, not from the 1 000 the dial sent.
      expect(mocks.setPlayPosition.mock.calls.map((c) => c[1])).toEqual([1_000, 1_000]);
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
      // The replay lands; a new claim would clear a pending landing anyway.
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
      const surface = new ReplayMarkersDialSurface({ logger: logger as never, readReplayContext });
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

      // Fifty detents in one second, each changing the display (k / N follows the landing).
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
