import { ReplayPosMode, replaySpeedFromTelemetry, replaySpeedToSdk, type TelemetryData } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetReplayCursor,
  cancelReplayCursorOwner,
  claimReplayCursor,
  clearReplayLanding,
  currentReplayCursorOwner,
  pendingReplayLanding,
  recordReplayLanding,
} from "../../shared/replay-cursor.js";
import type { ReplayDialModeIo, ReplaySpeed } from "./replay-control-dial-mode.js";
import { REPLAY_DIAL_MODES, ReplayControlDialSettings } from "./replay-control-dial-settings.js";
import {
  buildTriggerDescription,
  DIAL_MODES,
  ReplayControlDialSurface,
  type ReplayDialReading,
} from "./replay-control-dial-surface.js";
import { frameJogMode } from "./replay-control-frame-jog.js";
import { speedMode } from "./replay-control-speed-mode.js";
import { _resetReplayPositionState, REPLAY_TARGET_GIVE_UP_MS } from "./replay-position-state.js";
import {
  _resetReplaySpeedState,
  DIAL_SPEED_HOLD_MS,
  noteTelemetrySpeed,
  rememberedSpeed,
} from "./replay-speed-state.js";

const mocks = vi.hoisted(() => ({
  setPlaySpeed: vi.fn((_speed: number, _slowMotion?: boolean) => true),
  pause: vi.fn(() => true),
  nextFrame: vi.fn(() => true),
  prevFrame: vi.fn(() => true),
  setPlayPosition: vi.fn((_mode: number, _frame: number) => true),
  thresholdMs: { value: 500 },
}));

// The dial surface reads the replay commands through deck-iracing; this suite
// mocks deck-core without a ConnectionStateAwareAction, so the real barrel (whose
// SimIRacingAction extends it) cannot load.
vi.mock("@iracedeck/deck-iracing", () => ({
  getCommands: () => ({
    replay: {
      setPlaySpeed: mocks.setPlaySpeed,
      pause: mocks.pause,
      nextFrame: mocks.nextFrame,
      prevFrame: mocks.prevFrame,
      setPlayPosition: mocks.setPlayPosition,
    },
  }),
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

  return {
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

const STRIP = { id: "sd-plus-strip", width: 200, height: 100 } as const;
const KNOB = { id: "stream-dock-knob", width: 176, height: 112 } as const;

function speed(value: number, slowMotion = false): ReplaySpeed {
  return { speed: value, slowMotion };
}

const PAUSED = speed(0);

/** A replay tick playing at `s`, in the raw values iRacing reports (#1202). */
function replayAt(s: ReplaySpeed): TelemetryData {
  return {
    IsReplayPlaying: true,
    ReplayPlaySpeed: replaySpeedToSdk(s.speed, s.slowMotion),
    ReplayPlaySlowMotion: s.slowMotion,
    ReplayFrameNum: 5_000,
  } as TelemetryData;
}

const env = {
  /** The host's debounced "a replay is on screen". */
  inReplay: true,
  /** What a fresh telemetry read returns. */
  telemetry: null as TelemetryData | null,
};

/** A tick as the owning action hands it over, carrying `telemetry` (what a fresh read returns, unless given). */
function tickOf(telemetry: TelemetryData | null = env.telemetry): ReplayDialReading {
  return { telemetry, speed: telemetry ? replaySpeedFromTelemetry(telemetry) : null };
}

/** Telemetry catches up with a command: the replay now plays at `s`. */
function nowPlaying(s: ReplaySpeed): void {
  env.telemetry = replayAt(s);
}

const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const host = {
  /** The fresh read; a mock so a test can count the native reads an entry takes. */
  telemetry: vi.fn(() => env.telemetry),
  setLocalSpeed: vi.fn((_speed: number, _slowMotion: boolean) => undefined),
  jumpToLive: vi.fn(() => undefined),
  refreshKeys: vi.fn(() => undefined),
};

function makeSurface(): ReplayControlDialSurface {
  return new ReplayControlDialSurface({
    logger: logger as never,
    inReplay: () => env.inReplay,
    telemetry: host.telemetry,
    setLocalSpeed: host.setLocalSpeed,
    jumpToLive: host.jumpToLive,
    refreshKeys: host.refreshKeys,
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

function dial(overrides: Record<string, unknown> = {}): ReplayControlDialSettings {
  return ReplayControlDialSettings.parse(overrides);
}

function lastBox(ctx: DialContext): string {
  return ctx.setDialCanvas.mock.calls.at(-1)?.[0] ?? "";
}

/** The value slot's text: the last `<text>` that is neither the caption nor the label. */
function shownValue(svg: string): string {
  const texts = [...svg.matchAll(/<text(?! data-caption)[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

  return texts.filter((t) => t !== "SPEED" && t !== "FRAME").at(-1) ?? "";
}

function shownCaption(svg: string): string {
  return /<text data-caption[^>]*>([^<]*)<\/text>/.exec(svg)?.[1] ?? "";
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

async function appear(surface: ReplayControlDialSurface, ctx: DialContext, d = dial()): Promise<void> {
  await surface.willAppear(ctx as never, d);
  await settle();
}

async function press(surface: ReplayControlDialSurface, ctx: DialContext, d: ReplayControlDialSettings, holdMs = 0) {
  surface.down(ctx as never, d);

  if (holdMs > 0) await vi.advanceTimersByTimeAsync(holdMs);

  await surface.up(ctx.id);
}

/** A surface with one dial on screen, in a replay playing at `s`. */
async function onScreen(s: ReplaySpeed, d = dial(), ctx = dialContext()) {
  nowPlaying(s);
  const surface = makeSurface();
  await appear(surface, ctx, d);

  return { surface, ctx, d };
}

function expectNothingSent(): void {
  expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
  expect(mocks.pause).not.toHaveBeenCalled();
  expect(host.jumpToLive).not.toHaveBeenCalled();
}

describe("ReplayControlDialSurface", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    _resetReplayCursor();
    _resetReplaySpeedState();
    _resetReplayPositionState();
    env.inReplay = true;
    env.telemetry = replayAt(speed(1));
    mocks.thresholdMs.value = 500;
    mocks.setPlaySpeed.mockReturnValue(true);
    mocks.pause.mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("rotation (Speed Control)", () => {
    it.each<[string, ReplaySpeed, number, [number, boolean]]>([
      ["clockwise from 1x", speed(1), 1, [2, false]],
      ["counter-clockwise from 1x", speed(1), -1, [2, true]],
      ["clockwise from -8x", speed(-8), 1, [-4, false]],
      ["clockwise out of pause", PAUSED, 1, [4, true]],
      ["counter-clockwise out of pause", PAUSED, -1, [-4, true]],
      ["counter-clockwise into pause", speed(4, true), -1, [0, false]],
      ["three detents", speed(1), 3, [8, false]],
      ["a spin longer than the ladder", speed(1), -40, [-8, false]],
      ["off the ladder at 3x", speed(3), 1, [4, false]],
    ])("sends one setPlaySpeed to the stop reached: %s", async (_name, live, ticks, expected) => {
      const { surface, ctx, d } = await onScreen(live);

      surface.rotate(ctx as never, d, ticks, false);

      expect(mocks.setPlaySpeed).toHaveBeenCalledTimes(1);
      expect(mocks.setPlaySpeed).toHaveBeenCalledWith(...expected);
      expect(mocks.pause).not.toHaveBeenCalled();
    });

    it("sends nothing at a ladder end, either way", async () => {
      const { surface, ctx, d } = await onScreen(speed(8));

      surface.rotate(ctx as never, d, 1, false);
      surface.rotate(ctx as never, d, 6, false);
      nowPlaying(speed(-8));
      surface.rotate(ctx as never, d, -1, false);

      expectNothingSent();
    });

    it("a zero-tick event sends nothing", async () => {
      const { surface, ctx, d } = await onScreen(speed(1));

      surface.rotate(ctx as never, d, 0, false);

      expectNothingSent();
    });

    it("walks the ladder of the dial it turns, read from the event's settings", async () => {
      const { surface, ctx } = await onScreen(speed(8));

      surface.rotate(ctx as never, dial({ speedStops: { "16": true } }), 1, false);

      expect(mocks.setPlaySpeed).toHaveBeenCalledWith(16, false);
    });

    it("tells the action's own speed cache and redraws its keys after a send", async () => {
      const { surface, ctx, d } = await onScreen(speed(1));

      surface.rotate(ctx as never, d, 1, false);

      expect(host.setLocalSpeed).toHaveBeenCalledWith(2, false);
      expect(host.refreshKeys).toHaveBeenCalledTimes(1);
    });

    it("a send iRacing did not take leaves no pending speed and tells nobody", async () => {
      mocks.setPlaySpeed.mockReturnValue(false);
      const { surface, ctx, d } = await onScreen(speed(1));

      surface.rotate(ctx as never, d, 1, false);
      surface.rotate(ctx as never, d, 1, false);

      // Both turns walked from the live 1x.
      expect(mocks.setPlaySpeed.mock.calls).toEqual([
        [2, false],
        [2, false],
      ]);
      expect(host.setLocalSpeed).not.toHaveBeenCalled();
      expect(rememberedSpeed()).toEqual(speed(1));
    });
  });

  describe("the pending speed", () => {
    it("a second detent before telemetry catches up steps on from the speed just sent", async () => {
      const { surface, ctx, d } = await onScreen(speed(1));

      surface.rotate(ctx as never, d, 1, false);
      await vi.advanceTimersByTimeAsync(20);
      surface.rotate(ctx as never, d, 1, false);
      await vi.advanceTimersByTimeAsync(20);
      surface.rotate(ctx as never, d, 1, false);

      expect(mocks.setPlaySpeed.mock.calls).toEqual([
        [2, false],
        [4, false],
        [8, false],
      ]);
    });

    it("shows the speed just sent while the tick still carries the old one", async () => {
      const { surface, ctx, d } = await onScreen(speed(1));

      surface.rotate(ctx as never, d, 1, false);
      surface.onTick(ctx.id, tickOf());
      await settle();

      expect(shownValue(lastBox(ctx))).toBe("2x");
    });

    it("after DIAL_SPEED_HOLD_MS the telemetry speed is the live one again", async () => {
      const { surface, ctx, d } = await onScreen(speed(1));

      surface.rotate(ctx as never, d, 1, false);
      await vi.advanceTimersByTimeAsync(DIAL_SPEED_HOLD_MS);
      surface.rotate(ctx as never, d, 1, false);

      expect(mocks.setPlaySpeed).toHaveBeenLastCalledWith(2, false);
    });

    it("once telemetry has reported the send, a speed set elsewhere is walked from", async () => {
      const { surface, ctx, d } = await onScreen(speed(1));

      surface.rotate(ctx as never, d, 1, false);
      nowPlaying(speed(2));
      surface.onTick(ctx.id, tickOf());
      // A key, or iRacing's own replay bar, sets 1/2x inside what was the hold.
      nowPlaying(speed(2, true));
      surface.rotate(ctx as never, d, 1, false);

      expect(mocks.setPlaySpeed).toHaveBeenLastCalledWith(1, false);
    });

    it("is one value shared by every dial: a second dial steps on from the first dial's send", async () => {
      const { surface, ctx, d } = await onScreen(speed(1));
      const other = dialContext("dial-2");
      await appear(surface, other);

      surface.rotate(ctx as never, d, 1, false);
      surface.rotate(other as never, d, 1, false);
      await settle();

      expect(mocks.setPlaySpeed).toHaveBeenLastCalledWith(4, false);
      expect(shownValue(lastBox(ctx))).toBe("4x");
      expect(shownValue(lastBox(other))).toBe("4x");
    });
  });

  describe("one reading of the replay per entry", () => {
    /** Long enough for every throttle window and timer of the setup to be over. */
    async function quiet(): Promise<void> {
      await vi.advanceTimersByTimeAsync(2_000);
      host.telemetry.mockClear();
    }

    it("a tick is evaluated against the tick it was handed, with no telemetry read of its own", async () => {
      const { surface, ctx } = await onScreen(speed(1));
      await quiet();

      // The delivered tick says 2x; a fresh read would still say 1x.
      surface.onTick(ctx.id, tickOf(replayAt(speed(2))));
      await settle();

      expect(shownValue(lastBox(ctx))).toBe("2x");
      expect(host.telemetry).not.toHaveBeenCalled();
    });

    it("a tick that changes nothing reads nothing either", async () => {
      const { surface, ctx } = await onScreen(speed(1));
      await quiet();

      for (let i = 0; i < 60; i++) surface.onTick(ctx.id, tickOf());

      expect(host.telemetry).not.toHaveBeenCalled();
    });

    it("a turn takes one fresh read for everything it does, every dial's redraw included", async () => {
      const { surface, ctx, d } = await onScreen(speed(1));
      await appear(surface, dialContext("dial-2"));
      await quiet();

      surface.rotate(ctx as never, d, 1, false);

      expect(mocks.setPlaySpeed).toHaveBeenCalledWith(2, false);
      expect(host.telemetry).toHaveBeenCalledTimes(1);
    });

    it("a turn that sends nothing still takes no more than one", async () => {
      const { surface, ctx, d } = await onScreen(speed(8));
      await quiet();

      surface.rotate(ctx as never, d, 1, false);

      expect(host.telemetry).toHaveBeenCalledTimes(1);
    });

    it("a press takes none going down and one at its release", async () => {
      const { surface, ctx, d } = await onScreen(speed(4));
      await quiet();

      surface.down(ctx as never, d);
      expect(host.telemetry).not.toHaveBeenCalled();

      await surface.up(ctx.id);
      expect(mocks.pause).toHaveBeenCalledTimes(1);
      expect(host.telemetry).toHaveBeenCalledTimes(1);
    });

    it("the hold preview's threshold takes one, and the release after it one more", async () => {
      const { surface, ctx, d } = await onScreen(speed(4));
      await quiet();

      surface.down(ctx as never, d);
      await vi.advanceTimersByTimeAsync(500);
      expect(lastBox(ctx)).toContain("data-pending-bar");
      expect(host.telemetry).toHaveBeenCalledTimes(1);

      await surface.up(ctx.id);
      expect(host.telemetry).toHaveBeenCalledTimes(2);
    });

    it("a touch takes one", async () => {
      const d = dial({ tapAction: "play-pause" });
      const { surface, ctx } = await onScreen(speed(4), d);
      await quiet();

      surface.touchTap(ctx as never, d, false);

      expect(mocks.pause).toHaveBeenCalledTimes(1);
      expect(host.telemetry).toHaveBeenCalledTimes(1);
    });

    it("a flush that builds its own frame takes one: a dial appearing", async () => {
      nowPlaying(speed(1));
      const surface = makeSurface();
      const ctx = dialContext();
      host.telemetry.mockClear();

      await surface.willAppear(ctx as never, dial());
      await settle();

      expect(shownValue(lastBox(ctx))).toBe("1x");
      expect(host.telemetry).toHaveBeenCalledTimes(1);
    });

    it("the lapse timer takes one", async () => {
      const { surface, ctx, d } = await onScreen(PAUSED);
      surface.rotate(ctx as never, d, 1, false);
      await settle();
      host.telemetry.mockClear();

      await vi.advanceTimersByTimeAsync(DIAL_SPEED_HOLD_MS + 150);

      expect(shownValue(lastBox(ctx))).toBe("PAUSED");
      expect(host.telemetry).toHaveBeenCalledTimes(1);
    });

    it("keeps no reading between entries", async () => {
      const { surface, ctx, d } = await onScreen(speed(1));

      surface.rotate(ctx as never, d, 1, false);
      expect(surface["entryReading"]).toBeNull();
      expect(surface["inEntry"]).toBe(false);

      surface.onTick(ctx.id, tickOf());
      expect(surface["entryReading"]).toBeNull();

      await press(surface, ctx, d);
      expect(surface["entryReading"]).toBeNull();
      expect(surface["inEntry"]).toBe(false);
    });

    it("never decides from an earlier entry's reading: what changed with no tick is seen by the next input", async () => {
      noteTelemetrySpeed(speed(4), Date.now());
      const { surface, ctx, d } = await onScreen(speed(4));
      surface.onTick(ctx.id, tickOf());
      await quiet();

      // The replay is paused from iRacing's own bar, on a frame that delivers no tick.
      nowPlaying(PAUSED);
      await press(surface, ctx, d);

      // Play/Pause read it fresh: it resumes, where the last tick's 4x would have paused.
      expect(mocks.pause).not.toHaveBeenCalled();
      expect(mocks.setPlaySpeed).toHaveBeenCalledWith(4, false);
    });

    it("a tick's reading does not outlive the tick", async () => {
      const { surface, ctx, d } = await onScreen(speed(1));
      await quiet();

      // A stale tick is delivered last, then the dial is turned: the turn reads for itself.
      nowPlaying(speed(4));
      surface.onTick(ctx.id, tickOf(replayAt(speed(1))));
      surface.rotate(ctx as never, d, 1, false);

      expect(mocks.setPlaySpeed).toHaveBeenCalledWith(8, false);
    });

    it("drops the reading when an entry throws, so the next one reads for itself", async () => {
      const { surface, ctx, d } = await onScreen(speed(1));
      const rotate = vi.spyOn(speedMode, "rotate").mockImplementationOnce(() => {
        throw new Error("mode failed");
      });

      expect(() => surface.rotate(ctx as never, d, 1, false)).toThrow("mode failed");
      expect(surface["inEntry"]).toBe(false);
      expect(surface["entryReading"]).toBeNull();

      nowPlaying(speed(4));
      surface.rotate(ctx as never, d, 1, false);

      expect(mocks.setPlaySpeed).toHaveBeenCalledWith(8, false);
      rotate.mockRestore();
    });

    it("a mode reading outside any entry gets a fresh reading each time, kept nowhere", async () => {
      const { surface } = await onScreen(speed(1));
      const io = surface["io"];

      expect(io.liveSpeed()).toEqual(speed(1));

      nowPlaying(speed(2));
      expect(io.liveSpeed()).toEqual(speed(2));
      expect(io.telemetry()).toBe(env.telemetry);
      expect(surface["entryReading"]).toBeNull();
    });
  });

  describe("a pause whose effect delivers no tick", () => {
    it("is still shown by the lapse redraw, and the next Play/Pause resumes", async () => {
      noteTelemetrySpeed(speed(1), Date.now());
      const { surface, ctx, d } = await onScreen(speed(1));
      surface.onTick(ctx.id, tickOf());

      await press(surface, ctx, d);
      expect(mocks.pause).toHaveBeenCalledTimes(1);

      // The pause lands on a frame that does not advance SessionTick: a fresh
      // read reports 0, and no subscriber is told.
      nowPlaying(PAUSED);
      await vi.advanceTimersByTimeAsync(DIAL_SPEED_HOLD_MS + 150);

      expect(shownValue(lastBox(ctx))).toBe("PAUSED");
      expect(shownCaption(lastBox(ctx))).toBe("► 1x");

      await press(surface, ctx, d);

      expect(mocks.pause).toHaveBeenCalledTimes(1);
      expect(mocks.setPlaySpeed).toHaveBeenCalledWith(1, false);
    });
  });

  describe("a send iRacing does not act on", () => {
    /** The hold, the lapse timer's margin and a throttle window. */
    const PAST_THE_LAPSE = DIAL_SPEED_HOLD_MS + 150;

    it("comes off the dial when the hold runs out, with no tick to say so", async () => {
      noteTelemetrySpeed(speed(2), Date.now());
      // Paused at the end of a saved recording: iRacing will not play on.
      const { surface, ctx, d } = await onScreen(PAUSED);
      expect(shownCaption(lastBox(ctx))).toBe("► 2x");

      surface.rotate(ctx as never, d, 1, false);
      await settle();
      expect(shownValue(lastBox(ctx))).toBe("1/4x");

      // No tick follows: nothing changed in the sim.
      await vi.advanceTimersByTimeAsync(PAST_THE_LAPSE);

      expect(shownValue(lastBox(ctx))).toBe("PAUSED");
      // The speed that never played is not what Play/Pause would resume.
      expect(shownCaption(lastBox(ctx))).toBe("► 2x");
      expect(rememberedSpeed()).toEqual(speed(2));
    });

    it("redraws every dial that showed it", async () => {
      const { surface, ctx, d } = await onScreen(PAUSED);
      const other = dialContext("dial-2");
      await appear(surface, other);

      surface.rotate(ctx as never, d, 1, false);
      await settle();
      expect(shownValue(lastBox(other))).toBe("1/4x");

      await vi.advanceTimersByTimeAsync(PAST_THE_LAPSE);

      expect(shownValue(lastBox(ctx))).toBe("PAUSED");
      expect(shownValue(lastBox(other))).toBe("PAUSED");
    });

    it("is one timer, moved by the next send", async () => {
      const { surface, ctx, d } = await onScreen(PAUSED);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(vi.getTimerCount()).toBe(0);

      surface.rotate(ctx as never, d, 1, false);
      await vi.advanceTimersByTimeAsync(300);
      surface.rotate(ctx as never, d, 1, false);
      await vi.advanceTimersByTimeAsync(150);

      expect(vi.getTimerCount()).toBe(1);
      // The first send's hold would have run out by now; the second one's stands.
      await vi.advanceTimersByTimeAsync(150);
      expect(shownValue(lastBox(ctx))).toBe("1/2x");

      await vi.advanceTimersByTimeAsync(PAST_THE_LAPSE);
      expect(shownValue(lastBox(ctx))).toBe("PAUSED");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("sends nothing at the lapse: it redraws, and resyncs the action's speed cache", async () => {
      const { surface, ctx, d } = await onScreen(PAUSED);
      surface.rotate(ctx as never, d, 1, false);
      await settle();
      vi.clearAllMocks();

      await vi.advanceTimersByTimeAsync(PAST_THE_LAPSE);

      expectNothingSent();
      expect(ctx.setDialCanvas).toHaveBeenCalledTimes(1);
      expect(host.setLocalSpeed).toHaveBeenCalledTimes(1);
      expect(host.refreshKeys).toHaveBeenCalledTimes(1);
    });

    it("takes the ignored speed back out of the action's cache, so a Play/Pause key reads the replay as paused", async () => {
      const { surface, ctx, d } = await onScreen(PAUSED);

      surface.rotate(ctx as never, d, 1, false);
      // The send put its speed in the cache at once, for the keys.
      expect(host.setLocalSpeed.mock.calls).toEqual([[4, true]]);
      expect(host.refreshKeys).toHaveBeenCalledTimes(1);

      // No tick follows: the replay never left 0x.
      await vi.advanceTimersByTimeAsync(PAST_THE_LAPSE);

      expect(host.setLocalSpeed.mock.calls).toEqual([
        [4, true],
        [0, false],
      ]);
      expect(host.refreshKeys).toHaveBeenCalledTimes(2);
      // The cache was written before the keys were asked to redraw from it.
      expect(host.setLocalSpeed.mock.invocationCallOrder[1]).toBeLessThan(host.refreshKeys.mock.invocationCallOrder[1]);
    });

    it("writes the same speed back when the send took, so nothing changes for the keys", async () => {
      const { surface, ctx, d } = await onScreen(PAUSED);
      surface.rotate(ctx as never, d, 1, false);
      nowPlaying(speed(4, true));

      await vi.advanceTimersByTimeAsync(PAST_THE_LAPSE);

      expect(host.setLocalSpeed.mock.calls).toEqual([
        [4, true],
        [4, true],
      ]);
    });

    it("resyncs from what a fresh read says at the lapse, whatever the last tick said", async () => {
      const { surface, ctx, d } = await onScreen(speed(1));
      surface.onTick(ctx.id, tickOf());
      await press(surface, ctx, d);
      expect(host.setLocalSpeed).toHaveBeenLastCalledWith(0, false);

      // iRacing's own bar resumes at 2x inside the hold, on a frame that delivers no tick.
      nowPlaying(speed(2));
      await vi.advanceTimersByTimeAsync(PAST_THE_LAPSE);

      expect(host.setLocalSpeed).toHaveBeenLastCalledWith(2, false);
      expect(shownValue(lastBox(ctx))).toBe("2x");
    });

    it("draws nothing when telemetry reported the send in time", async () => {
      const { surface, ctx, d } = await onScreen(PAUSED);
      surface.rotate(ctx as never, d, 1, false);
      nowPlaying(speed(4, true));
      surface.onTick(ctx.id, tickOf());
      await settle();
      ctx.setDialCanvas.mockClear();
      const stampedAt = surface["renderThrottle"].lastImageSentAt.get(ctx.id);

      await vi.advanceTimersByTimeAsync(PAST_THE_LAPSE);

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
      expect(surface["renderThrottle"].lastImageSentAt.get(ctx.id)).toBe(stampedAt);
      expect(rememberedSpeed()).toEqual(speed(4, true));
    });

    it("a dial that comes back inside the hold is redrawn when it lapses (a page flip and back)", async () => {
      const { surface, ctx, d } = await onScreen(PAUSED);

      surface.rotate(ctx as never, d, 1, false);
      await settle();
      expect(shownValue(lastBox(ctx))).toBe("1/4x");

      // The page is flipped away and back, well inside the hold.
      surface.willDisappear(ctx.id);
      await vi.advanceTimersByTimeAsync(50);
      const back = dialContext(ctx.id);
      await appear(surface, back, d);
      // The pending speed outlived the dial, so the dial draws it.
      expect(shownValue(lastBox(back))).toBe("1/4x");

      await vi.advanceTimersByTimeAsync(PAST_THE_LAPSE);

      expect(shownValue(lastBox(back))).toBe("PAUSED");
    });

    it("with no dial on screen at the lapse it draws nothing, and still resyncs the action's speed cache", async () => {
      const { surface, ctx, d } = await onScreen(PAUSED);
      surface.rotate(ctx as never, d, 1, false);
      await settle();
      surface.willDisappear(ctx.id);
      vi.clearAllMocks();

      await vi.advanceTimersByTimeAsync(PAST_THE_LAPSE);

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
      expect(host.setLocalSpeed.mock.calls).toEqual([[0, false]]);
      expect(host.refreshKeys).toHaveBeenCalledTimes(1);
      expectNothingSent();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("the last dial disappearing leaves the timer running: the pending speed it answers for is still there", async () => {
      const { surface, ctx, d } = await onScreen(PAUSED);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(vi.getTimerCount()).toBe(0);

      surface.rotate(ctx as never, d, 1, false);
      await settle();
      surface.willDisappear(ctx.id);

      expect(vi.getTimerCount()).toBe(1);
    });

    it("a frame step arms no speed hold: only the timer that follows the step, gone once it reads back", async () => {
      const d = dial({ mode: "frame-jog" });
      const { surface, ctx } = await onScreen(PAUSED, d);
      await vi.advanceTimersByTimeAsync(1_000);

      surface.rotate(ctx as never, d, 1, false);

      expect(mocks.nextFrame).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      env.telemetry = { ...replayAt(PAUSED), ReplayFrameNum: 5_001 } as TelemetryData;
      await vi.advanceTimersByTimeAsync(200);

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("the seam a rotation mode sends through", () => {
    function ioOf(surface: ReplayControlDialSurface): ReplayDialModeIo {
      return surface["io"];
    }

    it("pause records 0x as the live speed at once, whatever the next tick carries", async () => {
      const { surface, ctx } = await onScreen(speed(4));
      const io = ioOf(surface);

      expect(io.pause("dial-frame-jog")).toBe(true);

      expect(mocks.pause).toHaveBeenCalledTimes(1);
      expect(io.liveSpeed()).toEqual(PAUSED);
      // The tick still says 4x: the pause holds, like a sent speed does.
      surface.onTick(ctx.id, tickOf());
      await vi.advanceTimersByTimeAsync(DIAL_SPEED_HOLD_MS - 1);
      expect(io.liveSpeed()).toEqual(PAUSED);
      expect(host.setLocalSpeed).toHaveBeenCalledWith(0, false);
      expect(host.refreshKeys).toHaveBeenCalled();
    });

    it("pause leaves the remembered speed alone, so Press resumes what was playing", async () => {
      noteTelemetrySpeed(speed(4), Date.now());
      const { surface, ctx, d } = await onScreen(speed(4));

      ioOf(surface).pause("dial-frame-jog");
      expect(rememberedSpeed()).toEqual(speed(4));

      await press(surface, ctx, d);
      expect(mocks.setPlaySpeed).toHaveBeenCalledWith(4, false);
    });

    it("a mode that pauses on its first detent does not pause again on a second one inside the hold", async () => {
      const { surface } = await onScreen(speed(1));
      const io = ioOf(surface);
      const jog = () => {
        if (io.liveSpeed().speed !== 0) io.pause("dial-frame-jog");

        io.send("dial-frame-jog", (replay) => replay.nextFrame());
      };

      jog();
      await vi.advanceTimersByTimeAsync(30);
      jog();

      expect(mocks.pause).toHaveBeenCalledTimes(1);
      expect(mocks.nextFrame).toHaveBeenCalledTimes(2);
    });

    it("a pause iRacing did not take records nothing", async () => {
      mocks.pause.mockReturnValue(false);
      const { surface } = await onScreen(speed(4));
      const io = ioOf(surface);

      expect(io.pause("dial-frame-jog")).toBe(false);

      expect(io.liveSpeed()).toEqual(speed(4));
      expect(host.setLocalSpeed).not.toHaveBeenCalled();
    });

    it("setSpeed remembers a non-zero target as the resume speed, and never a 0", async () => {
      const { surface } = await onScreen(speed(1));
      const io = ioOf(surface);

      io.setSpeed("dial-speed", speed(-4, true));
      expect(rememberedSpeed()).toEqual(speed(-4, true));
      expect(mocks.setPlaySpeed).toHaveBeenLastCalledWith(-4, true);

      io.setSpeed("dial-speed", PAUSED);
      expect(rememberedSpeed()).toEqual(speed(-4, true));
      expect(io.liveSpeed()).toEqual(PAUSED);
    });

    it("hands a mode the latest raw tick", async () => {
      const { surface } = await onScreen(speed(1));

      expect(ioOf(surface).telemetry()).toBe(env.telemetry);
    });
  });

  describe("the replay cursor", () => {
    it("is cancelled under a dial- name before every send", async () => {
      const { surface, ctx } = await onScreen(speed(1));
      const cancelledBy: string[] = [];
      const sentWhenCancelled: number[] = [];
      const sends = () => mocks.setPlaySpeed.mock.calls.length + mocks.pause.mock.calls.length;
      const claim = () =>
        claimReplayCursor("fastest-lap", (by) => {
          cancelledBy.push(by);
          sentWhenCancelled.push(sends());
        });

      claim();
      surface.rotate(ctx as never, dial(), 1, false);
      claim();
      await press(surface, ctx, dial({ pressAction: "play-pause" }));
      claim();
      await press(surface, ctx, dial({ pressAction: "play-pause" }));
      claim();
      await press(surface, ctx, dial({ pressAction: "set-1x-play" }));
      claim();
      await press(surface, ctx, dial({ pressAction: "reverse" }));

      expect(cancelledBy).toEqual(["dial-speed", "dial-play-pause", "dial-play-pause", "dial-set-1x", "dial-reverse"]);
      // Each cancel came before its own send.
      expect(sentWhenCancelled).toEqual([0, 1, 2, 3, 4]);
      expect(sends()).toBe(5);
    });

    it("is never cancelled when nothing is sent", async () => {
      const { surface, ctx } = await onScreen(speed(8));
      claimReplayCursor("fastest-lap");

      // At the ladder's end.
      surface.rotate(ctx as never, dial(), 1, false);
      // None, and Reverse while paused.
      await press(surface, ctx, dial({ pressAction: "none" }));
      nowPlaying(PAUSED);
      await press(surface, ctx, dial({ pressAction: "reverse" }));

      expectNothingSent();
      expect(currentReplayCursorOwner()).toBe("fastest-lap");
    });
  });

  describe("moving the replay by frames (the seam)", () => {
    function ioOf(surface: ReplayControlDialSurface): ReplayDialModeIo {
      return surface["io"];
    }

    /** A paused replay standing on `frame`. */
    function pausedOn(frame: number): TelemetryData {
      return { ...replayAt(PAUSED), ReplayFrameNum: frame, ReplayFrameNumEnd: 100_000 - frame } as TelemetryData;
    }

    /** What iRacing reports while a jump is under way. */
    const SEEKING = { ...replayAt(PAUSED), IsReplayPlaying: false, ReplayFrameNum: 0 } as TelemetryData;

    it("says where the replay stands from a fresh reading", async () => {
      const { surface } = await onScreen(PAUSED);

      env.telemetry = pausedOn(600);

      expect(ioOf(surface).position()).toMatchObject({ frame: 600, endFrame: 100_000, seeking: false });
    });

    it.each<[1 | -1, "nextFrame" | "prevFrame", number]>([
      [1, "nextFrame", 601],
      [-1, "prevFrame", 599],
    ])(
      "step %i sends one frame step and is headed for the frame beside the one on screen",
      async (direction, command, lands) => {
        const { surface } = await onScreen(PAUSED);
        const io = ioOf(surface);

        env.telemetry = pausedOn(600);

        expect(io.step("dial-frame-jog", direction)).toBe(true);
        expect(mocks[command]).toHaveBeenCalledTimes(1);
        expect(mocks.setPlayPosition).not.toHaveBeenCalled();
        expect(io.position()).toMatchObject({ frame: lands, seeking: true });
      },
    );

    it("refuses a step while the last move has not read back, and sends nothing", async () => {
      const { surface } = await onScreen(PAUSED);
      const io = ioOf(surface);

      env.telemetry = pausedOn(600);
      io.step("dial-frame-jog", 1);

      expect(io.step("dial-frame-jog", 1)).toBe(false);
      expect(mocks.nextFrame).toHaveBeenCalledTimes(1);

      env.telemetry = pausedOn(601);

      expect(io.step("dial-frame-jog", 1)).toBe(true);
      expect(mocks.nextFrame).toHaveBeenCalledTimes(2);
    });

    it("refuses a step into a jump under way", async () => {
      const { surface } = await onScreen(PAUSED);
      const io = ioOf(surface);

      env.telemetry = pausedOn(600);
      io.jumpTo("dial-frame-jog", 640);
      env.telemetry = SEEKING;

      expect(io.step("dial-frame-jog", 1)).toBe(false);
      expect(io.step("dial-frame-jog", -1)).toBe(false);
      expect(mocks.nextFrame).not.toHaveBeenCalled();
      expect(mocks.prevFrame).not.toHaveBeenCalled();
    });

    it("refuses a step when nothing says where the replay stands", async () => {
      const { surface } = await onScreen(PAUSED);

      env.telemetry = SEEKING;

      expect(ioOf(surface).step("dial-frame-jog", 1)).toBe(false);
      expect(mocks.nextFrame).not.toHaveBeenCalled();
    });

    it("jumpTo sends one absolute jump and is headed for its frame", async () => {
      const { surface } = await onScreen(PAUSED);
      const io = ioOf(surface);

      env.telemetry = pausedOn(600);

      expect(io.jumpTo("dial-frame-jog", 603)).toBe(true);
      expect(mocks.setPlayPosition.mock.calls).toEqual([[ReplayPosMode.Begin, 603]]);
      expect(io.position()).toMatchObject({ frame: 603, seeking: true });
    });

    it("jumpTo may follow a move that has not read back, and the newest target stands", async () => {
      const { surface } = await onScreen(PAUSED);
      const io = ioOf(surface);

      env.telemetry = pausedOn(600);
      io.step("dial-frame-jog", 1);
      io.jumpTo("dial-frame-jog", 604);
      env.telemetry = SEEKING;
      io.jumpTo("dial-frame-jog", 607);

      expect(mocks.setPlayPosition.mock.calls).toEqual([
        [ReplayPosMode.Begin, 604],
        [ReplayPosMode.Begin, 607],
      ]);
      expect(io.position()).toMatchObject({ frame: 607, seeking: true });

      // A fast turn stops on an earlier target on the way: still under way.
      env.telemetry = pausedOn(604);
      expect(io.position()).toMatchObject({ frame: 607, seeking: true });

      env.telemetry = pausedOn(607);
      expect(io.position()).toMatchObject({ frame: 607, seeking: false });
    });

    it("a jump that was not sent leaves the target before it standing", async () => {
      const { surface } = await onScreen(PAUSED);
      const io = ioOf(surface);

      env.telemetry = pausedOn(600);
      io.jumpTo("dial-frame-jog", 640);

      mocks.setPlayPosition.mockReturnValueOnce(false);

      expect(io.jumpTo("dial-frame-jog", 650)).toBe(false);
      expect(io.position()).toMatchObject({ frame: 640, seeking: true });
      expect(io.step("dial-frame-jog", 1)).toBe(false);
    });

    it("never writes Replay Markers' pending landing, and is not ended when a marker surface settles its own", async () => {
      const { surface } = await onScreen(PAUSED);
      const io = ioOf(surface);

      env.telemetry = pausedOn(600);
      recordReplayLanding(40_000, Date.now());
      io.jumpTo("dial-frame-jog", 603);

      // The dial's own cursor take cleared the marker landing, as any replay command does.
      expect(pendingReplayLanding()).toBeNull();

      // A visible marker key settles a landing within a second of the frame on every tick.
      recordReplayLanding(603, Date.now());
      clearReplayLanding();
      env.telemetry = SEEKING;

      expect(io.position()).toMatchObject({ frame: 603, seeking: true });
      expect(io.step("dial-frame-jog", 1)).toBe(false);
      expect(mocks.nextFrame).not.toHaveBeenCalled();
    });

    it("a turn back onto the frame still on screen is not taken as landed in the entry that sent it", async () => {
      const d = dial({ mode: "frame-jog" });
      const { surface, ctx } = await onScreen(PAUSED, d);

      // 5000 on screen; +4 waits; -4 comes back onto 5000 before either is acted on.
      surface.rotate(ctx as never, d, 4, false);
      surface.rotate(ctx as never, d, -4, false);

      expect(mocks.setPlayPosition.mock.calls).toEqual([
        [ReplayPosMode.Begin, 5_004],
        [ReplayPosMode.Begin, 5_000],
      ]);
      // Still under way: a single detent now must be a jump, never a step.
      surface.rotate(ctx as never, d, 1, false);

      expect(mocks.nextFrame).not.toHaveBeenCalled();
      expect(mocks.setPlayPosition).toHaveBeenLastCalledWith(ReplayPosMode.Begin, 5_001);
    });

    it("a step into a replay that still reads as playing records no landing", async () => {
      const { surface } = await onScreen(speed(4));
      const io = ioOf(surface);

      env.telemetry = { ...replayAt(speed(4)), ReplayFrameNum: 600 } as TelemetryData;
      io.pause("dial-frame-jog");

      expect(io.step("dial-frame-jog", 1)).toBe(true);
      // The pause catches the replay a few frames on: that is where it stands, not on 601.
      expect(io.position()).toMatchObject({ frame: 600, seeking: false });

      env.telemetry = pausedOn(607);
      expect(io.position()).toMatchObject({ frame: 607, seeking: false });
    });

    it("a step that was not sent records nothing", async () => {
      mocks.nextFrame.mockReturnValueOnce(false);
      const { surface } = await onScreen(PAUSED);
      const io = ioOf(surface);

      env.telemetry = pausedOn(600);

      expect(io.step("dial-frame-jog", 1)).toBe(false);
      expect(io.position()).toMatchObject({ frame: 600, seeking: false });
    });

    it("takes the replay cursor under the mode's name before each move", async () => {
      const { surface } = await onScreen(PAUSED);
      const io = ioOf(surface);
      const cancelledBy: string[] = [];

      env.telemetry = pausedOn(600);
      claimReplayCursor("fastest-lap", (by) => cancelledBy.push(by));
      io.step("dial-frame-jog", 1);
      claimReplayCursor("fastest-lap", (by) => cancelledBy.push(by));
      io.jumpTo("dial-frame-jog", 610);

      expect(cancelledBy).toEqual(["dial-frame-jog", "dial-frame-jog"]);
    });

    it("keeps the dial's pending pause through a move, so a jog that paused still reads paused", async () => {
      const { surface } = await onScreen(speed(1));
      const io = ioOf(surface);

      env.telemetry = { ...replayAt(speed(1)), ReplayFrameNum: 600 } as TelemetryData;
      io.pause("dial-frame-jog");
      io.step("dial-frame-jog", 1);
      io.jumpTo("dial-frame-jog", 605);

      expect(io.liveSpeed()).toEqual(PAUSED);
    });

    it("a speed or a pause the dial itself sends leaves the move under way", async () => {
      const { surface } = await onScreen(PAUSED);
      const io = ioOf(surface);

      env.telemetry = pausedOn(600);
      io.jumpTo("dial-frame-jog", 640);
      io.setSpeed("dial-speed", speed(2));
      io.pause("dial-play-pause");
      env.telemetry = pausedOn(612);

      // The jump's fate is open: still measured from its target, and no step into it.
      expect(io.position()).toMatchObject({ frame: 640, seeking: true });
      expect(io.step("dial-frame-jog", 1)).toBe(false);
    });

    it("a replay command of another action ends the move under way", async () => {
      const { surface } = await onScreen(PAUSED);
      const io = ioOf(surface);

      env.telemetry = pausedOn(600);
      io.jumpTo("dial-frame-jog", 640);
      cancelReplayCursorOwner("next-lap");
      env.telemetry = pausedOn(612);

      expect(io.position()).toMatchObject({ frame: 612, seeking: false });
    });

    it("redraws the dials until the move reads back, with no tick, and then stops reading", async () => {
      const { surface } = await onScreen(PAUSED);
      const io = ioOf(surface);

      env.telemetry = pausedOn(600);
      io.jumpTo("dial-frame-jog", 640);
      env.telemetry = SEEKING;
      host.telemetry.mockClear();

      await vi.advanceTimersByTimeAsync(200);
      const whileUnderWay = host.telemetry.mock.calls.length;

      expect(whileUnderWay).toBeGreaterThanOrEqual(3);

      env.telemetry = pausedOn(640);
      await vi.advanceTimersByTimeAsync(100);
      const atLanding = host.telemetry.mock.calls.length;

      expect(atLanding).toBeGreaterThan(whileUnderWay);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(host.telemetry.mock.calls.length).toBe(atLanding);
    });

    it("stops redrawing once a move that never reads back is given up", async () => {
      const { surface } = await onScreen(PAUSED);

      env.telemetry = pausedOn(600);
      ioOf(surface).jumpTo("dial-frame-jog", 640);
      env.telemetry = SEEKING;

      await vi.advanceTimersByTimeAsync(REPLAY_TARGET_GIVE_UP_MS + 200);
      host.telemetry.mockClear();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(host.telemetry).not.toHaveBeenCalled();
    });
  });

  describe("a replay on screen while the plugin moves it", () => {
    function ioOf(surface: ReplayControlDialSurface): ReplayDialModeIo {
      return surface["io"];
    }

    /** What iRacing reports while a jump is under way. */
    const SEEKING = { ...replayAt(PAUSED), IsReplayPlaying: false, ReplayFrameNum: 0 } as TelemetryData;

    /** iRacing's raw flag has been down for longer than the debounce's grace. */
    function flagDown(): void {
      env.inReplay = false;
    }

    it("refuses a turn and a press from the car", async () => {
      const { surface, ctx } = await onScreen(speed(8));

      flagDown();
      surface.rotate(ctx as never, dial(), -1, false);
      await press(surface, ctx, dial());

      expectNothingSent();
    });

    it("still takes a turn while a move of its own has not read back", async () => {
      const { surface, ctx } = await onScreen(PAUSED);

      env.telemetry = { ...replayAt(PAUSED), ReplayFrameNum: 600 } as TelemetryData;
      ioOf(surface).jumpTo("dial-frame-jog", 640);
      env.telemetry = SEEKING;
      flagDown();

      surface.rotate(ctx as never, dial(), 1, false);

      expect(mocks.setPlaySpeed).toHaveBeenCalledTimes(1);
    });

    it("refuses again once that move is given up without reading back", async () => {
      const { surface, ctx } = await onScreen(PAUSED);

      env.telemetry = { ...replayAt(PAUSED), ReplayFrameNum: 600 } as TelemetryData;
      ioOf(surface).jumpTo("dial-frame-jog", 640);
      env.telemetry = SEEKING;
      flagDown();
      await vi.advanceTimersByTimeAsync(REPLAY_TARGET_GIVE_UP_MS + 100);

      surface.rotate(ctx as never, dial(), 1, false);

      expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
    });

    it("still takes a turn while something holds a claim on the replay cursor, and takes the cursor from it", async () => {
      const { surface, ctx } = await onScreen(speed(1));

      claimReplayCursor("fastest-lap");
      flagDown();
      surface.rotate(ctx as never, dial(), 1, false);

      expect(mocks.setPlaySpeed).toHaveBeenCalledTimes(1);
      expect(currentReplayCursorOwner()).toBeNull();
    });

    it("stops taking turns under a claim once no replay has been seen for the give-up time", async () => {
      const { surface, ctx } = await onScreen(speed(1));

      claimReplayCursor("fastest-lap");
      flagDown();
      await vi.advanceTimersByTimeAsync(REPLAY_TARGET_GIVE_UP_MS + 100);
      surface.rotate(ctx as never, dial(), 1, false);

      expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
      expect(currentReplayCursorOwner()).toBe("fastest-lap");
    });

    it("turns made from the car cannot keep renewing the hold", async () => {
      const d = dial({ mode: "frame-jog" });
      const { surface, ctx } = await onScreen(PAUSED, d);

      // A jump goes out in the replay; then the replay is left, and the dial is kept turning.
      surface.rotate(ctx as never, d, 2, false);
      env.telemetry = SEEKING;
      flagDown();

      for (let i = 0; i < 8; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
        surface.rotate(ctx as never, d, 2, false);
      }

      // Each accepted turn sent a jump and renewed its own target; the hold still ended on time.
      expect(mocks.setPlayPosition.mock.calls.length).toBeLessThanOrEqual(3);
      expect(mocks.setPlayPosition.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("shows the box, not the dimmed label, while a move has not read back", async () => {
      const { surface, ctx } = await onScreen(PAUSED);

      env.telemetry = { ...replayAt(PAUSED), ReplayFrameNum: 600 } as TelemetryData;
      ioOf(surface).jumpTo("dial-frame-jog", 640);
      flagDown();
      await settle(150);

      expect(shownValue(lastBox(ctx))).toBe("PAUSED");
    });
  });

  describe("gestures", () => {
    describe("Play/Pause", () => {
      it("pauses a playing replay, in either direction", async () => {
        const { surface, ctx, d } = await onScreen(speed(-2));

        await press(surface, ctx, d);

        expect(mocks.pause).toHaveBeenCalledTimes(1);
        expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
      });

      it("resumes a paused replay at the remembered speed", async () => {
        noteTelemetrySpeed(speed(4), Date.now());
        const { surface, ctx, d } = await onScreen(PAUSED);

        await press(surface, ctx, d);

        expect(mocks.setPlaySpeed).toHaveBeenCalledTimes(1);
        expect(mocks.setPlaySpeed).toHaveBeenCalledWith(4, false);
        expect(mocks.pause).not.toHaveBeenCalled();
      });

      it("resumes at 1x before the replay has been seen playing", async () => {
        const { surface, ctx, d } = await onScreen(PAUSED);

        await press(surface, ctx, d);

        expect(mocks.setPlaySpeed).toHaveBeenCalledWith(1, false);
      });

      it("resumes the speed a turn set, even when paused before telemetry reported it", async () => {
        const { surface, ctx, d } = await onScreen(speed(1));

        surface.rotate(ctx as never, d, 2, false);
        await press(surface, ctx, d);
        await press(surface, ctx, d);

        expect(mocks.pause).toHaveBeenCalledTimes(1);
        expect(mocks.setPlaySpeed.mock.calls).toEqual([
          [4, false],
          [4, false],
        ]);
      });

      it("a second press right after a pause resumes instead of pausing again", async () => {
        noteTelemetrySpeed(speed(2), Date.now());
        const { surface, ctx, d } = await onScreen(speed(2));

        await press(surface, ctx, d);
        // The tick still carries 2x.
        await press(surface, ctx, d);

        expect(mocks.pause).toHaveBeenCalledTimes(1);
        expect(mocks.setPlaySpeed).toHaveBeenCalledWith(2, false);
      });
    });

    describe("Set 1x and play", () => {
      it.each<[string, ReplaySpeed]>([
        ["paused", PAUSED],
        ["playing backwards", speed(-8)],
        ["in slow motion", speed(4, true)],
        ["already at 1x", speed(1)],
      ])("sends 1x forward whatever the state: %s", async (_name, live) => {
        const { surface, ctx } = await onScreen(live);

        await press(surface, ctx, dial({ pressAction: "set-1x-play" }));

        expect(mocks.setPlaySpeed).toHaveBeenCalledTimes(1);
        expect(mocks.setPlaySpeed).toHaveBeenCalledWith(1, false);
      });

      it("is the default long press", async () => {
        const { surface, ctx, d } = await onScreen(speed(8));

        await press(surface, ctx, d, 600);

        expect(mocks.setPlaySpeed).toHaveBeenCalledWith(1, false);
        expect(mocks.pause).not.toHaveBeenCalled();
      });
    });

    describe("Reverse direction", () => {
      it.each<[ReplaySpeed, [number, boolean]]>([
        [speed(4), [-4, false]],
        [speed(-2), [2, false]],
        [speed(4, true), [-4, true]],
        [speed(-16, true), [16, true]],
      ])("flips a playing %j, keeping its magnitude and slow-motion flag", async (live, expected) => {
        const { surface, ctx } = await onScreen(live);

        await press(surface, ctx, dial({ pressAction: "reverse" }));

        expect(mocks.setPlaySpeed).toHaveBeenCalledTimes(1);
        expect(mocks.setPlaySpeed).toHaveBeenCalledWith(...expected);
      });

      it("while paused flips the remembered speed, stays paused and shows it at once", async () => {
        noteTelemetrySpeed(speed(4), Date.now());
        const { surface, ctx } = await onScreen(PAUSED);
        expect(shownCaption(lastBox(ctx))).toBe("► 4x");

        await press(surface, ctx, dial({ pressAction: "reverse" }));
        await settle();

        expectNothingSent();
        expect(rememberedSpeed()).toEqual(speed(-4));
        expect(shownValue(lastBox(ctx))).toBe("PAUSED");
        expect(shownCaption(lastBox(ctx))).toBe("◄ 4x");
      });

      it("the next Play/Pause then resumes the other way", async () => {
        noteTelemetrySpeed(speed(4), Date.now());
        const { surface, ctx } = await onScreen(PAUSED);

        await press(surface, ctx, dial({ pressAction: "reverse" }));
        await press(surface, ctx, dial({ pressAction: "play-pause" }));

        expect(mocks.setPlaySpeed).toHaveBeenCalledTimes(1);
        expect(mocks.setPlaySpeed).toHaveBeenCalledWith(-4, false);
      });
    });

    it("Jump to Live runs the action's own jump and sends nothing itself", async () => {
      const { surface, ctx } = await onScreen(speed(1));

      await press(surface, ctx, dial({ pressAction: "jump-to-live" }));

      expect(host.jumpToLive).toHaveBeenCalledTimes(1);
      expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
      expect(mocks.pause).not.toHaveBeenCalled();
    });

    it("None does nothing", async () => {
      const { surface, ctx } = await onScreen(speed(1));
      const d = dial({ pressAction: "none", longPressAction: "none" });

      await press(surface, ctx, d);
      await press(surface, ctx, d, 600);

      expectNothingSent();
    });

    it("a short press runs Press and a long press runs Long Press", async () => {
      const { surface, ctx } = await onScreen(speed(4));
      const d = dial({ pressAction: "reverse", longPressAction: "jump-to-live" });

      await press(surface, ctx, d, 499);
      expect(mocks.setPlaySpeed).toHaveBeenCalledWith(-4, false);
      expect(host.jumpToLive).not.toHaveBeenCalled();

      await press(surface, ctx, d, 500);
      expect(host.jumpToLive).toHaveBeenCalledTimes(1);
      expect(mocks.setPlaySpeed).toHaveBeenCalledTimes(1);
    });

    it("the threshold is the plugin-wide long-press setting", async () => {
      mocks.thresholdMs.value = 1_000;
      const { surface, ctx, d } = await onScreen(speed(4));

      await press(surface, ctx, d, 600);

      // 600 ms is short against a 1 s threshold: Play/Pause, not Set 1x.
      expect(mocks.pause).toHaveBeenCalledTimes(1);
      expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
    });

    it("push + turn steps like a plain turn and its release fires nothing", async () => {
      const { surface, ctx, d } = await onScreen(speed(1));

      surface.down(ctx as never, d);
      surface.rotate(ctx as never, d, 1, true);
      await vi.advanceTimersByTimeAsync(600);
      await surface.up(ctx.id);

      expect(mocks.setPlaySpeed.mock.calls).toEqual([[2, false]]);
      expect(mocks.pause).not.toHaveBeenCalled();
    });

    it("a stray release with no press fires nothing", async () => {
      const { surface, ctx } = await onScreen(speed(1));

      await surface.up(ctx.id);

      expectNothingSent();
    });

    it("a lone dialDown leaves nothing behind: the press that follows is a short one", async () => {
      const { surface, ctx, d } = await onScreen(speed(4));

      // A down whose release never arrives, then a full press long after.
      surface.down(ctx as never, d);
      await vi.advanceTimersByTimeAsync(5_000);
      await press(surface, ctx, d);

      expect(mocks.pause).toHaveBeenCalledTimes(1);
      expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
    });

    it("the touch slots are inert by default and run their gesture when set", async () => {
      const { surface, ctx } = await onScreen(speed(4));

      surface.touchTap(ctx as never, dial(), false);
      surface.touchTap(ctx as never, dial(), true);
      expectNothingSent();

      surface.touchTap(ctx as never, dial({ tapAction: "play-pause", longTouchAction: "set-1x-play" }), false);
      expect(mocks.pause).toHaveBeenCalledTimes(1);

      surface.touchTap(ctx as never, dial({ tapAction: "play-pause", longTouchAction: "set-1x-play" }), true);
      expect(mocks.setPlaySpeed).toHaveBeenCalledWith(1, false);
    });

    describe("with the extended gestures compiled out (Mirabox, Ulanzi)", () => {
      it("no release classifies as long, and the touch slots are inert", async () => {
        vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
        const { surface, ctx, d } = await onScreen(speed(4), dial(), dialContext("knob", KNOB));

        await press(surface, ctx, d, 2_000);
        surface.touchTap(ctx as never, dial({ tapAction: "jump-to-live", longTouchAction: "jump-to-live" }), false);
        surface.touchTap(ctx as never, dial({ tapAction: "jump-to-live", longTouchAction: "jump-to-live" }), true);

        // The 2 s hold was a short press: Play/Pause, never Set 1x.
        expect(mocks.pause).toHaveBeenCalledTimes(1);
        expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
        expect(host.jumpToLive).not.toHaveBeenCalled();
      });

      it.each(["set-1x-play", "reverse", "jump-to-live"] as const)(
        "%s stays reachable by assigning it to Press",
        async (gesture) => {
          vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
          const d = dial({ pressAction: gesture });
          const { surface, ctx } = await onScreen(speed(4), d, dialContext("knob", KNOB));

          await press(surface, ctx, d);

          expect(mocks.setPlaySpeed.mock.calls.length + host.jumpToLive.mock.calls.length).toBe(1);
        },
      );

      it("a push + turn release still fires nothing", async () => {
        vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
        const { surface, ctx, d } = await onScreen(speed(1), dial(), dialContext("knob", KNOB));

        surface.down(ctx as never, d);
        surface.rotate(ctx as never, d, 1, true);
        await surface.up(ctx.id);

        expect(mocks.pause).not.toHaveBeenCalled();
        expect(mocks.setPlaySpeed.mock.calls).toEqual([[2, false]]);
      });
    });
  });

  describe("outside a replay", () => {
    const everySlot = () =>
      dial({
        pressAction: "play-pause",
        longPressAction: "set-1x-play",
        tapAction: "reverse",
        longTouchAction: "jump-to-live",
      });

    it.each<[string, () => void]>([
      ["from the car", () => (env.inReplay = false)],
      ["with no telemetry", () => (env.telemetry = null)],
    ])("rotation and every gesture send nothing %s", async (_name, leave) => {
      const { surface, ctx } = await onScreen(speed(1));
      leave();
      const d = everySlot();

      surface.rotate(ctx as never, d, 1, false);
      surface.rotate(ctx as never, d, -3, false);
      await press(surface, ctx, d);
      await press(surface, ctx, d, 600);
      surface.touchTap(ctx as never, d, false);
      surface.touchTap(ctx as never, d, true);

      expectNothingSent();
      expect(host.setLocalSpeed).not.toHaveBeenCalled();
    });

    it("Reverse does not flip the remembered speed from the car", async () => {
      noteTelemetrySpeed(speed(4), Date.now());
      const { surface, ctx } = await onScreen(PAUSED);
      env.inReplay = false;

      await press(surface, ctx, dial({ pressAction: "reverse" }));

      expect(rememberedSpeed()).toEqual(speed(4));
    });

    it.each<[string, () => void]>([
      ["from the car", () => (env.inReplay = false)],
      ["with no telemetry", () => (env.telemetry = null)],
    ])("the box is the label alone, dimmed, with no side marks %s", async (_name, leave) => {
      nowPlaying(speed(4));
      leave();
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      expect(lastBox(ctx)).toContain('data-dimmed="true"');
      expect(lastBox(ctx)).toContain(">SPEED</text>");
      expect(shownValue(lastBox(ctx))).toBe("");
      expect(shownCaption(lastBox(ctx))).toBe("");
      expect(lastBox(ctx)).not.toContain("data-side");
    });

    it("the box comes back the moment a replay is on screen", async () => {
      env.inReplay = false;
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);

      env.inReplay = true;
      nowPlaying(speed(2));
      surface.onTick(ctx.id, tickOf());
      await settle();

      expect(lastBox(ctx)).not.toContain("data-dimmed");
      expect(shownValue(lastBox(ctx))).toBe("2x");
    });

    it.each(REPLAY_DIAL_MODES)("the dimmed %s box shows the mode's own label, as in a replay", async (mode) => {
      const { surface, ctx } = await onScreen(speed(1), dial({ mode }));
      const label = `>${DIAL_MODES[mode].label}</text>`;
      expect(lastBox(ctx)).toContain(label);
      expect(lastBox(ctx)).not.toContain("data-dimmed");

      env.inReplay = false;
      surface.onTick(ctx.id, tickOf());
      await settle();

      expect(lastBox(ctx)).toContain('data-dimmed="true"');
      expect(lastBox(ctx)).toContain(label);
      expect(shownValue(lastBox(ctx))).toBe("");
    });

    it("a dimmed box never asks the mode what it shows", async () => {
      env.inReplay = false;
      const view = vi.spyOn(DIAL_MODES.speed, "view");
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);
      surface.onTick(ctx.id, tickOf());
      await settle();

      expect(view).not.toHaveBeenCalled();
      view.mockRestore();
    });
  });

  describe("the rotation modes", () => {
    /** A replay tick at `seconds` into the session, playing at `s`. */
    function replayTimeAt(seconds: number, s: ReplaySpeed): void {
      env.telemetry = { ...replayAt(s), ReplaySessionTime: seconds } as TelemetryData;
    }

    it("registers one mode per dial.mode value: Speed Control and Frame Jog", () => {
      expect(Object.keys(DIAL_MODES)).toEqual([...REPLAY_DIAL_MODES]);
      expect(DIAL_MODES.speed).toBe(speedMode);
      expect(DIAL_MODES["frame-jog"]).toBe(frameJogMode);
    });

    it("labels are distinct, so the box says which mode the dial is in", () => {
      const labels = REPLAY_DIAL_MODES.map((mode) => DIAL_MODES[mode].label);

      expect(labels).toEqual(["SPEED", "FRAME"]);
    });

    it("a Frame Jog dial's turn goes to Frame Jog, never to the speed ladder", async () => {
      const d = dial({ mode: "frame-jog" });
      const { surface, ctx } = await onScreen(PAUSED, d);
      const jog = vi.spyOn(frameJogMode, "rotate");
      const ladder = vi.spyOn(speedMode, "rotate");

      surface.rotate(ctx as never, d, 1, false);
      // The step reads back before the next turn, so that one is a step too.
      env.telemetry = { ...replayAt(PAUSED), ReplayFrameNum: 5_001 } as TelemetryData;
      surface.rotate(ctx as never, d, -1, false);

      expect(jog).toHaveBeenNthCalledWith(1, 1, d, surface["io"]);
      expect(jog).toHaveBeenNthCalledWith(2, -1, d, surface["io"]);
      expect(ladder).not.toHaveBeenCalled();
      expect(mocks.nextFrame).toHaveBeenCalledTimes(1);
      expect(mocks.prevFrame).toHaveBeenCalledTimes(1);
      expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
      jog.mockRestore();
      ladder.mockRestore();
    });

    it("a Speed Control dial's turn never reaches Frame Jog", async () => {
      const { surface, ctx, d } = await onScreen(speed(1));
      const jog = vi.spyOn(frameJogMode, "rotate");

      surface.rotate(ctx as never, d, 1, false);

      expect(jog).not.toHaveBeenCalled();
      expect(mocks.nextFrame).not.toHaveBeenCalled();
      jog.mockRestore();
    });

    it("Frame Jog on a playing replay pauses through the surface's tracked pause, once", async () => {
      noteTelemetrySpeed(speed(4), Date.now());
      const d = dial({ mode: "frame-jog" });
      const { surface, ctx } = await onScreen(speed(4), d);

      surface.rotate(ctx as never, d, 1, false);
      await vi.advanceTimersByTimeAsync(30);
      // The tick still carries 4x: the second detent must not pause again.
      surface.rotate(ctx as never, d, 1, false);

      expect(mocks.pause).toHaveBeenCalledTimes(1);
      // Both are steps: the first went into a replay still reading as playing,
      // so it left no landing for the second to be measured from.
      expect(mocks.nextFrame).toHaveBeenCalledTimes(2);
      expect(mocks.setPlayPosition).not.toHaveBeenCalled();
      // Press then resumes the speed that was playing.
      await press(surface, ctx, d);
      expect(mocks.setPlaySpeed).toHaveBeenCalledWith(4, false);
    });

    it("a fast Frame Jog turn is one absolute jump per event, each measured from the last one's target", async () => {
      const d = dial({ mode: "frame-jog" });
      const { surface, ctx } = await onScreen(PAUSED, d);

      surface.rotate(ctx as never, d, 2, false);
      // What iRacing reports while the second jump waits its turn.
      env.telemetry = { ...replayAt(PAUSED), IsReplayPlaying: false, ReplayFrameNum: 0 } as TelemetryData;
      surface.rotate(ctx as never, d, 3, false);
      surface.rotate(ctx as never, d, 1, false);
      surface.rotate(ctx as never, d, -2, false);

      expect(mocks.setPlayPosition.mock.calls).toEqual([
        [ReplayPosMode.Begin, 5_002],
        [ReplayPosMode.Begin, 5_005],
        [ReplayPosMode.Begin, 5_006],
        [ReplayPosMode.Begin, 5_004],
      ]);
      // Never a step into the jump under way, and never anything relative.
      expect(mocks.nextFrame).not.toHaveBeenCalled();
      expect(mocks.prevFrame).not.toHaveBeenCalled();
    });

    it("a Frame Jog turn after a landing that ended somewhere else goes back to where the jog was headed", async () => {
      const d = dial({ mode: "frame-jog" });
      const { surface, ctx } = await onScreen(PAUSED, d);

      surface.rotate(ctx as never, d, 4, false);
      // The jump ended thousands of frames away and stays there.
      env.telemetry = { ...replayAt(PAUSED), ReplayFrameNum: 13_772 } as TelemetryData;
      await vi.advanceTimersByTimeAsync(1_000);
      surface.rotate(ctx as never, d, 1, false);

      expect(mocks.setPlayPosition.mock.calls).toEqual([
        [ReplayPosMode.Begin, 5_004],
        [ReplayPosMode.Begin, 5_005],
      ]);
      expect(mocks.nextFrame).not.toHaveBeenCalled();
    });

    it("a Frame Jog dial draws Frame Jog's view under its label", async () => {
      replayTimeAt(83.5, PAUSED);
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx, dial({ mode: "frame-jog" }));

      expect(lastBox(ctx)).toContain(">FRAME</text>");
      expect(lastBox(ctx)).not.toContain(">SPEED</text>");
      expect(shownValue(lastBox(ctx))).toBe("1:23.50");
      expect(shownCaption(lastBox(ctx))).toBe("PAUSED");
      expect(sides(lastBox(ctx))).toEqual({ left: true, right: true });
    });

    it("the gesture slots are the same in either mode", async () => {
      const d = dial({ mode: "frame-jog", pressAction: "reverse" });
      const { surface, ctx } = await onScreen(speed(4), d);

      await press(surface, ctx, d);
      await press(surface, ctx, d, 600);

      expect(mocks.setPlaySpeed.mock.calls).toEqual([
        [-4, false],
        [1, false],
      ]);
    });

    it("changing the Mode redraws the box in the new mode at once", async () => {
      replayTimeAt(60, speed(2));
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx);
      expect(lastBox(ctx)).toContain(">SPEED</text>");

      await surface.didReceiveSettings(ctx as never, dial({ mode: "frame-jog" }));
      await settle();

      expect(lastBox(ctx)).toContain(">FRAME</text>");
      expect(shownValue(lastBox(ctx))).toBe("1:00.00");
    });

    it("from the car a Frame Jog dial sends nothing either", async () => {
      const d = dial({ mode: "frame-jog" });
      const { surface, ctx } = await onScreen(speed(1), d);
      env.inReplay = false;

      surface.rotate(ctx as never, d, 1, false);
      surface.rotate(ctx as never, d, -5, false);

      expectNothingSent();
      expect(mocks.nextFrame).not.toHaveBeenCalled();
      expect(mocks.prevFrame).not.toHaveBeenCalled();
      expect(mocks.setPlayPosition).not.toHaveBeenCalled();
    });
  });

  describe("a late input event never re-creates a disappeared context (#1329)", () => {
    const d = () => dial({ tapAction: "play-pause", longTouchAction: "set-1x-play" });

    async function appearThenDisappear(id: string) {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", true);
      nowPlaying(speed(1));
      const surface = makeSurface();
      await appear(surface, dialContext(id), d());
      surface.willDisappear(id);
      vi.clearAllMocks();

      return { surface, late: dialContext(id) };
    }

    function expectNothingHappened(late: DialContext) {
      expect(late.setDialCanvas).not.toHaveBeenCalled();
      expect(late.setTriggerDescription).not.toHaveBeenCalled();
      expectNothingSent();
    }

    it("drops a rotate: no entry, no speed, no frame", async () => {
      const { surface, late } = await appearThenDisappear("late-rotate");

      surface.rotate(late as never, d(), 1, false);
      await settle();

      expect(surface["contexts"].has("late-rotate")).toBe(false);
      expectNothingHappened(late);
      expect(logger.debug).toHaveBeenCalledWith("Dial rotate dropped: no context for late-rotate (it has disappeared)");
    });

    it("drops a down: no entry and no hold-preview timer armed", async () => {
      const { surface, late } = await appearThenDisappear("late-down");
      const timersBefore = vi.getTimerCount();

      surface.down(late as never, d());

      expect(vi.getTimerCount()).toBe(timersBefore);
      await vi.advanceTimersByTimeAsync(1000);
      await surface.up("late-down");

      expect(surface["contexts"].has("late-down")).toBe(false);
      expectNothingHappened(late);
    });

    it("drops a touchTap: no entry, nothing sent", async () => {
      const { surface, late } = await appearThenDisappear("late-tap");

      surface.touchTap(late as never, d(), false);
      surface.touchTap(late as never, d(), true);
      await settle();

      expect(surface["contexts"].has("late-tap")).toBe(false);
      expectNothingHappened(late);
    });

    it("drops a tick: no frame for a context that is gone", async () => {
      const { surface, late } = await appearThenDisappear("late-tick");

      surface.onTick("late-tick", tickOf());
      await settle();

      expectNothingHappened(late);
    });

    it("still acts on a live context", async () => {
      const { surface, ctx } = await onScreen(speed(1), d(), dialContext("live"));

      surface.rotate(ctx as never, d(), 1, false);

      expect(surface["contexts"].has("live")).toBe(true);
      expect(mocks.setPlaySpeed).toHaveBeenCalledTimes(1);
    });
  });

  describe("hold preview", () => {
    it("at the threshold shows what the release would do, and fires nothing", async () => {
      const { surface, ctx, d } = await onScreen(speed(8));

      surface.down(ctx as never, d);
      await vi.advanceTimersByTimeAsync(499);
      expect(lastBox(ctx)).not.toContain("data-pending-bar");

      await vi.advanceTimersByTimeAsync(1);
      expect(shownValue(lastBox(ctx))).toBe("► 1x");
      expect(lastBox(ctx)).toContain("data-pending-bar");
      expectNothingSent();
    });

    it.each<[string, string, ReplaySpeed, ReplaySpeed | null, string]>([
      ["Set 1x and play", "set-1x-play", speed(-4), null, "► 1x"],
      ["Play/Pause while playing", "play-pause", speed(4), null, "PAUSE"],
      ["Play/Pause while paused", "play-pause", PAUSED, speed(4), "► 4x"],
      ["Play/Pause while paused, resuming in reverse", "play-pause", PAUSED, speed(-2, true), "◄ 1/2x"],
      ["Reverse while playing forward", "reverse", speed(4), null, "◄ 4x"],
      ["Reverse while playing backward", "reverse", speed(-4, true), null, "► 1/4x"],
      ["Reverse while paused", "reverse", PAUSED, speed(2), "◄ 2x"],
      ["Jump to Live", "jump-to-live", speed(1), null, "LIVE"],
    ])("previews %s", async (_name, longPressAction, live, remembered, expected) => {
      if (remembered) noteTelemetrySpeed(remembered, Date.now());

      const d = dial({ longPressAction });
      const { surface, ctx } = await onScreen(live, d);

      surface.down(ctx as never, d);
      await vi.advanceTimersByTimeAsync(500);

      expect(shownValue(lastBox(ctx))).toBe(expected);
      expect(lastBox(ctx)).toContain("data-pending-bar");
    });

    it.each<[string, () => void, Record<string, unknown>]>([
      ["a long press set to None", () => undefined, { longPressAction: "none" }],
      ["a dial out of a replay", () => (env.inReplay = false), {}],
      ["absent telemetry", () => (env.telemetry = null), {}],
    ])("leaves the screen still for %s", async (_name, arrange, overrides) => {
      const d = dial(overrides);
      const { surface, ctx } = await onScreen(speed(4), d);
      arrange();
      surface.onTick(ctx.id, tickOf());
      await settle();
      ctx.setDialCanvas.mockClear();

      surface.down(ctx as never, d);
      await vi.advanceTimersByTimeAsync(800);

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
    });

    it.each<[string, (s: ReplayControlDialSurface, ctx: DialContext) => Promise<void>]>([
      [
        "a release",
        async (s, ctx) => {
          await s.up(ctx.id);
        },
      ],
      [
        "a release that sends nothing, the replay having been left meanwhile",
        async (s, ctx) => {
          env.inReplay = false;
          await s.up(ctx.id);
        },
      ],
      [
        "a push + turn",
        async (s, ctx) => {
          s.rotate(ctx as never, dial(), 1, true);
          await s.up(ctx.id);
        },
      ],
      [
        "a settings change mid-hold",
        async (s, ctx) => {
          await s.didReceiveSettings(ctx as never, dial({ longPressAction: "none" }));
          await s.up(ctx.id);
        },
      ],
    ])("reverts on %s", async (_name, finish) => {
      const { surface, ctx, d } = await onScreen(speed(4));

      surface.down(ctx as never, d);
      await vi.advanceTimersByTimeAsync(500);
      expect(lastBox(ctx)).toContain("data-pending-bar");

      await finish(surface, ctx);
      await settle();

      expect(lastBox(ctx)).not.toContain("data-pending-bar");
    });

    it("survives a tick mid-hold", async () => {
      const { surface, ctx, d } = await onScreen(speed(4));

      surface.down(ctx as never, d);
      await vi.advanceTimersByTimeAsync(500);
      nowPlaying(speed(2));
      surface.onTick(ctx.id, tickOf());
      await settle();

      expect(lastBox(ctx)).toContain("data-pending-bar");
      expect(shownValue(lastBox(ctx))).toBe("► 1x");
    });

    it("a replay that ends mid-hold takes the preview with it: the dimmed box claims no outcome", async () => {
      const { surface, ctx, d } = await onScreen(speed(4));

      surface.down(ctx as never, d);
      await vi.advanceTimersByTimeAsync(500);
      expect(lastBox(ctx)).toContain("data-pending-bar");
      expect(shownValue(lastBox(ctx))).toBe("► 1x");

      // Still held: the release would now do nothing.
      env.inReplay = false;
      surface.onTick(ctx.id, tickOf());
      await settle();

      expect(lastBox(ctx)).toContain('data-dimmed="true"');
      expect(lastBox(ctx)).not.toContain("data-pending-bar");
      expect(shownValue(lastBox(ctx))).toBe("");

      await surface.up(ctx.id);
      await settle();
      expectNothingSent();
      expect(surface["contexts"].get(ctx.id)?.preview).toBeNull();
    });

    it("a disappearing dial draws no revert frame and leaves no timer", async () => {
      const { surface, ctx, d } = await onScreen(speed(4));
      surface.down(ctx as never, d);
      await vi.advanceTimersByTimeAsync(100);
      ctx.setDialCanvas.mockClear();

      surface.willDisappear(ctx.id);

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
    });

    it("with the extended gestures compiled out, constructs no helper: no timer, no frame", async () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
      const { surface, ctx, d } = await onScreen(speed(4), dial(), dialContext("knob", KNOB));
      ctx.setDialCanvas.mockClear();
      const timersBefore = vi.getTimerCount();

      surface.down(ctx as never, d);

      expect(vi.getTimerCount()).toBe(timersBefore);
      await vi.advanceTimersByTimeAsync(800);
      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
    });
  });

  describe("display", () => {
    it.each<[ReplaySpeed, string]>([
      [speed(1), "1x"],
      [speed(16), "16x"],
      [speed(-2), "-2x"],
      [speed(4, true), "1/4x"],
      [speed(-4, true), "-1/4x"],
      [PAUSED, "PAUSED"],
    ])("shows %j as the live speed under SPEED", async (live, expected) => {
      const { ctx } = await onScreen(live);

      expect(lastBox(ctx)).toContain(">SPEED</text>");
      expect(shownValue(lastBox(ctx))).toBe(expected);
      expect(lastBox(ctx)).not.toContain("data-dimmed");
    });

    it("captions a paused replay with the resume speed, and a playing one with nothing", async () => {
      noteTelemetrySpeed(speed(4), Date.now());
      const { surface, ctx } = await onScreen(PAUSED);
      expect(shownCaption(lastBox(ctx))).toBe("► 4x");

      nowPlaying(speed(4));
      surface.onTick(ctx.id, tickOf());
      await settle();
      expect(shownCaption(lastBox(ctx))).toBe("");
    });

    it.each<[string, ReplaySpeed, { left: boolean; right: boolean }]>([
      ["mid-ladder", speed(1), { left: true, right: true }],
      ["paused", PAUSED, { left: true, right: true }],
      ["the fastest forward stop", speed(8), { left: true, right: false }],
      ["the fastest reverse stop", speed(-8), { left: false, right: true }],
    ])("lights the sides a turn would change the speed towards: %s", async (_name, live, expected) => {
      const { ctx } = await onScreen(live);

      expect(sides(lastBox(ctx))).toEqual(expected);
    });

    it("never lights a side the turn would not move: the marks and the rotation agree", async () => {
      for (const live of [speed(8), speed(-8), speed(16), speed(3), PAUSED]) {
        vi.clearAllMocks();
        _resetReplaySpeedState();
        const { surface, ctx, d } = await onScreen(live, dial(), dialContext(`dial-${live.speed}`));
        const marks = sides(lastBox(ctx));

        surface.rotate(ctx as never, d, 1, false);
        expect(mocks.setPlaySpeed.mock.calls.length === 1).toBe(marks.right);

        vi.clearAllMocks();
        _resetReplaySpeedState();
        surface.rotate(ctx as never, d, -1, false);
        expect(mocks.setPlaySpeed.mock.calls.length === 1).toBe(marks.left);
      }
    });

    it("uses the dial's own colours", async () => {
      const { ctx } = await onScreen(speed(1), dial({ colors: { valueColor: "#ff0000", borderColor: "#00ff00" } }));

      expect(lastBox(ctx)).toContain('fill="#ff0000"');
      expect(lastBox(ctx)).toContain('stroke="#00ff00"');
    });

    it("a paused dial pushes exactly once across many ticks", async () => {
      nowPlaying(PAUSED);
      const surface = makeSurface();
      const ctx = dialContext();
      await surface.willAppear(ctx as never, dial());

      for (let frame = 0; frame < 600; frame += 1) {
        surface.onTick(ctx.id, tickOf());
        await vi.advanceTimersByTimeAsync(16);
      }

      expect(ctx.setDialCanvas).toHaveBeenCalledTimes(1);
    });

    it("a replay playing at a steady speed pushes no frame, whatever else the tick carries", async () => {
      const { surface, ctx } = await onScreen(speed(4));
      ctx.setDialCanvas.mockClear();

      for (let frame = 5_000; frame < 5_600; frame += 1) {
        env.telemetry = {
          ...replayAt(speed(4)),
          ReplayFrameNum: frame,
          ReplaySessionTime: frame / 60,
        } as TelemetryData;
        surface.onTick(ctx.id, tickOf());
        await vi.advanceTimersByTimeAsync(16);
      }

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
    });

    it("a speed set elsewhere is pushed on the tick that carries it", async () => {
      const { surface, ctx } = await onScreen(speed(1));

      nowPlaying(speed(-8));
      surface.onTick(ctx.id, tickOf());
      await settle();

      expect(shownValue(lastBox(ctx))).toBe("-8x");
    });

    it("a changed tick builds its frame once: the flush draws the frame the tick built", async () => {
      const { surface, ctx } = await onScreen(speed(1));
      const view = vi.spyOn(DIAL_MODES.speed, "view");
      ctx.setDialCanvas.mockClear();

      nowPlaying(speed(2));
      surface.onTick(ctx.id, tickOf());
      await settle();

      expect(ctx.setDialCanvas).toHaveBeenCalledTimes(1);
      expect(view).toHaveBeenCalledTimes(1);
      view.mockRestore();
    });

    it("a detent that changes nothing leaves the throttle's window alone, so the next change is pushed at once", async () => {
      // At the fast end of the ladder: a clockwise detent sends nothing and shows nothing new.
      const { surface, ctx, d } = await onScreen(speed(8));
      await vi.advanceTimersByTimeAsync(1_000);
      const throttle = surface["renderThrottle"];
      const stampedAt = throttle.lastImageSentAt.get(ctx.id);
      ctx.setDialCanvas.mockClear();

      surface.rotate(ctx as never, d, 1, false);

      expectNothingSent();
      expect(stampedAt).toBeDefined();
      expect(throttle.lastImageSentAt.get(ctx.id)).toBe(stampedAt);
      expect(throttle.pendingFlush.has(ctx.id)).toBe(false);

      await vi.advanceTimersByTimeAsync(16);
      nowPlaying(speed(4));
      surface.onTick(ctx.id, tickOf());

      // No timer has run since the tick: the push was immediate, not a deferred flush.
      expect(ctx.setDialCanvas).toHaveBeenCalledTimes(1);
      expect(shownValue(lastBox(ctx))).toBe("4x");
    });

    it("a Frame Jog step shows the time it is headed for at once, before any tick carries it", async () => {
      const d = dial({ mode: "frame-jog" });
      env.telemetry = { ...replayAt(PAUSED), ReplaySessionTime: 60 } as TelemetryData;
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx, d);
      await vi.advanceTimersByTimeAsync(1_000);
      ctx.setDialCanvas.mockClear();

      surface.rotate(ctx as never, d, 1, false);
      await vi.advanceTimersByTimeAsync(0);

      expect(mocks.nextFrame).toHaveBeenCalledTimes(1);
      expect(ctx.setDialCanvas).toHaveBeenCalledTimes(1);
      expect(shownValue(lastBox(ctx))).toBe("1:00.02");
    });

    it("a Frame Jog dial shows no time rather than 0:00.00 while a jump is under way from an unknown place", async () => {
      const d = dial({ mode: "frame-jog" });
      // What iRacing reports during a jump the plugin did not send: nothing says where the replay is.
      env.telemetry = {
        ...replayAt(PAUSED),
        IsReplayPlaying: false,
        ReplayFrameNum: 0,
        ReplaySessionTime: 0,
      } as TelemetryData;
      const surface = makeSurface();
      const ctx = dialContext();
      await appear(surface, ctx, d);

      expect(lastBox(ctx)).not.toContain("0:00.00");
    });

    it("a gesture that changes nothing on screen leaves the throttle's window alone too", async () => {
      const { surface, ctx } = await onScreen(speed(1), dial({ pressAction: "set-1x-play" }));
      await vi.advanceTimersByTimeAsync(1_000);
      const throttle = surface["renderThrottle"];
      const stampedAt = throttle.lastImageSentAt.get(ctx.id);

      await press(surface, ctx, dial({ pressAction: "set-1x-play" }));

      expect(mocks.setPlaySpeed).toHaveBeenCalledWith(1, false);
      expect(throttle.lastImageSentAt.get(ctx.id)).toBe(stampedAt);
    });

    it("a state that goes back while a frame waits in the throttle is not drawn stale", async () => {
      // The replay has been seen playing at 1/4x, so the paused caption reads the same both times.
      noteTelemetrySpeed(speed(4, true), Date.now());
      const { surface, ctx, d } = await onScreen(speed(4, true));
      await vi.advanceTimersByTimeAsync(1_000);
      ctx.setDialCanvas.mockClear();

      // Into pause (pushed at once), out of it (waits for the window), and back in.
      surface.rotate(ctx as never, d, -1, false);
      await vi.advanceTimersByTimeAsync(20);
      surface.rotate(ctx as never, d, 1, false);
      await vi.advanceTimersByTimeAsync(20);
      surface.rotate(ctx as never, d, -1, false);
      await settle(200);

      expect(mocks.setPlaySpeed.mock.calls).toEqual([
        [0, false],
        [4, true],
        [0, false],
      ]);
      expect(shownValue(lastBox(ctx))).toBe("PAUSED");
      expect(ctx.setDialCanvas).toHaveBeenCalledTimes(1);
    });

    it("throttles pushes to at most 10 per second", async () => {
      const everyStop = dial({
        speedStops: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [String(i + 1), true])),
      });
      const { surface, ctx } = await onScreen(speed(-16), everyStop);
      ctx.setDialCanvas.mockClear();

      // Fifty detents in one second, each changing the speed on show.
      for (let i = 0; i < 50; i++) {
        surface.rotate(ctx as never, everyStop, i % 2 === 0 ? 2 : -1, false);
        await vi.advanceTimersByTimeAsync(20);
      }

      await settle();

      expect(ctx.setDialCanvas.mock.calls.length).toBeLessThanOrEqual(11);
      expect(ctx.setDialCanvas.mock.calls.length).toBeGreaterThan(0);
    });

    it("pushes nothing where the dial has no screen", async () => {
      const { surface, ctx, d } = await onScreen(speed(1), dial(), dialContext("ulanzi", null));

      surface.rotate(ctx as never, d, 1, false);
      await press(surface, ctx, d);
      surface.onTick(ctx.id, tickOf());
      await settle();

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
      // The dial still works without one.
      expect(mocks.setPlaySpeed).toHaveBeenCalledWith(2, false);
    });

    it("draws the knob at its own size", async () => {
      const { ctx } = await onScreen(speed(1), dial(), dialContext("knob", KNOB));

      expect(lastBox(ctx)).toContain('viewBox="0 0 176 112"');
      expect(shownValue(lastBox(ctx))).toBe("1x");
    });

    it("pushes the name card to the strip's dial slot only", async () => {
      const strip = dialContext("sd");
      const knob = dialContext("knob", KNOB);
      const surface = makeSurface();

      await appear(surface, strip);
      await appear(surface, knob);

      expect(strip.setImage).toHaveBeenCalledTimes(1);
      expect(strip.setImage.mock.calls[0][0]).toContain(">REPLAY</text>");
      expect(strip.setImage.mock.calls[0][0]).toContain(">CONTROL</text>");
      expect(knob.setImage).not.toHaveBeenCalled();
    });

    it("a context that disappeared is not drawn by a pending flush", async () => {
      const { surface, ctx, d } = await onScreen(speed(1));
      surface.rotate(ctx as never, d, 1, false);
      ctx.setDialCanvas.mockClear();

      surface.willDisappear(ctx.id);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
    });

    it("a failed push is retried by the next tick", async () => {
      const { surface, ctx } = await onScreen(speed(1));
      ctx.setDialCanvas.mockRejectedValueOnce(new Error("socket closed"));

      nowPlaying(speed(2));
      surface.onTick(ctx.id, tickOf());
      await settle();
      surface.onTick(ctx.id, tickOf());
      await settle();

      expect(shownValue(lastBox(ctx))).toBe("2x");
      expect(ctx.setDialCanvas).toHaveBeenCalledTimes(3);
    });

    it("new settings redraw the box at once", async () => {
      const { surface, ctx } = await onScreen(speed(8));
      expect(sides(lastBox(ctx))).toEqual({ left: true, right: false });

      await surface.didReceiveSettings(ctx as never, dial({ speedStops: { "16": true } }));
      await settle();

      expect(sides(lastBox(ctx))).toEqual({ left: true, right: true });
    });
  });

  describe("the paused replay's frame in the log", () => {
    /** A replay tick at `frame`, paused unless `s` says otherwise. */
    function at(frame: number, s: ReplaySpeed = PAUSED, extra: Partial<TelemetryData> = {}): ReplayDialReading {
      return tickOf({
        ...replayAt(s),
        ReplayFrameNum: frame,
        ReplaySessionTime: frame / 60,
        ...extra,
      } as TelemetryData);
    }

    function moves(): string[] {
      return logger.debug.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("Paused replay"));
    }

    it("logs each move between two paused ticks, with the frames, the distance and the time", async () => {
      const { surface, ctx } = await onScreen(PAUSED);

      surface.onTick(ctx.id, at(600));
      surface.onTick(ctx.id, at(601));
      surface.onTick(ctx.id, at(2));

      expect(moves()).toEqual([
        "Paused replay moved: frame 600 -> 601 (+1), time=10.017, speed=0, replaying=true",
        "Paused replay moved: frame 601 -> 2 (-599), time=0.033, speed=0, replaying=true",
      ]);
    });

    it("logs nothing while the frame stands still", async () => {
      const { surface, ctx } = await onScreen(PAUSED);

      for (let i = 0; i < 5; i++) surface.onTick(ctx.id, at(600));

      expect(moves()).toEqual([]);
    });

    it("only follows a replay that plays from tick to tick", async () => {
      const { surface, ctx } = await onScreen(speed(1));

      for (let frame = 600; frame < 660; frame++) surface.onTick(ctx.id, at(frame, speed(1)));

      expect(moves()).toEqual([]);
    });

    it("logs a tick that does not read as paused next to one that does, with what it carried", async () => {
      const { surface, ctx } = await onScreen(PAUSED);

      surface.onTick(ctx.id, at(600));
      // The stretch after a seek: the snapshot is not the replay's.
      surface.onTick(ctx.id, at(0, speed(1), { IsReplayPlaying: false, ReplaySessionTime: 0 }));
      surface.onTick(ctx.id, at(602));

      expect(moves()).toEqual([
        "Paused replay moved: frame 600 -> 0 (-600), time=0.000, speed=1, replaying=false",
        "Paused replay moved: frame 0 -> 602 (+602), time=10.033, speed=0, replaying=true",
      ]);
    });

    it("logs a tick once however many dials are handed it", async () => {
      const { surface, ctx } = await onScreen(PAUSED);
      const second = dialContext("dial-2");

      await appear(surface, second, dial({ mode: "frame-jog" }));
      logger.debug.mockClear();

      for (const frame of [600, 601]) {
        surface.onTick(ctx.id, at(frame));
        surface.onTick(second.id, at(frame));
      }

      expect(moves()).toHaveLength(1);
    });

    it("does not span a stretch out of the replay, or one without a frame", async () => {
      const { surface, ctx } = await onScreen(PAUSED);

      surface.onTick(ctx.id, at(600));
      env.inReplay = false;
      surface.onTick(ctx.id, at(9_000));
      env.inReplay = true;
      surface.onTick(ctx.id, at(700));
      surface.onTick(ctx.id, tickOf(null));
      surface.onTick(ctx.id, at(800));

      expect(moves()).toEqual([]);
    });

    it("ignores a tick for a dial that is not on screen", async () => {
      const { surface, ctx } = await onScreen(PAUSED);

      surface.onTick(ctx.id, at(600));
      surface.onTick("gone", at(900));
      surface.onTick(ctx.id, at(601));

      expect(moves()).toEqual(["Paused replay moved: frame 600 -> 601 (+1), time=10.017, speed=0, replaying=true"]);
    });
  });

  describe("trigger descriptions", () => {
    it("describe the mode's rotation and the gestures, the long press as a hold hint", () => {
      expect(buildTriggerDescription(dial())).toEqual({
        rotate: "Replay speed",
        push: "Play/Pause (hold: Set 1x and play)",
      });
      expect(
        buildTriggerDescription(
          dial({
            pressAction: "none",
            longPressAction: "reverse",
            tapAction: "jump-to-live",
            longTouchAction: "play-pause",
          }),
        ),
      ).toEqual({
        rotate: "Replay speed",
        push: "Hold: Reverse direction",
        touch: "Jump to Live",
        longTouch: "Play/Pause",
      });
      expect(buildTriggerDescription(dial({ pressAction: "reverse", longPressAction: "none" }))).toEqual({
        rotate: "Replay speed",
        push: "Reverse direction",
      });
      expect(buildTriggerDescription(dial({ pressAction: "none", longPressAction: "none" }))).toEqual({
        rotate: "Replay speed",
      });
    });

    it("take the rotation from the mode's own description", () => {
      for (const mode of REPLAY_DIAL_MODES) {
        expect(buildTriggerDescription(dial({ mode })).rotate).toBe(DIAL_MODES[mode].rotateDescription);
      }
    });

    it("name Frame Jog's rotation on a Frame Jog dial, with the same gesture hints", () => {
      expect(buildTriggerDescription(dial({ mode: "frame-jog" }))).toEqual({
        rotate: "Next / previous frame",
        push: "Play/Pause (hold: Set 1x and play)",
      });
    });

    it("are pushed on Elgato only, and again when the settings change", async () => {
      const surface = makeSurface();
      const elgato = dialContext("sd");
      await appear(surface, elgato);
      expect(elgato.setTriggerDescription).toHaveBeenCalledWith(buildTriggerDescription(dial()));

      const changed = dial({ pressAction: "reverse" });
      await surface.didReceiveSettings(elgato as never, changed);
      expect(elgato.setTriggerDescription).toHaveBeenLastCalledWith(buildTriggerDescription(changed));

      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
      const knob = dialContext("knob", KNOB);
      await appear(surface, knob);
      expect(knob.setTriggerDescription).not.toHaveBeenCalled();
    });
  });
});
