import { replaySpeedFromTelemetry, replaySpeedToSdk, type TelemetryData } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetReplayCursor, claimReplayCursor, currentReplayCursorOwner } from "../../shared/replay-cursor.js";
import type { ReplayDialModeIo, ReplaySpeed } from "./replay-control-dial-mode.js";
import { REPLAY_DIAL_MODES, ReplayControlDialSettings } from "./replay-control-dial-settings.js";
import {
  buildTriggerDescription,
  DIAL_MODE_LABELS,
  DIAL_MODES,
  ReplayControlDialSurface,
} from "./replay-control-dial-surface.js";
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
  thresholdMs: { value: 500 },
}));

// The dial surface reads the replay commands through deck-iracing; this suite
// mocks deck-core without a ConnectionStateAwareAction, so the real barrel (whose
// SimIRacingAction extends it) cannot load.
vi.mock("@iracedeck/deck-iracing", () => ({
  getCommands: () => ({
    replay: { setPlaySpeed: mocks.setPlaySpeed, pause: mocks.pause, nextFrame: mocks.nextFrame },
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
  telemetry: null as TelemetryData | null,
};

/** Telemetry catches up with a command: the replay now plays at `s`. */
function nowPlaying(s: ReplaySpeed): void {
  env.telemetry = replayAt(s);
}

const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const host = {
  setLocalSpeed: vi.fn((_speed: number, _slowMotion: boolean) => undefined),
  jumpToLive: vi.fn(() => undefined),
  refreshKeys: vi.fn(() => undefined),
};

function makeSurface(): ReplayControlDialSurface {
  return new ReplayControlDialSurface({
    logger: logger as never,
    inReplay: () => env.inReplay,
    telemetry: () => env.telemetry,
    telemetrySpeed: () => (env.telemetry ? replaySpeedFromTelemetry(env.telemetry) : null),
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

  return texts.filter((t) => t !== "SPEED").at(-1) ?? "";
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
      surface.onTick(ctx.id);
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
      surface.onTick(ctx.id);
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
      surface.onTick(ctx.id);
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
      // From the car.
      env.inReplay = false;
      surface.rotate(ctx as never, dial(), -1, false);
      await press(surface, ctx, dial());

      expectNothingSent();
      expect(currentReplayCursorOwner()).toBe("fastest-lap");
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
      surface.onTick(ctx.id);
      await settle();

      expect(lastBox(ctx)).not.toContain("data-dimmed");
      expect(shownValue(lastBox(ctx))).toBe("2x");
    });

    it.each(REPLAY_DIAL_MODES)("labels the dimmed %s box with the label the mode itself shows", async (mode) => {
      const { surface } = await onScreen(speed(1), dial({ mode }));

      expect(DIAL_MODE_LABELS[mode]).toBe(DIAL_MODES[mode].view(dial({ mode }), surface["io"]).label);
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

      surface.onTick("late-tick");
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
      surface.onTick(ctx.id);
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
      surface.onTick(ctx.id);
      await settle();

      expect(lastBox(ctx)).toContain("data-pending-bar");
      expect(shownValue(lastBox(ctx))).toBe("► 1x");
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
      surface.onTick(ctx.id);
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
        surface.onTick(ctx.id);
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
        surface.onTick(ctx.id);
        await vi.advanceTimersByTimeAsync(16);
      }

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
    });

    it("a speed set elsewhere is pushed on the tick that carries it", async () => {
      const { surface, ctx } = await onScreen(speed(1));

      nowPlaying(speed(-8));
      surface.onTick(ctx.id);
      await settle();

      expect(shownValue(lastBox(ctx))).toBe("-8x");
    });

    it("a changed tick builds its frame once: the flush draws the frame the tick built", async () => {
      const { surface, ctx } = await onScreen(speed(1));
      const view = vi.spyOn(DIAL_MODES.speed, "view");
      ctx.setDialCanvas.mockClear();

      nowPlaying(speed(2));
      surface.onTick(ctx.id);
      await settle();

      expect(ctx.setDialCanvas).toHaveBeenCalledTimes(1);
      expect(view).toHaveBeenCalledTimes(1);
      view.mockRestore();
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
      surface.onTick(ctx.id);
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
      surface.onTick(ctx.id);
      await settle();
      surface.onTick(ctx.id);
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
