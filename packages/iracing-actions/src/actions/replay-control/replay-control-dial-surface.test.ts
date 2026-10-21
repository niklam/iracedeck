import {
  getCarNumberRawFromSessionInfo,
  ReplayPosMode,
  replaySpeedFromTelemetry,
  replaySpeedToSdk,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import {
  _resetCameraSwitchWaiter,
  _resetReplaySpeedState,
  cancelReplayCursorOwner,
  claimReplayCursor,
  currentReplayCursorOwner,
  DIAL_SPEED_HOLD_MS,
  FASTEST_LAP_WALK_OWNER,
  getReplayGateRecord,
  getReplayGateView,
  isReplayMoveUnderWay,
  lastListedSessionNum,
  noteReplaySpeedSent,
  noteTelemetrySpeed,
  onReplaySpeedChanged,
  pressReplayCommand,
  RACE_START_WALK_OWNER,
  type RecordStepSource,
  rememberedSpeed,
  REPLAY_TARGET_GIVE_UP_MS,
  type ReplayGateNotice,
  subscribeReplayGate,
} from "@iracedeck/replay-engine";
import type { ReplaySessionStore } from "@iracedeck/replay-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { labelClearsSideMarks } from "../../shared/dial-label-fit.js";
import { registerReplayBusySurface, type ReplayBusyLook } from "../../shared/replay-busy-indicator.js";
import { engineOverDeck } from "../../shared/replay-engine-deck.test-support.js";
import type { ReplayDialModeIo, ReplaySpeed } from "./replay-control-dial-mode.js";
import { REPLAY_DIAL_MODES, ReplayControlDialSettings } from "./replay-control-dial-settings.js";
import {
  buildTriggerDescription,
  CAPTION_GIVES_WAY_TO_MARK,
  DIAL_MODES,
  REPLAY_DIAL_MODE_LABELS,
  ReplayControlDialSurface,
  type ReplayDialReading,
  resolveDialGesture,
  TURN_DRAWS_WORKING,
} from "./replay-control-dial-surface.js";
import { frameJogMode } from "./replay-control-frame-jog.js";
import { incidentMode } from "./replay-control-incident-mode.js";
import { lapMode } from "./replay-control-lap-mode.js";
import { sessionMode } from "./replay-control-session-mode.js";
import { speedMode } from "./replay-control-speed-mode.js";
import { trackOrderMode } from "./replay-control-track-order-mode.js";

/**
 * The paced search (#801) is another module's, and its runner is not under
 * test here: the surface's half is what it hands a turn and when it redraws,
 * so the queue is a recording double whose state a test sets.
 */
const queue = vi.hoisted(() => ({
  turns: [] as Array<{ target: string; ticks: number; origin: string; owner: string }>,
  pending: null as { target: string; count: number; origin: string } | null,
  running: null as string | null,
  /** Called as a turn is queued, for a test that asks what stood when it went out. */
  onTurn: null as null | (() => void),
  listeners: new Set<() => void>(),
}));

vi.mock("@iracedeck/replay-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/replay-engine")>()),
  queueReplaySearch: (turn: { target: string; ticks: number; origin: string; owner: string }) => {
    queue.onTurn?.();
    queue.turns.push(turn);
  },
  pendingReplaySearch: () => queue.pending,
  isReplaySearchRunning: (target: string) => queue.running === target,
  onReplaySearchChange: (listener: () => void) => {
    queue.listeners.add(listener);

    return () => {
      queue.listeners.delete(listener);
    };
  },
  _resetReplaySearchQueue: () => undefined,
}));

/** The replay record the host's record source reads (#801): null for none initialized. */
const store = { value: null as unknown };

const mocks = vi.hoisted(() => ({
  nextLap: vi.fn(() => true),
  setPlaySpeed: vi.fn((_speed: number, _slowMotion?: boolean) => true),
  pause: vi.fn(() => true),
  nextFrame: vi.fn(() => true),
  prevFrame: vi.fn(() => true),
  setPlayPosition: vi.fn((_mode: number, _frame: number) => true),
  nextSession: vi.fn(() => true),
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
      nextLap: mocks.nextLap,
      nextSession: mocks.nextSession,
    },
  }),
}));

// The engine over this file's deck-iracing mocks (#1467). Every reset goes through
// resetEngine, which resets each engine module and configures the engine again.
const { configureEngine, resetEngine } = engineOverDeck();

configureEngine();

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

/** A busy surface as the dial registers it (#1437). */
interface BusySurface {
  readonly token: string;
  readonly drawsWorking: boolean;
  redraw(look: ReplayBusyLook): void;
}

// The replay busy indicator (#1437), driven by hand: a test sets a token's look
// and calls the redraw the surface registered, as the indicator's tick would.
// With `real` set, registration and the look go through the REAL indicator over
// the real gate, for the cases that hang on what it does with a registration.
const busy = vi.hoisted(() => ({
  looks: new Map<string, ReplayBusyLook>(),
  surfaces: new Map<string, BusySurface>(),
  unregistered: [] as string[],
  real: false,
  actual: null as null | typeof import("../../shared/replay-busy-indicator.js"),
}));

vi.mock("../../shared/replay-busy-indicator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/replay-busy-indicator.js")>();

  busy.actual = actual;

  return {
    registerReplayBusySurface: vi.fn((surface: BusySurface) => {
      busy.surfaces.set(surface.token, surface);

      const unregisterReal = busy.real ? actual.registerReplayBusySurface(surface) : () => undefined;

      return () => {
        busy.unregistered.push(surface.token);
        unregisterReal();

        if (busy.surfaces.get(surface.token) === surface) busy.surfaces.delete(surface.token);
      };
    }),
    getReplayBusyLook: (token: string): ReplayBusyLook =>
      busy.real ? actual.getReplayBusyLook(token) : (busy.looks.get(token) ?? { kind: "rest" }),
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
  /** What the SDK's session info is. */
  sessionInfo: null as unknown,
  /** Whether the loaded session is a saved replay (the controller's sticky `SimMode` answer). */
  replayOnlySession: false,
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

/** Every speed the engine recorded as sent in the running test, in order (#1467). */
const sentSpeeds: ReplaySpeed[] = [];
const host = {
  /** The fresh read; a mock so a test can count the native reads an entry takes. */
  telemetry: vi.fn(() => env.telemetry),
  jumpToLive: vi.fn(() => undefined),
  jumpToRaceStart: vi.fn(() => undefined),
  canJumpToRaceStart: vi.fn(() => true),
  jumpToMyCar: vi.fn(() => undefined),
  canJumpToMyCar: vi.fn(() => true),
  refreshKeys: vi.fn(() => undefined),
  /** The debounced replay state: in a replay, at the frame a fresh read shows, seen just now. */
  replayState: vi.fn((nowMs: number) => ({
    inReplay: env.inReplay,
    frame: env.telemetry?.ReplayFrameNum ?? null,
    replayOnlySession: env.replayOnlySession,
    tickReplayPlaying: env.telemetry?.IsReplayPlaying === true,
    tickFrame: env.telemetry?.ReplayFrameNum ?? null,
    replaySeenAt: env.inReplay ? nowMs : null,
  })),
  sessionInfo: vi.fn((): unknown => env.sessionInfo),
  /** The action's record-step source, over {@link store} and the session info, with the camera car the surface hands it. */
  recordSource: vi.fn((telemetry: TelemetryData | null): RecordStepSource => ({
    store: store.value as ReplaySessionStore | null,
    scope: undefined,
    camCarIdx: telemetry?.CamCarIdx,
    carNumberRaw: (carIdx) => getCarNumberRawFromSessionInfo(env.sessionInfo, carIdx),
    lapApproachFrames: 60,
    lastSessionNum: lastListedSessionNum(env.sessionInfo),
  })),
  tapBinding: vi.fn((_key: string) => Promise.resolve(true)),
  isBindingMissing: vi.fn((_keys: string | readonly string[]) => false),
  cancelCameraWalks: vi.fn((_by: string) => undefined),
};

function makeSurface(): ReplayControlDialSurface {
  return new ReplayControlDialSurface({
    logger: logger as never,
    inReplay: () => env.inReplay,
    telemetry: host.telemetry,
    jumpToLive: host.jumpToLive,
    jumpToRaceStart: host.jumpToRaceStart,
    canJumpToRaceStart: host.canJumpToRaceStart,
    jumpToMyCar: host.jumpToMyCar,
    canJumpToMyCar: host.canJumpToMyCar,
    refreshKeys: host.refreshKeys,
    replayState: host.replayState as never,
    sessionInfo: host.sessionInfo,
    recordSource: host.recordSource,
    tapBinding: host.tapBinding,
    isBindingMissing: host.isBindingMissing,
    cancelCameraWalks: host.cancelCameraWalks,
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

/** Every mode's label, which `shownValue` skips. */
const MODE_LABELS = new Set(REPLAY_DIAL_MODE_LABELS);

/** The value slot's text: the last `<text>` that is neither the caption, a neighbour nor the label. */
function shownValue(svg: string): string {
  const texts = [...svg.matchAll(/<text(?! data-)[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

  return texts.filter((t) => !MODE_LABELS.has(t)).at(-1) ?? "";
}

/** The texts drawn beside the value (#801), or null with none. */
function shownNeighbours(svg: string): { left: string; right: string } | null {
  const side = (name: string) => new RegExp(`<text data-neighbour="${name}"[^>]*>([^<]*)</text>`).exec(svg)?.[1] ?? "";
  const left = side("left");
  const right = side("right");

  return left === "" && right === "" ? null : { left, right };
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
    // The gate reads the same replay the surface does (#1430).
    resetEngine({ readTelemetry: () => env.telemetry, inReplay: () => env.inReplay });
    env.inReplay = true;
    env.telemetry = replayAt(speed(1));
    env.sessionInfo = null;
    env.replayOnlySession = false;
    queue.turns.length = 0;
    queue.pending = null;
    queue.running = null;
    queue.onTurn = null;
    queue.listeners.clear();
    sentSpeeds.length = 0;
    onReplaySpeedChanged((sent) => sentSpeeds.push(sent));
    host.isBindingMissing.mockReturnValue(false);
    host.tapBinding.mockResolvedValue(true);
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

    it("sends a pause for a detent into pause (#1430: a 0 goes through the gate as a pause)", async () => {
      const { surface, ctx, d } = await onScreen(speed(4, true));

      surface.rotate(ctx as never, d, -1, false);

      expect(mocks.pause).toHaveBeenCalledTimes(1);
      expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
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

    it("a dial send writes the resume speed through the gate", async () => {
      const { surface, ctx, d } = await onScreen(speed(1));

      surface.rotate(ctx as never, d, 1, false);

      // The gate recorded the send (#1467): the speed state's listeners heard it, and it is what Play resumes.
      expect(sentSpeeds).toEqual([speed(2)]);
      expect(rememberedSpeed()).toEqual(speed(2));
      // The keys redraw from the action's own subscription, not through the host.
      expect(host.refreshKeys).not.toHaveBeenCalled();
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
      expect(sentSpeeds).toEqual([]);
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

    it("sends nothing at the lapse: it redraws the dial and the keys", async () => {
      const { surface, ctx, d } = await onScreen(PAUSED);
      surface.rotate(ctx as never, d, 1, false);
      await settle();
      vi.clearAllMocks();

      await vi.advanceTimersByTimeAsync(PAST_THE_LAPSE);

      expectNothingSent();
      expect(ctx.setDialCanvas).toHaveBeenCalledTimes(1);
      expect(host.refreshKeys).toHaveBeenCalledTimes(1);
    });

    it("redraws the keys when the ignored speed lapses, so a Play/Pause key reads the replay as paused", async () => {
      const { surface, ctx, d } = await onScreen(PAUSED);

      surface.rotate(ctx as never, d, 1, false);
      // The send is the shown speed at once, for the keys too (#1467).
      expect(sentSpeeds).toEqual([speed(4, true)]);
      expect(surface["io"].liveSpeed()).toEqual(speed(4, true));

      // No tick follows: the replay never left 0x.
      await vi.advanceTimersByTimeAsync(PAST_THE_LAPSE);

      expect(host.refreshKeys).toHaveBeenCalledTimes(1);
      expect(surface["io"].liveSpeed()).toEqual(PAUSED);
    });

    it("reads the same speed back when the send took, so nothing changes for the keys", async () => {
      const { surface, ctx, d } = await onScreen(PAUSED);
      surface.rotate(ctx as never, d, 1, false);
      nowPlaying(speed(4, true));

      await vi.advanceTimersByTimeAsync(PAST_THE_LAPSE);

      expect(surface["io"].liveSpeed()).toEqual(speed(4, true));
      expect(rememberedSpeed()).toEqual(speed(4, true));
    });

    it("resyncs from what a fresh read says at the lapse, whatever the last tick said", async () => {
      const { surface, ctx, d } = await onScreen(speed(1));
      surface.onTick(ctx.id, tickOf());
      await press(surface, ctx, d);
      expect(surface["io"].liveSpeed()).toEqual(PAUSED);

      // iRacing's own bar resumes at 2x inside the hold, on a frame that delivers no tick.
      nowPlaying(speed(2));
      await vi.advanceTimersByTimeAsync(PAST_THE_LAPSE);

      expect(surface["io"].liveSpeed()).toEqual(speed(2));
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

    it("with no dial on screen at the lapse it draws nothing, and still redraws the keys", async () => {
      const { surface, ctx, d } = await onScreen(PAUSED);
      surface.rotate(ctx as never, d, 1, false);
      await settle();
      surface.willDisappear(ctx.id);
      vi.clearAllMocks();

      await vi.advanceTimersByTimeAsync(PAST_THE_LAPSE);

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
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
      // The follow timer, and the gate's poll while the step's target stands (#1430).
      expect(vi.getTimerCount()).toBe(2);

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
      expect(sentSpeeds).toEqual([PAUSED]);
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

        io.step("dial-frame-jog", 1);
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
      expect(sentSpeeds).toEqual([]);
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

    it("a command the dial itself sends leaves the move under way", async () => {
      const { surface } = await onScreen(PAUSED);
      const io = ioOf(surface);

      env.telemetry = pausedOn(600);
      io.jumpTo("dial-frame-jog", 640);
      io.pause("dial-play-pause");
      io.setSpeed("dial-speed", PAUSED);
      // Neither pause went out: nothing but another jump may, with a move under way.
      expect(mocks.pause).not.toHaveBeenCalled();
      expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
      env.telemetry = pausedOn(612);

      // The jump's fate is open: still measured from its target, and no step into it.
      expect(io.position()).toMatchObject({ frame: 640, seeking: true });
      expect(io.step("dial-frame-jog", 1)).toBe(false);
    });

    describe("a speed asked for while a move has not read back", () => {
      const jog = () => dial({ mode: "frame-jog" });

      /** A fast turn's jump to 5003 under way, as iRacing reports it. */
      async function jumpUnderWay() {
        const d = jog();
        const { surface, ctx } = await onScreen(PAUSED, d);

        surface.rotate(ctx as never, d, 3, false);
        env.telemetry = SEEKING;

        return { surface, ctx, d };
      }

      function lands(frame: number): void {
        env.telemetry = { ...replayAt(PAUSED), ReplayFrameNum: frame } as TelemetryData;
      }

      it("holds a Play until the jump reads back, then sends it once", async () => {
        const { surface, ctx, d } = await jumpUnderWay();

        await press(surface, ctx, d);
        await vi.advanceTimersByTimeAsync(200);

        expect(mocks.setPlaySpeed).not.toHaveBeenCalled();

        lands(5_003);
        await vi.advanceTimersByTimeAsync(60);

        expect(mocks.setPlaySpeed.mock.calls).toEqual([[1, false]]);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(mocks.setPlaySpeed).toHaveBeenCalledTimes(1);
      });

      it("reports the held speed as taken, and reads it as the live speed until it goes out", async () => {
        const { surface } = await jumpUnderWay();
        const io = ioOf(surface);

        expect(io.setSpeed("dial-speed", speed(2))).toBe(true);
        expect(io.liveSpeed()).toEqual(speed(2));
        expect(mocks.setPlaySpeed).not.toHaveBeenCalled();

        lands(5_003);
        await vi.advanceTimersByTimeAsync(60);

        expect(mocks.setPlaySpeed.mock.calls).toEqual([[2, false]]);
        expect(io.liveSpeed()).toEqual(speed(2));
      });

      it("sends no pause while a move is under way: the replay is paused already, and a pause alone would end the jump elsewhere", async () => {
        const { surface } = await jumpUnderWay();
        const io = ioOf(surface);

        expect(io.pause("dial-play-pause")).toBe(true);
        expect(io.setSpeed("dial-speed", PAUSED)).toBe(true);
        expect(mocks.pause).not.toHaveBeenCalled();
        expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
        // The move is untouched.
        expect(io.position()).toMatchObject({ frame: 5_003, seeking: true });
      });

      it("sends a pause as before once the move has read back", async () => {
        const { surface } = await jumpUnderWay();
        const io = ioOf(surface);

        lands(5_003);

        expect(io.pause("dial-play-pause")).toBe(true);
        expect(mocks.pause).toHaveBeenCalledTimes(1);
      });

      it("drops the held speed when the move never lands", async () => {
        const { surface, ctx, d } = await jumpUnderWay();

        await press(surface, ctx, d);
        // The jump ended somewhere else, and is given up.
        lands(13_772);
        await vi.advanceTimersByTimeAsync(REPLAY_TARGET_GIVE_UP_MS + 200);

        expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
      });

      it("drops the held speed when another action's command takes the replay", async () => {
        const { surface, ctx, d } = await jumpUnderWay();

        await press(surface, ctx, d);
        cancelReplayCursorOwner("next-lap");
        lands(21_400);
        await vi.advanceTimersByTimeAsync(500);

        expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
      });

      it("a second Play/Pause press takes the held Play back", async () => {
        const { surface, ctx, d } = await jumpUnderWay();

        await press(surface, ctx, d);
        await press(surface, ctx, d);
        lands(5_003);
        await vi.advanceTimersByTimeAsync(500);

        // The second press read the replay as about to play and took that back, sending nothing.
        expect(mocks.pause).not.toHaveBeenCalled();
        expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
        expect(mocks.setPlayPosition).toHaveBeenCalledTimes(1);
      });

      it("a jog turn while a Play is held drops it and jumps on, with no pause into the jump under way", async () => {
        const { surface, ctx, d } = await jumpUnderWay();

        await press(surface, ctx, d);
        surface.rotate(ctx as never, d, 2, false);
        lands(5_005);
        await vi.advanceTimersByTimeAsync(500);

        expect(mocks.pause).not.toHaveBeenCalled();
        expect(mocks.setPlayPosition).toHaveBeenLastCalledWith(ReplayPosMode.Begin, 5_005);
        expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
      });

      it("a Speed Control turn while a speed is held walks on from it", async () => {
        const { surface, ctx } = await jumpUnderWay();
        const io = ioOf(surface);

        io.setSpeed("dial-speed", speed(2));
        // The default ladder's next stop above 2x.
        surface.rotate(ctx as never, dial(), 1, false);
        lands(5_003);
        await vi.advanceTimersByTimeAsync(60);

        expect(mocks.setPlaySpeed.mock.calls).toEqual([[4, false]]);
      });

      it("drops the held speed when a pause follows it", async () => {
        const { surface, ctx, d } = await jumpUnderWay();

        await press(surface, ctx, d);
        ioOf(surface).pause("dial-frame-jog");
        lands(5_003);
        await vi.advanceTimersByTimeAsync(500);

        expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
        expect(mocks.pause).not.toHaveBeenCalled();
      });

      it("keeps only the newest speed asked for", async () => {
        const { surface } = await jumpUnderWay();
        const io = ioOf(surface);

        io.setSpeed("dial-speed", speed(2));
        io.setSpeed("dial-speed", speed(4));
        lands(5_003);
        await vi.advanceTimersByTimeAsync(60);

        expect(mocks.setPlaySpeed.mock.calls).toEqual([[4, false]]);
      });

      it("sends a speed at once when nothing is under way", async () => {
        const { surface } = await onScreen(PAUSED);

        ioOf(surface).setSpeed("dial-speed", speed(2));

        expect(mocks.setPlaySpeed.mock.calls).toEqual([[2, false]]);
      });
    });

    it("a jog turn after a Play that followed a fast turn steps from where playback got to", async () => {
      const d = dial({ mode: "frame-jog" });
      const { surface, ctx } = await onScreen(PAUSED, d);
      const io = ioOf(surface);

      // A fast turn, then Play before its jump has read back: held, then sent on the landing.
      surface.rotate(ctx as never, d, 3, false);
      io.setSpeed("dial-play-pause", speed(4));
      env.telemetry = { ...replayAt(PAUSED), ReplayFrameNum: 5_003 } as TelemetryData;
      await vi.advanceTimersByTimeAsync(60);

      expect(mocks.setPlaySpeed.mock.calls).toEqual([[4, false]]);

      // Two seconds of playback later the replay is far past the turn's target.
      await vi.advanceTimersByTimeAsync(2_000);
      env.telemetry = { ...replayAt(speed(4)), ReplayFrameNum: 5_480 } as TelemetryData;

      expect(io.position()).toMatchObject({ frame: 5_480, seeking: false });

      mocks.setPlayPosition.mockClear();
      surface.rotate(ctx as never, d, 1, false);

      // The jog pauses and steps from there; it does not go back to 5003.
      expect(mocks.pause).toHaveBeenCalledTimes(1);
      expect(mocks.nextFrame).toHaveBeenCalledTimes(1);
      expect(mocks.setPlayPosition).not.toHaveBeenCalled();
    });

    it("a cursor take by another action leaves the move under way: the replay is still headed there (#1430)", async () => {
      const { surface } = await onScreen(PAUSED);
      const io = ioOf(surface);

      env.telemetry = pausedOn(600);
      io.jumpTo("dial-frame-jog", 640);
      cancelReplayCursorOwner("jump-to-my-car");
      env.telemetry = SEEKING;

      expect(io.position()).toMatchObject({ frame: 640, seeking: true });
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
      const d = dial({ mode: "frame-jog" });
      const { surface, ctx } = await onScreen(PAUSED, d);

      env.telemetry = { ...replayAt(PAUSED), ReplayFrameNum: 600 } as TelemetryData;
      ioOf(surface).jumpTo("dial-frame-jog", 640);
      env.telemetry = SEEKING;
      flagDown();

      surface.rotate(ctx as never, d, 1, false);

      expect(mocks.setPlayPosition.mock.calls).toEqual([
        [ReplayPosMode.Begin, 640],
        [ReplayPosMode.Begin, 641],
      ]);
    });

    it("refuses again once that move is given up without reading back", async () => {
      const d = dial({ mode: "frame-jog" });
      const { surface, ctx } = await onScreen(PAUSED, d);

      env.telemetry = { ...replayAt(PAUSED), ReplayFrameNum: 600 } as TelemetryData;
      ioOf(surface).jumpTo("dial-frame-jog", 640);
      env.telemetry = SEEKING;
      flagDown();
      await vi.advanceTimersByTimeAsync(REPLAY_TARGET_GIVE_UP_MS + 100);

      surface.rotate(ctx as never, d, 1, false);

      expect(mocks.setPlayPosition).toHaveBeenCalledTimes(1);
      expect(mocks.nextFrame).not.toHaveBeenCalled();
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

    it("Jump to Race Start runs the action's own press and sends nothing itself (#1354)", async () => {
      const { surface, ctx } = await onScreen(speed(1));

      await press(surface, ctx, dial({ pressAction: "jump-to-race-start" }));

      expect(host.jumpToRaceStart).toHaveBeenCalledTimes(1);
      expect(host.jumpToLive).not.toHaveBeenCalled();
      expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
      expect(mocks.pause).not.toHaveBeenCalled();
    });

    it("Jump to Race Start sends nothing from the car, like every other gesture (#1354)", async () => {
      const { surface, ctx } = await onScreen(speed(1));

      env.inReplay = false;
      await press(surface, ctx, dial({ pressAction: "jump-to-race-start" }));

      expect(host.jumpToRaceStart).not.toHaveBeenCalled();
    });

    it("Jump to My Car runs the action's own press and sends nothing itself (#801)", async () => {
      const { surface, ctx } = await onScreen(speed(1));

      await press(surface, ctx, dial({ pressAction: "jump-to-my-car" }));

      expect(host.jumpToMyCar).toHaveBeenCalledTimes(1);
      expect(host.jumpToLive).not.toHaveBeenCalled();
      expect(host.jumpToRaceStart).not.toHaveBeenCalled();
      expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
      expect(mocks.pause).not.toHaveBeenCalled();
    });

    it("Jump to My Car sends nothing from the car, like every other gesture (#801)", async () => {
      const { surface, ctx } = await onScreen(speed(1));

      env.inReplay = false;
      await press(surface, ctx, dial({ pressAction: "jump-to-my-car" }));

      expect(host.jumpToMyCar).not.toHaveBeenCalled();
    });

    describe("the Mode default (#801)", () => {
      it("is Long Press's default", () => {
        expect(dial().longPressAction).toBe("mode-default");
      });

      it.each(REPLAY_DIAL_MODES.filter((mode) => mode !== "track-order"))(
        "a long press runs Set 1x and Play in %s",
        async (mode) => {
          const d = dial({ mode });
          const { surface, ctx } = await onScreen(speed(-4), d);

          await press(surface, ctx, d, 500);

          expect(mocks.setPlaySpeed.mock.calls).toEqual([[1, false]]);
          expect(host.jumpToMyCar).not.toHaveBeenCalled();
        },
      );

      it("a long press runs Jump to My Car in Track Order", async () => {
        const d = dial({ mode: "track-order" });
        const { surface, ctx } = await onScreen(speed(-4), d);

        await press(surface, ctx, d, 500);

        expect(host.jumpToMyCar).toHaveBeenCalledTimes(1);
        expectNothingSent();
      });

      it("follows the Mode on any slot it is set on, and a specific pick does not", async () => {
        const track = dial({ mode: "track-order", pressAction: "mode-default", tapAction: "mode-default" });
        const { surface, ctx } = await onScreen(speed(2), track);

        await press(surface, ctx, track);
        surface.touchTap(ctx as never, track, false);
        expect(host.jumpToMyCar).toHaveBeenCalledTimes(2);

        // A specific pick is the same in every mode.
        const pick = dial({ mode: "track-order", longPressAction: "set-1x-play" });
        await press(surface, ctx, pick, 500);
        expect(mocks.setPlaySpeed.mock.calls).toEqual([[1, false]]);
        expect(host.jumpToMyCar).toHaveBeenCalledTimes(2);
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
      expect(sentSpeeds).toEqual([]);
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

    it("registers one mode per dial.mode value: Speed Control, Frame Jog, Lap, Session, Incident and Track Order", () => {
      expect(Object.keys(DIAL_MODES)).toEqual([...REPLAY_DIAL_MODES]);
      expect(DIAL_MODES.speed).toBe(speedMode);
      expect(DIAL_MODES["frame-jog"]).toBe(frameJogMode);
      expect(DIAL_MODES.lap).toBe(lapMode);
      expect(DIAL_MODES.session).toBe(sessionMode);
      expect(DIAL_MODES.incident).toBe(incidentMode);
      expect(DIAL_MODES["track-order"]).toBe(trackOrderMode);
    });

    it("labels are distinct, so the box says which mode the dial is in", () => {
      const labels = REPLAY_DIAL_MODES.map((mode) => DIAL_MODES[mode].label);

      expect(labels).toEqual(["SPEED", "FRAME", "LAP", "SESSION", "INCIDENT", "TRK ORD"]);
      expect(REPLAY_DIAL_MODE_LABELS).toEqual(labels);
      expect(new Set(labels).size).toBe(labels.length);
    });

    it.each(REPLAY_DIAL_MODE_LABELS)(
      "%s leaves at least INCIDENT's room between itself and the side marks on the strip and the knob",
      (label) => {
        expect(labelClearsSideMarks(label, "strip")).toBe(true);
        expect(labelClearsSideMarks(label, "knob")).toBe(true);
      },
    );

    it("a Frame Jog dial's turn goes to Frame Jog, never to the speed ladder", async () => {
      const d = dial({ mode: "frame-jog" });
      const { surface, ctx } = await onScreen(PAUSED, d);
      const jog = vi.spyOn(frameJogMode, "rotate");
      const ladder = vi.spyOn(speedMode, "rotate");

      surface.rotate(ctx as never, d, 1, false);
      // The step reads back before the next turn, so that one is a step too.
      env.telemetry = { ...replayAt(PAUSED), ReplayFrameNum: 5_001 } as TelemetryData;
      surface.rotate(ctx as never, d, -1, false);

      // The dial's own io: the shared one, with its origin token bound (#801).
      expect(jog).toHaveBeenNthCalledWith(1, 1, d, surface["contexts"].get(ctx.id)?.io);
      expect(jog).toHaveBeenNthCalledWith(2, -1, d, surface["contexts"].get(ctx.id)?.io);
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
      ["Jump to Race Start", "jump-to-race-start", speed(1), null, "START"],
      ["Jump to My Car", "jump-to-my-car", speed(1), null, "MY CAR"],
      ["the Mode default outside Track Order, as Set 1x and play", "mode-default", speed(-4), null, "► 1x"],
    ])("previews %s", async (_name, longPressAction, live, remembered, expected) => {
      if (remembered) noteTelemetrySpeed(remembered, Date.now());

      host.canJumpToMyCar.mockReturnValue(true);
      const d = dial({ longPressAction });
      const { surface, ctx } = await onScreen(live, d);

      surface.down(ctx as never, d);
      await vi.advanceTimersByTimeAsync(500);

      expect(shownValue(lastBox(ctx))).toBe(expected);
      expect(lastBox(ctx)).toContain("data-pending-bar");
    });

    it("previews the Mode default in Track Order as Jump to My Car", async () => {
      host.canJumpToMyCar.mockReturnValue(true);
      const d = dial({ mode: "track-order" });
      const { surface, ctx } = await onScreen(speed(1), d);

      surface.down(ctx as never, d);
      await vi.advanceTimersByTimeAsync(500);

      expect(shownValue(lastBox(ctx))).toBe("MY CAR");
      expect(lastBox(ctx)).toContain("data-pending-bar");
    });

    it.each<[string, () => void, Record<string, unknown>]>([
      ["a long press set to None", () => undefined, { longPressAction: "none" }],
      ["a dial out of a replay", () => (env.inReplay = false), {}],
      [
        "Jump to Race Start in a replay with no race session",
        () => host.canJumpToRaceStart.mockReturnValue(false),
        { longPressAction: "jump-to-race-start" },
      ],
      [
        "Jump to My Car with no car of the player's to switch to",
        () => host.canJumpToMyCar.mockReturnValue(false),
        { longPressAction: "jump-to-my-car" },
      ],
      [
        "the Mode default in Track Order with no car of the player's",
        () => host.canJumpToMyCar.mockReturnValue(false),
        { mode: "track-order" },
      ],
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

      expect(mocks.pause).toHaveBeenCalledTimes(2);
      expect(mocks.setPlaySpeed.mock.calls).toEqual([[4, true]]);
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

  describe("Lap, Session, Incident and Track Order (#801)", () => {
    /** Car 4 (number 12, raw 104) in a three-session event. */
    const SESSION_INFO = {
      SessionInfo: {
        Sessions: [
          { SessionNum: 0, SessionType: "Practice" },
          { SessionNum: 1, SessionType: "Qualify" },
          { SessionNum: 2, SessionType: "Race" },
        ],
      },
      DriverInfo: { Drivers: [{ CarIdx: 4, CarNumber: "12", CarNumberRaw: 104 }] },
    };

    /** Car 4's laps 1-8, the line crossed every 3000 frames from 50 000; a lap jump lands 60 frames before it. */
    const LAP_STARTS = [50_000, 53_000, 56_000, 59_000, 62_000, 65_000, 68_000, 71_000].map((frame, i) => ({
      frame,
      lap: i + 1,
      sessionNum: 2,
      sessionUniqueId: 3,
    }));

    const SESSION_STARTS = [0, 20_000, 40_000].map((frame, i) => ({ sessionNum: i, sessionUniqueId: 3, frame }));

    /** A paused replay tick at `frame`, the camera on car 4, in session 2. */
    function pausedOn(frame: number, extra: Partial<TelemetryData> = {}): TelemetryData {
      return {
        ...replayAt(PAUSED),
        ReplayFrameNum: frame,
        ReplaySessionTime: frame / 60,
        ReplaySessionNum: 2,
        CamCarIdx: 4,
        ...extra,
      } as TelemetryData;
    }

    /** What iRacing reports while a jump is under way. */
    const SEEKING = { ...replayAt(PAUSED), IsReplayPlaying: false, ReplayFrameNum: 0, CamCarIdx: 4 } as TelemetryData;

    function withRecord(laps = LAP_STARTS, sessions = SESSION_STARTS): void {
      store.value = {
        laps: { listLapStarts: () => ({ hit: true, starts: laps }) },
        sessions: { list: () => ({ hit: true, starts: sessions }) },
      };
    }

    async function dialIn(mode: string, telemetry: TelemetryData, ctx = dialContext()) {
      env.telemetry = telemetry;
      env.sessionInfo = SESSION_INFO;
      const d = dial({ mode });
      const surface = makeSurface();
      await appear(surface, ctx, d);

      return { surface, ctx, d };
    }

    const seeks = () => mocks.setPlayPosition.mock.calls.map((call) => call[1]);

    beforeEach(() => {
      store.value = null;
      _resetCameraSwitchWaiter();
    });

    describe("Lap and Session: one waited jump per turn", () => {
      it.each<[number, number]>([
        [1, 56_000 - 60],
        [5, 68_000 - 60],
      ])("a turn of %i detents sends one jump, to the entry the walk reaches", async (ticks, landing) => {
        withRecord();
        const { surface, ctx, d } = await dialIn("lap", pausedOn(54_000));

        surface.rotate(ctx as never, d, ticks, false);

        expect(seeks()).toEqual([landing]);
        expect(mocks.pause).not.toHaveBeenCalled();
        expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
        expect(queue.turns).toEqual([]);
      });

      it("a Session turn jumps to the recorded session's landing", async () => {
        withRecord();
        const { surface, ctx, d } = await dialIn("session", pausedOn(25_000, { ReplaySessionNum: 1 }));

        surface.rotate(ctx as never, d, 1, false);

        expect(seeks()).toEqual([40_000 + 120]);
      });

      it("a turn during a jump steps from where it is headed, on a mid-seek tick a second later", async () => {
        withRecord();
        const { surface, ctx, d } = await dialIn("lap", pausedOn(54_000));

        surface.rotate(ctx as never, d, 1, false);
        env.telemetry = SEEKING;
        await vi.advanceTimersByTimeAsync(1_100);
        surface.rotate(ctx as never, d, 2, false);

        expect(seeks()).toEqual([56_000 - 60, 62_000 - 60]);
        expect(mocks.pause).not.toHaveBeenCalled();
      });

      it("on a playing replay the first jump pauses; a second turn before the pause shows seeks at once, with no second pause", async () => {
        withRecord();
        const { surface, ctx, d } = await dialIn("lap", {
          ...replayAt(speed(1)),
          ReplayFrameNum: 54_000,
          CamCarIdx: 4,
        } as TelemetryData);

        surface.rotate(ctx as never, d, 1, false);
        expect(mocks.setPlaySpeed.mock.calls).toEqual([[0]]);
        expect(seeks()).toEqual([]);

        surface.rotate(ctx as never, d, 1, false);
        expect(seeks()).toEqual([59_000 - 60]);

        // The pause shows: nothing more goes out for it.
        env.telemetry = pausedOn(54_010);
        await vi.advanceTimersByTimeAsync(200);
        expect(mocks.setPlaySpeed.mock.calls).toEqual([[0]]);
        expect(seeks()).toEqual([59_000 - 60]);
      });

      it("a record that runs out part-way jumps as far as it reaches and drops the rest", async () => {
        withRecord(LAP_STARTS.slice(0, 5));
        const { surface, ctx, d } = await dialIn("lap", pausedOn(54_000));

        surface.rotate(ctx as never, d, 6, false);

        expect(seeks()).toEqual([62_000 - 60]);
        expect(queue.turns).toEqual([]);
      });

      it.each(["lap", "session"])("a %s turn the record has no step for goes to the search whole", async (mode) => {
        const { surface, ctx, d } = await dialIn(mode, pausedOn(54_000));

        surface.rotate(ctx as never, d, -3, false);

        expect(seeks()).toEqual([]);
        expect(queue.turns).toEqual([{ target: mode, ticks: -3, origin: ctx.id, owner: `dial-${mode}` }]);
      });

      it("a Lap turn while the search works for laps goes to its count, not to the record", async () => {
        withRecord();
        queue.running = "lap";
        const { surface, ctx, d } = await dialIn("lap", pausedOn(54_000));

        surface.rotate(ctx as never, d, 2, false);

        expect(seeks()).toEqual([]);
        expect(queue.turns).toEqual([{ target: "lap", ticks: 2, origin: ctx.id, owner: "dial-lap" }]);
      });

      it.each(["lap", "session", "incident", "track-order"])("a %s turn from the car sends nothing", async (mode) => {
        withRecord();
        const { surface, ctx, d } = await dialIn(mode, pausedOn(54_000));
        env.inReplay = false;

        surface.rotate(ctx as never, d, 1, false);
        await settle();

        expect(seeks()).toEqual([]);
        expect(queue.turns).toEqual([]);
        expect(host.tapBinding).not.toHaveBeenCalled();
      });

      it("a record jump from a paused replay sends no speed, reads paused, and the box is redrawn when the turn settles", async () => {
        withRecord();
        const { surface, ctx, d } = await dialIn("lap", pausedOn(54_000));

        surface.rotate(ctx as never, d, 1, false);
        env.telemetry = pausedOn(56_000 - 60);
        await vi.advanceTimersByTimeAsync(300);

        expect(currentReplayCursorOwner()).toBeNull();
        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
        // Nothing needed pausing and Replay jump playback kept the replay paused: no speed went out (#1467).
        expect(sentSpeeds).toEqual([]);
        expect(surface["io"].liveSpeed()).toEqual(PAUSED);
        expect(shownValue(lastBox(ctx))).toBe("3/8");
      });

      it("a record jump's pause and the speed it lands at are the dial's resume speed (#1467)", async () => {
        withRecord();
        const { surface, ctx, d } = await dialIn("lap", pausedOn(54_000, { ReplayPlaySpeed: 4 }));

        surface.rotate(ctx as never, d, 1, false);
        // iRacing reports the pause, then the landing.
        env.telemetry = pausedOn(54_000);
        await vi.advanceTimersByTimeAsync(50);
        env.telemetry = pausedOn(56_000 - 60);
        await vi.advanceTimersByTimeAsync(300);

        expect(mocks.setPlaySpeed.mock.calls).toEqual([[0], [4, false]]);
        expect(sentSpeeds).toEqual([PAUSED, speed(4)]);
        expect(rememberedSpeed()).toEqual(speed(4));
      });
    });

    describe("Incident", () => {
      it("every turn goes to the search", async () => {
        withRecord();
        const { surface, ctx, d } = await dialIn("incident", pausedOn(54_000));

        surface.rotate(ctx as never, d, 1, false);
        surface.rotate(ctx as never, d, -2, false);

        expect(queue.turns.map((turn) => [turn.target, turn.ticks, turn.owner])).toEqual([
          ["incident", 1, "dial-incident"],
          ["incident", -2, "dial-incident"],
        ]);
        expect(seeks()).toEqual([]);
      });
    });

    describe("the origin token (#1437)", () => {
      it("a Lap and a Session turn's record jump carries the turned dial's token", async () => {
        withRecord();
        const { surface, ctx, d } = await dialIn("lap", pausedOn(54_000), dialContext("lap-dial"));

        surface.rotate(ctx as never, d, 1, false);
        expect(getReplayGateRecord().jump).toEqual({ owner: "dial-lap", origin: "lap-dial" });

        const other = dialContext("session-dial");
        const session = dial({ mode: "session" });
        await appear(surface, other, session);
        surface.rotate(other as never, session, -1, false);
        expect(getReplayGateRecord().jump).toEqual({ owner: "dial-session", origin: "session-dial" });
      });

      it("each dial's search turn carries its own token", async () => {
        const surface = makeSurface();
        const a = dialContext("a");
        const b = dialContext("b");
        const d = dial({ mode: "incident" });
        env.telemetry = pausedOn(54_000);
        await appear(surface, a, d);
        await appear(surface, b, d);

        surface.rotate(a as never, d, 1, false);
        surface.rotate(b as never, d, 1, false);

        expect(queue.turns.map((turn) => turn.origin)).toEqual(["a", "b"]);
      });

      it("a Track Order turn carries none: it sends no replay command and claims nothing", async () => {
        const { surface, ctx, d } = await dialIn("track-order", pausedOn(54_000));

        surface.rotate(ctx as never, d, 1, false);
        await settle();

        expect(getReplayGateRecord().jump).toBeNull();
        expect(currentReplayCursorOwner()).toBeNull();
        expect(queue.turns).toEqual([]);
      });
    });

    describe("Car", () => {
      it("taps at once on a quiet replay, one tap per event, the right binding each way", async () => {
        const { surface, ctx, d } = await dialIn("track-order", pausedOn(54_000));
        // A Jump to Fastest Lap walk holding the cursor: the camera switch stops it.
        const walk = claimReplayCursor(FASTEST_LAP_WALK_OWNER);

        surface.rotate(ctx as never, d, 3, false);
        surface.rotate(ctx as never, d, -1, false);
        await settle();

        expect(host.tapBinding.mock.calls).toEqual([["replayControlNextCar"], ["replayControlPrevCar"]]);
        expect(walk.cancelledBy).toBe("dial-track-order");
      });

      it("taps at once behind a search: a search does not swallow a camera change", async () => {
        const { surface, ctx, d } = await dialIn("track-order", pausedOn(54_000));

        // A key's search on its way: no target, and no seek showing.
        pressReplayCommand({ kind: "search", search: "nextLap" }, { by: "next-lap", origin: "key" });
        expect(mocks.nextLap).toHaveBeenCalledOnce();

        surface.rotate(ctx as never, d, 1, false);
        await settle(0);

        expect(host.tapBinding).toHaveBeenCalledExactlyOnceWith("replayControlNextCar");
      });

      it("a turn during a jump waits until no jump has shown for three reads, then taps once", async () => {
        const { surface, ctx, d } = await dialIn("track-order", pausedOn(600));

        // A jump of the plugin's under way: a target standing, the replay seeking.
        surface["io"].jumpTo("dial-frame-jog", 9_000);
        env.telemetry = SEEKING;
        surface.rotate(ctx as never, d, 1, false);
        surface.rotate(ctx as never, d, -1, false);
        await vi.advanceTimersByTimeAsync(3_500);
        expect(host.tapBinding).not.toHaveBeenCalled();

        env.telemetry = pausedOn(9_000);
        await vi.advanceTimersByTimeAsync(400);

        expect(host.tapBinding).toHaveBeenCalledExactlyOnceWith("replayControlPrevCar");
      });

      it("a tap still waiting when the dial disappears is dropped", async () => {
        const { surface, ctx, d } = await dialIn("track-order", pausedOn(600));

        surface["io"].jumpTo("dial-frame-jog", 9_000);
        env.telemetry = SEEKING;
        surface.rotate(ctx as never, d, 1, false);
        surface.willDisappear(ctx.id);

        env.telemetry = pausedOn(9_000);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(host.tapBinding).not.toHaveBeenCalled();
      });

      it("a Long Press cancels only the two walks: another dial's paced search run is left standing", async () => {
        const { surface, ctx, d } = await dialIn("track-order", pausedOn(600));
        // The runner of another dial's paced search, holding the cursor.
        const run = claimReplayCursor("dial-lap");

        await press(surface, ctx, d, 500);
        await settle(0);

        expect(host.jumpToMyCar).toHaveBeenCalledOnce();
        expect(run.cancelledBy).toBeNull();
        expect(currentReplayCursorOwner()).toBe("dial-lap");
        run.release();

        // A Jump to Race Start walk is one of the two: the gesture stops it, under its own name.
        const walk = claimReplayCursor(RACE_START_WALK_OWNER);

        await press(surface, ctx, d, 500);
        await settle(0);

        expect(walk.cancelledBy).toBe("dial-jump-to-my-car");
        expect(host.jumpToMyCar).toHaveBeenCalledTimes(2);
      });

      it("a Long Press during a position jump switches to my car once the jump has landed", async () => {
        const { surface, ctx, d } = await dialIn("track-order", pausedOn(600));

        surface["io"].jumpTo("dial-frame-jog", 9_000);
        env.telemetry = SEEKING;
        await press(surface, ctx, d, 500);
        await vi.advanceTimersByTimeAsync(3_500);
        expect(host.jumpToMyCar).not.toHaveBeenCalled();

        env.telemetry = pausedOn(9_000);
        await vi.advanceTimersByTimeAsync(400);

        expect(host.jumpToMyCar).toHaveBeenCalledOnce();
        expect(host.tapBinding).not.toHaveBeenCalled();
      });

      it("a turn and a Long Press during one jump are one waiting switch: the later one goes out", async () => {
        const { surface, ctx, d } = await dialIn("track-order", pausedOn(600));

        surface["io"].jumpTo("dial-frame-jog", 9_000);
        env.telemetry = SEEKING;
        surface.rotate(ctx as never, d, 1, false);
        await press(surface, ctx, d, 500);
        env.telemetry = pausedOn(9_000);
        await vi.advanceTimersByTimeAsync(400);

        expect(host.jumpToMyCar).toHaveBeenCalledOnce();
        expect(host.tapBinding).not.toHaveBeenCalled();
      });

      it("draws the missing-binding warning on the box", async () => {
        host.isBindingMissing.mockReturnValue(true);
        const { ctx } = await dialIn("track-order", pausedOn(600));

        expect(lastBox(ctx)).toContain("<binding-warning/>");
        expect(shownValue(lastBox(ctx))).toBe("#12");
      });
    });

    describe("late input", () => {
      it.each(["lap", "incident"])("a %s turn after willDisappear sends nothing and starts no search", async (mode) => {
        withRecord();
        const { surface, ctx, d } = await dialIn(mode, pausedOn(54_000));

        surface.willDisappear(ctx.id);
        surface.rotate(ctx as never, d, 1, false);
        await settle();

        expect(seeks()).toEqual([]);
        expect(queue.turns).toEqual([]);
      });
    });

    describe("the display", () => {
      it("Lap shows the viewed car's lap from the record over the laps the record holds, and the replay time beneath", async () => {
        withRecord();
        const { ctx } = await dialIn("lap", pausedOn(57_000));

        // The session info schedules no laps: the record's eight for car 4 in the race.
        expect(shownValue(lastBox(ctx))).toBe("3/8");
        expect(shownCaption(lastBox(ctx))).toBe("15:50");

        // Without the record the lap on screen is not known, and nothing counts the laps.
        store.value = null;
        const other = dialContext("no-record");
        await dialIn("lap", pausedOn(5_010), other);
        expect(shownValue(lastBox(other))).toBe("--");
        expect(shownCaption(lastBox(other))).toBe("1:23");
      });

      it("Lap counts a session's scheduled laps over the record's", async () => {
        withRecord();
        const { surface, ctx } = await dialIn("lap", pausedOn(57_000));
        expect(shownValue(lastBox(ctx))).toBe("3/8");

        env.sessionInfo = {
          ...SESSION_INFO,
          SessionInfo: { Sessions: [{ SessionNum: 2, SessionType: "Race", SessionLaps: 25 }] },
        };
        surface.onTick(ctx.id, tickOf());
        await settle();

        expect(shownValue(lastBox(ctx))).toBe("3/25");
      });

      it("Session shows the session's type, upper-cased, and the viewed car's lap of the session beneath", async () => {
        withRecord();
        const { ctx } = await dialIn("session", pausedOn(57_000));

        expect(shownValue(lastBox(ctx))).toBe("RACE");
        expect(shownCaption(lastBox(ctx))).toBe("3/8");

        const qualifying = dialContext("qualifying");
        await dialIn("session", pausedOn(30_000, { ReplaySessionNum: 1 }), qualifying);
        expect(shownValue(lastBox(qualifying))).toBe("QUALIFY");
        // No lap of car 4's recorded in qualifying, and nothing to count its laps.
        expect(shownCaption(lastBox(qualifying))).toBe("--");
      });

      it("Incident shows the replay time with no caption, Track Order the viewed car's number alone", async () => {
        const { ctx } = await dialIn("incident", pausedOn(3_600 * 60 + 5 * 60));
        const car = dialContext("track-order");
        await dialIn("track-order", pausedOn(600), car);

        expect(shownValue(lastBox(ctx))).toBe("60:05");
        expect(lastBox(ctx)).not.toContain("data-caption");
        expect(shownValue(lastBox(car))).toBe("#12");
        expect(lastBox(car)).not.toContain("data-caption");
        expect(shownNeighbours(lastBox(car))).toBeNull();
        expect(sides(lastBox(car))).toEqual({ left: true, right: true });
      });

      it("the stepping modes keep the caption line, so their value has the size and place it has with a caption", async () => {
        const valueText = (svg: string) => /<text x="[^"]+" y="\d+"[^>]*>60:05<\/text>/.exec(svg)?.[0];
        const { ctx } = await dialIn("incident", pausedOn(3_600 * 60 + 5 * 60));
        const idle = valueText(lastBox(ctx));

        queue.pending = { target: "incident", count: 3, origin: ctx.id };

        for (const listener of queue.listeners) listener();

        await settle();
        expect(shownCaption(lastBox(ctx))).toBe("+3");
        expect(idle).toBeDefined();
        expect(valueText(lastBox(ctx))).toBe(idle);
      });

      it("Track Order flanks the car with its neighbours on track in a saved replay, and not scrubbed back in a live session's", async () => {
        const field = {
          DriverInfo: {
            Drivers: [
              { CarIdx: 2, CarNumber: "5", CarNumberRaw: 5 },
              { CarIdx: 4, CarNumber: "12", CarNumberRaw: 104 },
              { CarIdx: 7, CarNumber: "42", CarNumberRaw: 42 },
            ],
          },
        };
        const onTrack = pausedOn(600, {
          CarIdxLapDistPct: [-1, -1, 0.1, -1, 0.5, -1, -1, 0.95],
          CarIdxTrackSurface: [-1, -1, 3, -1, 3, -1, -1, 3],
          ReplayFrameNumEnd: 90_000,
        });
        const { surface, ctx } = await dialIn("track-order", onTrack);

        env.sessionInfo = field;
        env.replayOnlySession = true;
        surface.onTick(ctx.id, tickOf());
        await settle();
        expect(shownValue(lastBox(ctx))).toBe("#12");
        expect(shownNeighbours(lastBox(ctx))).toEqual({ left: "#5", right: "#42" });
        expect(lastBox(ctx)).not.toContain("data-caption");

        // A tick read mid-seek keeps the car and its neighbours, as it keeps a value.
        env.telemetry = SEEKING;
        surface.onTick(ctx.id, tickOf());
        await settle();
        expect(shownValue(lastBox(ctx))).toBe("#12");
        expect(shownNeighbours(lastBox(ctx))).toEqual({ left: "#5", right: "#42" });

        env.telemetry = onTrack;
        env.replayOnlySession = false;
        surface.onTick(ctx.id, tickOf());
        await settle();
        expect(shownValue(lastBox(ctx))).toBe("#12");
        expect(shownNeighbours(lastBox(ctx))).toBeNull();
      });

      it("the caption shows the search's count for the mode's target, redrawn on every change it reports", async () => {
        const { ctx } = await dialIn("incident", pausedOn(54_000));
        expect(queue.listeners.size).toBe(1);

        queue.pending = { target: "incident", count: 3, origin: ctx.id };

        for (const listener of queue.listeners) listener();

        await settle();
        expect(shownCaption(lastBox(ctx))).toBe("+3");

        queue.pending = { target: "incident", count: -2, origin: ctx.id };

        for (const listener of queue.listeners) listener();

        await settle();
        expect(shownCaption(lastBox(ctx))).toBe("-2");

        // Another target's count is not this dial's.
        queue.pending = { target: "lap", count: 4, origin: "other" };

        for (const listener of queue.listeners) listener();

        await settle();
        expect(shownCaption(lastBox(ctx))).toBe("");
      });

      it("subscribes to the search's count while a dial is on screen and lets go when the last one leaves", async () => {
        const surface = makeSurface();
        expect(queue.listeners.size).toBe(0);

        const a = dialContext("a");
        const b = dialContext("b");
        await appear(surface, a, dial({ mode: "lap" }));
        await appear(surface, b, dial({ mode: "incident" }));
        expect(queue.listeners.size).toBe(1);

        surface.willDisappear("a");
        expect(queue.listeners.size).toBe(1);
        surface.willDisappear("b");
        expect(queue.listeners.size).toBe(0);
      });

      it("draws nothing for the runner's speeds with no dial on screen, as after a page flip mid-run", async () => {
        const playing = { ...pausedOn(54_000), ...replayAt({ speed: 1, slowMotion: false }) } as TelemetryData;
        const { surface, ctx } = await dialIn("incident", playing);

        // The page flips away while the run the turn started goes on.
        surface.willDisappear(ctx.id);
        ctx.setDialCanvas.mockClear();

        // The runner's pause and playback step, as the gate records them (#1467).
        noteReplaySpeedSent(PAUSED, Date.now(), { rememberSpeed: true });
        await settle();
        noteReplaySpeedSent(speed(2), Date.now(), { rememberSpeed: true });
        await settle();

        // Nothing is drawn on a dial that has left; the keys redraw from the action's own subscription.
        expect(ctx.setDialCanvas).not.toHaveBeenCalled();
      });

      it("draws every speed the search's runner sends into a dial's caption, as a record jump's", async () => {
        const playing = { ...pausedOn(54_000), ...replayAt({ speed: 1, slowMotion: false }) } as TelemetryData;
        // Frame Jog's caption is the play state.
        const { ctx } = await dialIn("frame-jog", playing);
        expect(shownCaption(lastBox(ctx))).toBe("1x");

        // The runner paused the replay for its search: no tick follows yet.
        noteReplaySpeedSent(PAUSED, Date.now(), { rememberSpeed: true });

        await settle();
        expect(shownCaption(lastBox(ctx))).toBe("PAUSED");

        // The run ended at zero and its playback step played the replay on at 2x.
        noteReplaySpeedSent(speed(2), Date.now(), { rememberSpeed: true });

        await settle();
        expect(shownCaption(lastBox(ctx))).toBe("2x");
      });

      it("Lap and Session side marks: lit with somewhere to go, dim with a record that has nothing that way, lit with no record", async () => {
        withRecord();
        const { ctx } = await dialIn("session", pausedOn(41_000, { ReplaySessionNum: 2 }));
        expect(sides(lastBox(ctx))).toEqual({ left: true, right: false });

        const middle = dialContext("middle");
        await dialIn("session", pausedOn(30_000, { ReplaySessionNum: 1 }), middle);
        expect(sides(lastBox(middle))).toEqual({ left: true, right: true });

        store.value = null;
        const none = dialContext("none");
        await dialIn("session", pausedOn(41_000), none);
        expect(sides(lastBox(none))).toEqual({ left: true, right: true });
      });

      it("a tick read mid-seek leaves the value as it was", async () => {
        const { surface, ctx } = await dialIn("incident", pausedOn(3_600));
        expect(shownValue(lastBox(ctx))).toBe("1:00");

        env.telemetry = SEEKING;
        surface.onTick(ctx.id, tickOf());
        await settle();

        expect(shownValue(lastBox(ctx))).toBe("1:00");
      });

      it("a tick read mid-seek leaves the caption as it was too", async () => {
        withRecord();
        const { surface, ctx } = await dialIn("lap", pausedOn(57_000));
        expect(shownCaption(lastBox(ctx))).toBe("15:50");

        env.telemetry = SEEKING;
        surface.onTick(ctx.id, tickOf());
        await settle();

        expect(shownValue(lastBox(ctx))).toBe("3/8");
        expect(shownCaption(lastBox(ctx))).toBe("15:50");
      });

      it("during a record jump, Lap and Session show the entry at the pending landing", async () => {
        withRecord();
        const { surface, ctx, d } = await dialIn("lap", pausedOn(54_000));
        expect(shownValue(lastBox(ctx))).toBe("2/8");
        expect(shownCaption(lastBox(ctx))).toBe("15:00");

        surface.rotate(ctx as never, d, 2, false);
        env.telemetry = SEEKING;
        surface.onTick(ctx.id, tickOf());
        await settle();
        expect(shownValue(lastBox(ctx))).toBe("4/8");
        // The target's time beneath it, worked out from the reading the jump started from.
        expect(shownCaption(lastBox(ctx))).toBe("16:22");

        const session = dialContext("session");
        await dialIn("session", SEEKING, session);
        // The jump above is headed for 58 940, in session 2 by the record.
        expect(shownValue(lastBox(session))).toBe("RACE");
      });

      it("a paused dial pushes once: the signature holds everything shown, and nothing else", async () => {
        withRecord();
        const { surface, ctx } = await dialIn("lap", pausedOn(57_000));
        const pushes = ctx.setDialCanvas.mock.calls.length;

        surface.onTick(ctx.id, tickOf());
        surface.onTick(ctx.id, tickOf());
        await settle();
        expect(ctx.setDialCanvas.mock.calls.length).toBe(pushes);

        // The camera on another car changes what is shown.
        env.telemetry = pausedOn(57_000, { CamCarIdx: 9 });
        surface.onTick(ctx.id, tickOf());
        await settle();
        expect(ctx.setDialCanvas.mock.calls.length).toBe(pushes + 1);
      });
    });

    describe("the seam", () => {
      it("a rejected rotate promise is logged and the dial redrawn", async () => {
        const { surface, ctx, d } = await dialIn("incident", pausedOn(54_000));
        const rotate = vi.spyOn(DIAL_MODES.incident, "rotate").mockReturnValue(Promise.reject(new Error("boom")));
        const pushes = ctx.setDialCanvas.mock.calls.length;

        queue.pending = { target: "incident", count: 2, origin: ctx.id };
        surface.rotate(ctx as never, d, 1, false);
        await settle();

        expect(logger.error).toHaveBeenCalledWith("Replay control dial turn failed: boom");
        expect(ctx.setDialCanvas.mock.calls.length).toBeGreaterThan(pushes);
        expect(shownCaption(lastBox(ctx))).toBe("+2");
        rotate.mockRestore();
      });

      it("a detent after the replay state's grace, while a jump holds the cursor, is still taken; after the surface's hold it is not", async () => {
        const { surface, ctx, d } = await dialIn("incident", pausedOn(54_000));
        const claim = claimReplayCursor("dial-lap");

        env.inReplay = false;
        surface.rotate(ctx as never, d, 1, false);
        expect(queue.turns).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(REPLAY_TARGET_GIVE_UP_MS + 100);
        surface.rotate(ctx as never, d, 1, false);
        expect(queue.turns).toHaveLength(1);
        claim.release();
      });
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

    it("name the Mode default by what it runs in the dial's mode (#801)", () => {
      expect(buildTriggerDescription(dial({ mode: "track-order" }))).toEqual({
        rotate: "Cycle Cars by Track Order",
        push: "Play/Pause (hold: Jump to My Car)",
      });
      expect(buildTriggerDescription(dial({ mode: "lap", tapAction: "mode-default" }))).toEqual({
        rotate: "Next / previous lap",
        push: "Play/Pause (hold: Set 1x and play)",
        touch: "Set 1x and play",
      });
      expect(
        buildTriggerDescription(dial({ mode: "track-order", pressAction: "jump-to-my-car", longPressAction: "none" })),
      ).toEqual({ rotate: "Cycle Cars by Track Order", push: "Jump to My Car" });
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

describe("resolveDialGesture", () => {
  it.each(REPLAY_DIAL_MODES)("resolves the Mode default in %s", (mode) => {
    expect(resolveDialGesture("mode-default", mode)).toBe(mode === "track-order" ? "jump-to-my-car" : "set-1x-play");
  });

  it("passes a specific pick through in every mode, and None as nothing", () => {
    for (const mode of REPLAY_DIAL_MODES) {
      expect(resolveDialGesture("jump-to-my-car", mode)).toBe("jump-to-my-car");
      expect(resolveDialGesture("set-1x-play", mode)).toBe("set-1x-play");
      expect(resolveDialGesture("play-pause", mode)).toBe("play-pause");
      expect(resolveDialGesture("none", mode)).toBeNull();
    }
  });
});

describe("ReplayControlDialSurface — the busy look (#1437)", () => {
  /** Sets `token`'s look and redraws its surface, as the indicator does. */
  function showLook(look: ReplayBusyLook, token = "dial-1"): void {
    busy.looks.set(token, look);
    busy.surfaces.get(token)?.redraw(look);
  }

  /** The caption mark the box draws: its kind, and the lit dot of a working one. */
  function shownMark(svg: string): string {
    const mark = /<g data-caption-mark="([\w-]+)">(.*?)<\/g>/.exec(svg);

    if (!mark) return "none";

    if (mark[1] !== "working") return mark[1];

    const lit = [...mark[2].matchAll(/<circle [^>]*\/>/g)].findIndex((dot) => !dot[0].includes("opacity"));

    return `working ${lit}`;
  }

  /** The first `<text>` of the box: the label, which the mark never moves. */
  function labelText(svg: string): string | undefined {
    return /<text[^>]*>[^<]*<\/text>/.exec(svg)?.[0];
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetEngine({ readTelemetry: () => env.telemetry, inReplay: () => env.inReplay });
    env.inReplay = true;
    env.telemetry = replayAt(speed(1));
    mocks.thresholdMs.value = 500;
    mocks.setPlaySpeed.mockReturnValue(true);
    mocks.pause.mockReturnValue(true);
    busy.looks.clear();
    busy.surfaces.clear();
    busy.unregistered.length = 0;
    busy.real = false;
    busy.actual?._resetReplayBusyIndicator();
  });

  afterEach(() => {
    busy.actual?._resetReplayBusyIndicator();
    busy.real = false;
    host.jumpToLive.mockImplementation(() => undefined);
    host.jumpToRaceStart.mockImplementation(() => undefined);
    vi.useRealTimers();
  });

  describe("registration", () => {
    it("keeps a not done the box is showing across a settings change that re-registers it", async () => {
      busy.real = true;
      const { surface, ctx } = await onScreen(speed(1));

      busy.actual!.reportReplayPressIgnored("dial-1");
      await settle();

      expect(shownMark(lastBox(ctx))).toBe("not-done");

      await surface.didReceiveSettings(ctx as never, dial({ pressAction: "jump-to-live" }));

      expect(registerReplayBusySurface).toHaveBeenCalledTimes(2);
      expect(busy.actual!.getReplayBusyLook("dial-1")).toEqual({ kind: "not-done" });
      await settle();
      expect(shownMark(lastBox(ctx))).toBe("not-done");

      // Its second runs out as it would have without the change.
      await settle(1_000);
      expect(shownMark(lastBox(ctx))).toBe("none");
    });

    it("registers the dial under its context id on appear, and unregisters it on disappear", async () => {
      const { surface, ctx } = await onScreen(speed(1));

      expect(registerReplayBusySurface).toHaveBeenCalledTimes(1);
      expect(busy.surfaces.get("dial-1")).toMatchObject({ token: "dial-1", drawsWorking: false });

      surface.willDisappear(ctx.id);

      expect(busy.unregistered).toEqual(["dial-1"]);
      expect(busy.surfaces.has("dial-1")).toBe(false);
    });

    it("on appear draws working as the push slot does: true when it jumps or searches", async () => {
      for (const gesture of ["jump-to-live", "jump-to-race-start"]) {
        busy.surfaces.clear();
        await onScreen(speed(1), dial({ pressAction: gesture }));

        expect(busy.surfaces.get("dial-1")?.drawsWorking).toBe(true);
      }
    });

    it.each(["longPressAction", "tapAction", "longTouchAction"])(
      "on appear draws no working for a jump on %s alone: that gesture decides when it fires",
      async (slot) => {
        await onScreen(speed(1), dial({ [slot]: "jump-to-live" }));

        expect(busy.surfaces.get("dial-1")?.drawsWorking).toBe(false);
      },
    );

    it("draws no working when every slot is a speed gesture or none", async () => {
      await onScreen(speed(1), dial({ pressAction: "reverse", longPressAction: "none", tapAction: "set-1x-play" }));

      expect(busy.surfaces.get("dial-1")?.drawsWorking).toBe(false);
    });

    it("re-registers when a settings change makes the push slot a jump, and only then", async () => {
      const { surface, ctx } = await onScreen(speed(1));

      // The rotation mode, and a jump on another slot, change nothing until a gesture fires.
      await surface.didReceiveSettings(ctx as never, dial({ mode: "frame-jog" }));
      await surface.didReceiveSettings(ctx as never, dial({ longPressAction: "jump-to-live" }));

      expect(registerReplayBusySurface).toHaveBeenCalledTimes(1);

      await surface.didReceiveSettings(ctx as never, dial({ pressAction: "jump-to-live" }));

      expect(registerReplayBusySurface).toHaveBeenCalledTimes(2);
      expect(busy.unregistered).toEqual(["dial-1"]);
      expect(busy.surfaces.get("dial-1")?.drawsWorking).toBe(true);

      await surface.didReceiveSettings(ctx as never, dial());

      expect(busy.surfaces.get("dial-1")?.drawsWorking).toBe(false);
    });

    it("a gesture re-registers the dial with its own kind before its press reaches the gate", async () => {
      // Push is a speed gesture, hold a jump: the box follows whichever fired.
      const d = dial({ pressAction: "play-pause", longPressAction: "jump-to-live" });
      const { surface, ctx } = await onScreen(speed(1), d);
      const seen: string[] = [];

      host.jumpToLive.mockImplementation(() => {
        seen.push(`jump-to-live drawsWorking=${busy.surfaces.get("dial-1")?.drawsWorking}`);
      });
      mocks.pause.mockImplementation(() => {
        seen.push(`pause drawsWorking=${busy.surfaces.get("dial-1")?.drawsWorking}`);

        return true;
      });

      await press(surface, ctx, d, 600);
      await settle(DIAL_SPEED_HOLD_MS);
      await press(surface, ctx, d);

      expect(seen).toEqual(["jump-to-live drawsWorking=true", "pause drawsWorking=false"]);
    });

    it("the gesture's kind outlasts a settings change", async () => {
      const d = dial({ pressAction: "play-pause", longPressAction: "jump-to-live" });
      const { surface, ctx } = await onScreen(speed(1), d);

      await press(surface, ctx, d, 600);

      expect(busy.surfaces.get("dial-1")?.drawsWorking).toBe(true);

      await surface.didReceiveSettings(ctx as never, dial({ pressAction: "reverse", longPressAction: "jump-to-live" }));

      expect(busy.surfaces.get("dial-1")?.drawsWorking).toBe(true);
    });

    it("a speed gesture whose takeover jump is under way on its token draws rest, and still waiting and not done", async () => {
      busy.real = true;
      // A jump on the hold, so the dial has drawn working before the speed gesture fires.
      const d = dial({ pressAction: "play-pause", longPressAction: "jump-to-live" });
      const { surface, ctx } = await onScreen(speed(1), d);

      await press(surface, ctx, d, 600);

      expect(busy.surfaces.get("dial-1")?.drawsWorking).toBe(true);

      // A key's search goes out on the playing replay.
      expect(
        pressReplayCommand({ kind: "search", search: "nextSession" }, { by: "next-session", origin: "key-1" }),
      ).toEqual({
        kind: "sent",
        ok: true,
      });

      // Play/Pause behind it waits.
      await press(surface, ctx, d);
      await settle();

      expect(getReplayGateView("dial-1").waiting).not.toBeNull();
      expect(shownMark(lastBox(ctx))).toBe("waiting");

      // Pressed again, it takes over: the pause and a short jump beside the reading, under the dial's token.
      await press(surface, ctx, d);
      await settle();

      expect(getReplayGateView("dial-1")).toMatchObject({ underWay: expect.anything(), waiting: null });
      expect(busy.actual!.getReplayBusyLook("dial-1")).toEqual({ kind: "rest" });
      expect(shownMark(lastBox(ctx))).toBe("none");

      // The replay never moves, so the takeover's jump is given up: not done.
      const marks = new Set<string>();

      for (let i = 0; i < 120 && getReplayGateView("dial-1").underWay !== null; i++) {
        await settle(500);
        marks.add(shownMark(lastBox(ctx)));
      }

      expect(getReplayGateView("dial-1").underWay).toBeNull();
      expect(marks).toContain("not-done");
      expect(marks).not.toContain("working 0");
    });

    it("draws working for a turn only in the modes whose turn jumps or searches under the dial's token", () => {
      expect(TURN_DRAWS_WORKING).toEqual({
        speed: false,
        "frame-jog": false,
        lap: true,
        session: true,
        incident: true,
        "track-order": false,
      });
    });

    it.each(["lap", "session", "incident"])("on appear in %s draws working, as its turn would", async (mode) => {
      await onScreen(PAUSED, dial({ mode, pressAction: "play-pause" }));

      expect(busy.surfaces.get("dial-1")?.drawsWorking).toBe(true);
    });

    it.each(["speed", "frame-jog", "track-order"])(
      "on appear in %s draws working only as its push slot does",
      async (mode) => {
        await onScreen(PAUSED, dial({ mode, pressAction: "play-pause" }));

        expect(busy.surfaces.get("dial-1")?.drawsWorking).toBe(false);
      },
    );

    it.each(["lap", "session", "incident"])(
      "in %s, a turn re-registers the dial as drawing working before it goes out, the new entry first",
      async (mode) => {
        const d = dial({ mode, pressAction: "play-pause" });
        const { surface, ctx } = await onScreen(PAUSED, d);

        // A speed gesture first, so the dial is registered drawing no working.
        await press(surface, ctx, d);
        await settle(DIAL_SPEED_HOLD_MS);

        expect(busy.surfaces.get("dial-1")?.drawsWorking).toBe(false);

        const unregisteredBefore = busy.unregistered.length;
        const seen: boolean[] = [];

        queue.onTurn = () => seen.push(busy.surfaces.get("dial-1")?.drawsWorking === true);
        surface.rotate(ctx as never, d, 1, false);

        expect(queue.turns.at(-1)).toMatchObject({ target: mode, ticks: 1, origin: "dial-1" });
        expect(seen).toEqual([true]);
        // Registered anew, then the old entry let go: the mock drops the token only when its own entry goes.
        expect(busy.unregistered.length).toBe(unregisteredBefore + 1);
        expect(busy.surfaces.get("dial-1")?.drawsWorking).toBe(true);

        // A second turn changes nothing; a press of the speed gesture goes back.
        surface.rotate(ctx as never, d, 1, false);
        expect(registerReplayBusySurface).toHaveBeenCalledTimes(3);
        await press(surface, ctx, d);
        expect(busy.surfaces.get("dial-1")?.drawsWorking).toBe(false);
      },
    );

    it.each(["speed", "frame-jog", "track-order"])("in %s, a turn leaves the registration as it is", async (mode) => {
      const d = dial({ mode, pressAction: "play-pause" });
      const { surface, ctx } = await onScreen(PAUSED, d);

      surface.rotate(ctx as never, d, 1, false);
      surface.rotate(ctx as never, d, -1, false);
      await settle();

      expect(registerReplayBusySurface).toHaveBeenCalledTimes(1);
      expect(busy.surfaces.get("dial-1")?.drawsWorking).toBe(false);
    });

    it("draws working for the run a stepping turn started, through the real indicator", async () => {
      busy.real = true;
      const d = dial({ mode: "session", pressAction: "play-pause" });
      const { surface, ctx } = await onScreen(speed(1), d);

      await press(surface, ctx, d);
      await settle(DIAL_SPEED_HOLD_MS);
      expect(busy.surfaces.get("dial-1")?.drawsWorking).toBe(false);

      // The replay plays again, so the search below runs as on a playing replay.
      nowPlaying(speed(1));
      surface.rotate(ctx as never, d, 1, false);
      // The runner's search goes out under the token the turn handed it (the runner is a double here).
      expect(
        pressReplayCommand(
          { kind: "search", search: "nextSession" },
          { by: "replay-control-dial session", origin: "dial-1" },
        ),
      ).toEqual({ kind: "sent", ok: true });
      await settle();

      expect(busy.actual!.getReplayBusyLook("dial-1")).toMatchObject({ kind: "working" });
      expect(shownMark(lastBox(ctx))).toMatch(/^working \d$/);
    });

    it.each([
      ["Reverse on a paused replay", "reverse"],
      ["Jump to My Car", "jump-to-my-car"],
    ])(
      "a gesture that sends nothing (%s) leaves the dial's own search drawn working, through the real indicator",
      async (_name, gesture) => {
        busy.real = true;
        const d = dial({ mode: "lap", pressAction: gesture });
        const { surface, ctx } = await onScreen(PAUSED, d);

        // The turn's paced search goes out under the dial's token (the runner is a double here).
        surface.rotate(ctx as never, d, 1, false);
        expect(
          pressReplayCommand(
            { kind: "search", search: "nextLap" },
            { by: "replay-control-dial lap", origin: "dial-1" },
          ),
        ).toEqual({ kind: "sent", ok: true });
        await settle();

        expect(busy.actual!.getReplayBusyLook("dial-1")).toMatchObject({ kind: "working" });

        const registrations = vi.mocked(registerReplayBusySurface).mock.calls.length;
        mocks.setPlaySpeed.mockClear();
        mocks.pause.mockClear();

        await press(surface, ctx, d);
        await settle();

        // Nothing went to the gate, so the registration and the look stand.
        expect(mocks.setPlaySpeed).not.toHaveBeenCalled();
        expect(mocks.pause).not.toHaveBeenCalled();
        expect(registerReplayBusySurface).toHaveBeenCalledTimes(registrations);
        expect(busy.surfaces.get("dial-1")?.drawsWorking).toBe(true);
        expect(busy.actual!.getReplayBusyLook("dial-1")).toMatchObject({ kind: "working" });
        expect(shownMark(lastBox(ctx))).toMatch(/^working \d$/);
      },
    );

    it.each(["jump-to-live", "jump-to-race-start"])(
      "%s re-registers the dial as drawing working before its press, from a speed gesture's registration",
      async (gesture) => {
        const d = dial({ pressAction: "play-pause", longPressAction: gesture });
        const { surface, ctx } = await onScreen(speed(1), d);
        const seen: boolean[] = [];
        const record = (): undefined => {
          seen.push(busy.surfaces.get("dial-1")?.drawsWorking === true);

          return undefined;
        };

        await press(surface, ctx, d);
        await settle(DIAL_SPEED_HOLD_MS);
        expect(busy.surfaces.get("dial-1")?.drawsWorking).toBe(false);

        host.jumpToLive.mockImplementation(record);
        host.jumpToRaceStart.mockImplementation(record);
        await press(surface, ctx, d, 600);

        expect(seen).toEqual([true]);
      },
    );

    it("hands Jump to Live and Jump to Race Start the dial's token", async () => {
      const { surface, ctx } = await onScreen(speed(1));

      await press(surface, ctx, dial({ pressAction: "jump-to-live" }));
      await press(surface, ctx, dial({ pressAction: "jump-to-race-start" }));

      expect(host.jumpToLive).toHaveBeenCalledWith("dial-1");
      expect(host.jumpToRaceStart).toHaveBeenCalledWith("dial-1");
    });
  });

  describe("the box", () => {
    it("draws the look at the left of the caption line, and nothing at rest", async () => {
      const { ctx } = await onScreen(speed(1), dial({ pressAction: "jump-to-live" }));

      expect(shownMark(lastBox(ctx))).toBe("none");

      for (const [look, mark] of [
        [{ kind: "working", tick: 0 }, "working 0"],
        [{ kind: "waiting" }, "waiting"],
        [{ kind: "not-done" }, "not-done"],
        [{ kind: "rest" }, "none"],
      ] as const) {
        showLook(look);
        await settle();

        expect(shownMark(lastBox(ctx))).toBe(mark);
      }
    });

    it("draws today's box at rest", async () => {
      const plain = await onScreen(speed(1));
      const registered = await onScreen(speed(1), dial(), dialContext("dial-2"));

      showLook({ kind: "rest" }, "dial-2");
      await settle();

      expect(lastBox(registered.ctx)).toBe(lastBox(plain.ctx));
      expect(lastBox(registered.ctx)).not.toContain("data-caption-mark");
    });

    it("steps the mark on every second tick: positions 0, 0, 1, 1, 2, 2, 0", async () => {
      const { ctx } = await onScreen(speed(1), dial({ pressAction: "jump-to-live" }));
      const shown: string[] = [];

      for (let tick = 0; tick < 7; tick++) {
        showLook({ kind: "working", tick });
        await settle(125);
        shown.push(shownMark(lastBox(ctx)));
      }

      expect(shown).toEqual([
        "working 0",
        "working 0",
        "working 1",
        "working 1",
        "working 2",
        "working 2",
        "working 0",
      ]);
    });

    it("pushes only when the mark moves: four frames a second at the indicator's eight ticks", async () => {
      const { ctx } = await onScreen(speed(1), dial({ pressAction: "jump-to-live" }));
      ctx.setDialCanvas.mockClear();

      for (let tick = 0; tick < 16; tick++) {
        showLook({ kind: "working", tick });
        await settle(125);
      }

      expect(ctx.setDialCanvas).toHaveBeenCalledTimes(8);
    });

    it("keeps pushes under the throttle however fast the look changes", async () => {
      const { ctx } = await onScreen(speed(1), dial({ pressAction: "jump-to-live" }));
      const pushedAt: number[] = [];
      ctx.setDialCanvas.mockClear();
      ctx.setDialCanvas.mockImplementation(() => {
        pushedAt.push(Date.now());

        return Promise.resolve();
      });

      // A redraw every 20 ms, each moving the mark: fifty in a second.
      for (let i = 0; i < 50; i++) {
        showLook({ kind: "working", tick: i * 2 });
        await settle(20);
      }

      await settle(200);

      expect(pushedAt.length).toBeGreaterThan(5);
      expect(pushedAt.length).toBeLessThanOrEqual(11);
      pushedAt.slice(1).forEach((at, i) => expect(at - pushedAt[i]).toBeGreaterThanOrEqual(100));
    });

    it("replaces the play-state caption with the mark, leaving the label and the value where they were", async () => {
      for (const canvas of [STRIP, KNOB]) {
        busy.surfaces.clear();
        busy.looks.clear();
        const { surface, ctx } = await onScreen(speed(1), dial({ mode: "frame-jog" }), dialContext("dial-1", canvas));
        const before = lastBox(ctx);

        expect(shownCaption(before)).not.toBe("");

        showLook({ kind: "waiting" });
        await settle();

        const after = lastBox(ctx);

        expect(shownCaption(after)).toBe("");
        expect(shownMark(after)).toBe("waiting");
        expect(shownValue(after)).toBe(shownValue(before));
        // Every text but the caption — the label, and the value when there is one — is drawn as before.
        expect(after.match(/<text(?! data-caption)[^>]*>[^<]*<\/text>/g)).toEqual(
          before.match(/<text(?! data-caption)[^>]*>[^<]*<\/text>/g),
        );
        expect(labelText(after)).toBe(labelText(before));
        surface.willDisappear(ctx.id);
      }
    });

    it("lets only the play state give way to the mark: every stepping mode's caption stays beside it", () => {
      expect(CAPTION_GIVES_WAY_TO_MARK).toEqual({
        speed: true,
        "frame-jog": true,
        lap: false,
        session: false,
        incident: false,
        "track-order": false,
      });
    });

    describe.each([STRIP, KNOB])("#801's pending count and the mark on $id", (canvas) => {
      /** Every text but the caption's: the label and the value, which neither the count nor the mark moves. */
      const aboveCaption = (svg: string) => svg.match(/<text(?! data-caption)[^>]*>[^<]*<\/text>/g);

      beforeEach(() => {
        queue.pending = null;
      });

      afterEach(() => {
        queue.pending = null;
      });

      async function setCount(count: number | null): Promise<void> {
        queue.pending = count === null ? null : { target: "incident", count, origin: "dial-1" };

        for (const listener of queue.listeners) listener();

        await settle();
      }

      it("draws the count alone, the count with the mark beside it, and the mark alone", async () => {
        const { ctx } = await onScreen(PAUSED, dial({ mode: "incident" }), dialContext("dial-1", canvas));
        const idle = lastBox(ctx);

        expect(shownCaption(idle)).toBe("");
        expect(shownMark(idle)).toBe("none");

        await setCount(3);
        const countAlone = lastBox(ctx);

        expect(shownCaption(countAlone)).toBe("+3");
        expect(shownMark(countAlone)).toBe("none");

        showLook({ kind: "working", tick: 2 });
        await settle();
        const both = lastBox(ctx);

        expect(shownCaption(both)).toBe("+3");
        expect(shownMark(both)).toBe("working 1");

        // The count's left edge (the renderer's 0.6 em estimate) is clear of the mark's right edge.
        const textX = Number(/<text data-caption="true" x="([\d.]+)"/.exec(both)![1]);
        const fontSize = Number(/<text data-caption="true"[^>]*font-size="(\d+)"/.exec(both)![1]);
        const markRight = Math.max(
          ...[...both.matchAll(/<circle cx="([\d.]+)"[^>]*r="([\d.]+)"/g)].map((m) => Number(m[1]) + Number(m[2])),
        );

        expect(textX - ("+3".length * 0.6 * fontSize) / 2).toBeGreaterThan(markRight);

        await setCount(null);
        const markAlone = lastBox(ctx);

        expect(shownCaption(markAlone)).toBe("");
        expect(shownMark(markAlone)).toBe("working 1");

        // The value has one size and place throughout: the line is kept whether or not the count shows.
        for (const svg of [countAlone, both, markAlone]) expect(aboveCaption(svg)).toEqual(aboveCaption(idle));
      });

      it("keeps a waiting or not-done mark beside the count too", async () => {
        const { ctx } = await onScreen(PAUSED, dial({ mode: "incident" }), dialContext("dial-1", canvas));

        await setCount(-2);

        for (const [look, mark] of [
          [{ kind: "waiting" }, "waiting"],
          [{ kind: "not-done" }, "not-done"],
        ] as const) {
          showLook(look);
          await settle();

          expect(shownCaption(lastBox(ctx))).toBe("-2");
          expect(shownMark(lastBox(ctx))).toBe(mark);
        }
      });
    });

    it("draws nothing for a redraw after the dial has gone", async () => {
      const { surface, ctx } = await onScreen(speed(1), dial({ pressAction: "jump-to-live" }));
      const redraw = busy.surfaces.get("dial-1")!.redraw;

      surface.willDisappear(ctx.id);
      ctx.setDialCanvas.mockClear();
      busy.looks.set("dial-1", { kind: "working", tick: 0 });
      redraw({ kind: "working", tick: 0 });
      await settle();

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
    });
  });

  describe("a turn carries no token", () => {
    it.each(["speed", "frame-jog"] as const)("a %s turn never puts the dial's token in the gate", async (mode) => {
      const notices: ReplayGateNotice[] = [];
      const unsubscribe = subscribeReplayGate((notice) => notices.push(notice));
      const { surface, ctx } = await onScreen(PAUSED, dial({ mode }));
      let underWaySeen = false;

      for (let i = 0; i < 6; i++) {
        surface.rotate(ctx as never, dial({ mode }), i % 2 === 0 ? 1 : 2, false);
        underWaySeen ||= isReplayMoveUnderWay();

        expect(getReplayGateView("dial-1")).toEqual({ underWay: null, waiting: null });
        await settle(30);
      }

      unsubscribe();

      expect(notices.filter((notice) => notice.origin === "dial-1")).toEqual([]);
      // Frame Jog's steps are under way while it turns, under no token.
      expect(underWaySeen).toBe(mode === "frame-jog");
    });
  });
});
