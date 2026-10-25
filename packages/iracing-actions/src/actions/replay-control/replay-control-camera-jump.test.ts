/**
 * Replay Control's camera keys against a real replay jump sequence (#1428 /
 * #1435): the matrix in the *Testing* section of
 * `docs/superpowers/specs/2026-10-24-issue-1428-camera-keys-during-replay-jump.md`.
 * Each of Jump to My Car, Next / Previous Car and Next / Previous Car Number,
 * pressed while a Replay Markers Next jump or Jump to Fastest Lap's record
 * jump is in its pause wait or its landing wait, over the engine configured
 * on the deck mocks and `fakeReplay`: the jump lands on its frame and ends at
 * the speed the Replay jump playback setting asks for, and the key's switch
 * goes out once, after the jump has ended — after the record jump's own
 * camera switch, from the car that switch put on camera.
 *
 * The waiter itself is the engine's (`camera-switch-waiter.test.ts`); the
 * key's park-and-drop cases behind a dial jump are `replay-control.test.ts`'s.
 */
import { getAllCarNumbers, getCarNumberRawFromSessionInfo, type TelemetryData } from "@iracedeck/iracing-sdk";
import {
  beginReplayJump,
  isReplayJumpSequenceOpen,
  jumpToRecordedLapStart,
  type ReplayJumpOutcome,
  type ReplaySpeed,
  runReplayJump,
} from "@iracedeck/replay-engine";
import { type FakeReplay, fakeReplay, withSteppedReplayState } from "@iracedeck/replay-engine/testing";
import { getGlobalSettings } from "@iracedeck/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { engineOverDeck, replayControlScopeOn } from "../../shared/replay-engine-deck.test-support.js";
import { jumpToMarkerFrame } from "../replay-markers/replay-markers-ops.js";
import { ReplayControl } from "./replay-control.js";

vi.mock("@iracedeck/iracing-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/iracing-sdk")>()),
  getCarNumberRawFromSessionInfo: vi.fn(),
  getAllCarNumbers: vi.fn(() => []),
}));

// The dial surface has its own suite; here the action only needs one to construct.
vi.mock("./replay-control-dial-surface.js", () => ({
  ReplayControlDialSurface: class MockReplayControlDialSurface {
    willAppear = vi.fn(async () => {});
    willDisappear = vi.fn();
    didReceiveSettings = vi.fn(async () => {});
    rotate = vi.fn();
    down = vi.fn();
    up = vi.fn(async () => {});
    touchTap = vi.fn();
    onTick = vi.fn();
  },
}));

vi.mock("@iracedeck/deck-iracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/deck-iracing")>()),
  getCommands: vi.fn(),
}));

vi.mock("../../shared/replay-busy-indicator.js", () => ({
  registerReplayBusySurface: vi.fn(() => () => {}),
  getReplayBusyLook: vi.fn(() => ({ kind: "rest" })),
  reportReplayPressIgnored: vi.fn(),
  setReplayBusyIndicatorLogger: vi.fn(),
}));

vi.mock("@iracedeck/deck-core", () => ({
  BUSY_MARK_FRAMES: 8,
  busyMarkSvg: vi.fn(() => "<busy-mark/>"),
  CommonSettings: {
    extend: (_fields: unknown) => ({
      parse: (data: Record<string, unknown>) => ({ ...data }),
      safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
    }),
  },
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      // The replay command gate's own scope (#1430): its lines stay out of the action's.
      createScope: vi.fn(() => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    };
    sdkController = withSteppedReplayState({
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      getCurrentTelemetry: vi.fn((): TelemetryData | null => null),
      getSessionInfo: vi.fn((): unknown => null),
    });
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
    updateKeyImage = vi.fn();
    setActiveBinding = vi.fn();
    isBindingMissing = vi.fn(() => false);
    tapBinding = vi.fn().mockResolvedValue(true);
    async onWillAppear() {}
    async onDidReceiveSettings() {}
    async onWillDisappear() {}
  },
  applyGraphicTransform: vi.fn((content: string) => content),
  assembleIcon: vi.fn(() => "data:image/svg+xml,"),
  computeGraphicArea: vi.fn(() => ({ x: 8, y: 8, width: 128, height: 128 })),
  extractGraphicContent: vi.fn((svg: string) => svg),
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  generateTitleText: vi.fn(() => ""),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  getGlobalTitleSettings: vi.fn(() => ({})),
  ICON_BASE_TEMPLATE: "<svg>{{graphicContent}}{{titleContent}}</svg>",
  LogLevel: { Info: 2 },
  parseSvgViewBox: vi.fn(() => undefined),
  renderIconTemplate: vi.fn((template: string) => template),
  resolveBorderSettings: vi.fn(() => ({ enabled: false, borderWidth: 7, borderColor: "#00aaff" })),
  resolveGraphicSettings: vi.fn(() => ({ scale: 1 })),
  resolveIconColors: vi.fn(() => ({})),
  resolveTitleSettings: vi.fn((_svg: unknown, _global: unknown, _overrides: unknown, defaultTitle?: string) => ({
    showTitle: true,
    showGraphics: true,
    titleText: defaultTitle ?? "",
  })),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${svg}`),
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

// The engine reads the two replay settings through its env (#1467); read them from the settings mock the cases set.
const engineSetting = (key: string): unknown =>
  (vi.mocked(getGlobalSettings)() as Record<string, unknown> | undefined)?.[key];

const { configureEngine, resetEngine } = engineOverDeck({
  settings: {
    replayJumpPlayback: () => engineSetting("replayJumpPlayback"),
    fastestLapSearchDelayMs: () => engineSetting("fastestLapSearchDelayMs"),
  },
});

configureEngine();

type KeyEvent = Parameters<ReplayControl["onKeyDown"]>[0];
type KeyUpEvent = Parameters<ReplayControl["onKeyUp"]>[0];
type AppearEvent = Parameters<ReplayControl["onWillAppear"]>[0];
type Playback = "remember" | "play" | "stopped";
type CameraMode = "jump-to-my-car" | "next-car" | "prev-car" | "next-car-number" | "prev-car-number";

/** Where the replay is when a jump is pressed. */
const START = 100_000;
/** Where every jump here lands: the marker's frame, and one second before the recorded lap start. */
const TARGET = 300_000;
/** The recorded lap start: the record jump goes one second (60 frames) before it. */
const LAP_START = TARGET + 60;
/** The car whose fastest lap the record holds. */
const LAP_CAR = 4;
/** The player's car. */
const MY_CAR = 9;
/** The car on camera when the key is pressed. */
const CAMERA_AT_PRESS = 6;
/** How long a pause or a speed takes to show in the fake: long enough to press a key inside the jump's pause wait. */
const SPEED_LAG_MS = 300;

/**
 * The field, by car number: each car's number is its carIdx (the mocked
 * session info's raw number), so a `switchNum` puts that carIdx on camera.
 */
const FIELD = [2, 4, 6, MY_CAR];
const NEXT_BY_NUMBER: Record<number, number> = { 2: 4, 4: 6, 6: 9, 9: 2 };
const PREVIOUS_BY_NUMBER: Record<number, number> = { 2: 9, 4: 2, 6: 4, 9: 6 };

/** What the key sends once its switch goes out, with `cameraCar` on camera then. */
function keySend(mode: CameraMode, cameraCar: number): string {
  switch (mode) {
    case "jump-to-my-car":
      return `switchNum ${MY_CAR}`;
    case "next-car":
      return "tap replayControlNextCar";
    case "prev-car":
      return "tap replayControlPrevCar";
    case "next-car-number":
      return `switchNum ${NEXT_BY_NUMBER[cameraCar]}`;
    case "prev-car-number":
      return `switchNum ${PREVIOUS_BY_NUMBER[cameraCar]}`;
  }
}

const CAMERA_MODES: CameraMode[] = ["jump-to-my-car", "next-car", "prev-car", "next-car-number", "prev-car-number"];

/** The replay's speed at the press: playing at 1x, at 4x, in slow motion (1/4x), and paused. */
const SPEEDS: [string, ReplaySpeed][] = [
  ["playing at 1x", { speed: 1, slowMotion: false }],
  ["playing at 4x", { speed: 4, slowMotion: false }],
  ["playing in slow motion", { speed: 4, slowMotion: true }],
  ["paused", { speed: 0, slowMotion: false }],
];

const PAUSED: ReplaySpeed = { speed: 0, slowMotion: false };

/** The speed a jump leaves the replay at under each Replay jump playback setting (#1276). */
function playbackSpeed(playback: Playback, captured: ReplaySpeed): ReplaySpeed {
  if (playback === "play") return { speed: 1, slowMotion: false };

  if (playback === "stopped") return PAUSED;

  return captured;
}

/**
 * One row of the matrix: the replay's speed at the press, the jump's wait the
 * key is pressed in, and the playback setting. A paused replay has no pause
 * wait: its seek goes out at the press, so it is pressed in the landing wait only.
 */
interface MatrixRow {
  readonly speedName: string;
  readonly speed: ReplaySpeed;
  readonly phase: "pause wait" | "landing wait";
  readonly playback: Playback;
}

const ROWS: MatrixRow[] = SPEEDS.flatMap(([speedName, speed]) =>
  (speed.speed === 0 ? (["landing wait"] as const) : (["pause wait", "landing wait"] as const)).flatMap((phase) =>
    (["remember", "play", "stopped"] as const).map((playback) => ({ speedName, speed, phase, playback })),
  ),
);

/** Something the test saw go out, with the replay's state at that moment. */
interface Seen {
  readonly what: string;
  /** Whether the fake shows a seek or a search under way. */
  readonly busy: boolean;
  /** Whether a jump sequence with a frame still holds the cursor (`isReplayJumpSequenceOpen`). */
  readonly open: boolean;
  readonly frame: number;
}

describe("Replay Control's camera keys against a real replay jump (#1428 / #1435)", () => {
  let action: ReplayControl;
  let sim: FakeReplay;
  let camCarIdx = CAMERA_AT_PRESS;
  let seen: Seen[] = [];
  const camera = { switchNum: vi.fn<(carNum: number, group: number, cam: number) => boolean>(() => true) };

  function note(what: string): void {
    seen.push({ what, busy: sim.busy(), open: isReplayJumpSequenceOpen(), frame: sim.frame() });
  }

  /** The fake's telemetry, with the camera's car. */
  function read(): TelemetryData {
    return { ...sim.telemetry(), CamCarIdx: camCarIdx } as TelemetryData;
  }

  function fakeEvent(actionId: string, mode: CameraMode) {
    return {
      action: { id: actionId, isDial: () => false, setTitle: vi.fn(), setImage: vi.fn() },
      payload: { settings: { mode } },
    };
  }

  /** A tap of a camera key: it appears, goes down and comes straight up. */
  async function pressKey(mode: CameraMode): Promise<void> {
    const event = fakeEvent(`ctx-${mode}`, mode);

    await action.onWillAppear(event as unknown as AppearEvent);
    await action.onKeyDown(event as unknown as KeyEvent);
    await action.onKeyUp(event as unknown as KeyUpEvent);
  }

  /** A fresh replay at `speed` on {@link START}, with the engine and the action over it. */
  async function setUp(speed: ReplaySpeed, playback: Playback): Promise<void> {
    sim = fakeReplay({ frame: START, speed, speedLagMs: SPEED_LAG_MS });

    const { getCommands } = await import("@iracedeck/deck-iracing");

    vi.mocked(getCommands).mockReturnValue({ replay: sim.replay, camera } as unknown as ReturnType<typeof getCommands>);
    vi.mocked(getGlobalSettings).mockReturnValue({
      fastestLapSearchDelayMs: 400,
      replayJumpPlayback: playback,
    } as ReturnType<typeof getGlobalSettings>);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetEngine();
    seen = [];
    camCarIdx = CAMERA_AT_PRESS;
    vi.mocked(getCarNumberRawFromSessionInfo).mockImplementation((_sessionInfo: unknown, idx: number) => idx);
    vi.mocked(getAllCarNumbers).mockReturnValue(
      FIELD.map((carIdx) => ({
        carIdx,
        carNumber: String(carIdx),
        carNumberRaw: carIdx,
        userName: `driver ${carIdx}`,
      })),
    );
    camera.switchNum.mockReset();
    // A camera switch puts that car on camera: its number is its carIdx.
    camera.switchNum.mockImplementation((carNum) => {
      note(`switchNum ${carNum}`);
      camCarIdx = carNum;

      return true;
    });
    await setUp(PAUSED, "remember");

    action = new ReplayControl();
    action["sdkController"].getCurrentTelemetry = vi.fn(() => read());
    action["sdkController"].getSessionInfo = vi.fn(() => ({ DriverInfo: { DriverCarIdx: MY_CAR } }));
    vi.mocked(action["tapBinding"]).mockImplementation(async (settingKey: string) => {
      note(`tap ${settingKey}`);

      return true;
    });
    // The record jump is the engine's (#1467): it reads this action's controller and logs on its logger.
    configureEngine({
      controller: action["sdkController"],
      logger: replayControlScopeOn(action["logger"]),
      replay: () => sim.replay,
      readTelemetry: () => read(),
      inReplay: () => true,
    });
  });

  afterEach(() => {
    resetEngine();
    vi.mocked(getGlobalSettings).mockReturnValue({} as ReturnType<typeof getGlobalSettings>);
    vi.mocked(getAllCarNumbers).mockReset();
    vi.useRealTimers();
  });

  /** The commands the fake was sent, by name. */
  const commands = (): string[] => sim.calls.map((call) => call.split(" ")[0]);

  /** The jumps a key can meet: each starts at the press and notes `jump ended` once its `end()` has run. */
  interface JumpUnderTest {
    readonly name: string;
    readonly start: () => void;
    /** The camera switch the jump makes for itself after its landing, if any. */
    readonly ownSwitch: number | null;
  }

  const JUMPS: JumpUnderTest[] = [
    {
      name: "a Replay Markers Next jump",
      ownSwitch: null,
      start: () => {
        void jumpToMarkerFrame("next", TARGET, () => read(), Date.now(), "ctx-marker").then(() => note("jump ended"));
      },
    },
    {
      name: "Jump to Fastest Lap's record jump onto the lap's car",
      ownSwitch: LAP_CAR,
      start: () => {
        void jumpToRecordedLapStart("ctx-fastest", {
          carIdx: LAP_CAR,
          carNum: LAP_CAR,
          lap: 3,
          frame: LAP_START,
          timeMs: null,
        }).then(() => note("jump ended"));
      },
    },
    {
      // Always My Car: the record is the player's own lap, and the jump's switch puts the player's car on camera.
      name: "Jump to Fastest Lap's record jump onto my car (Always My Car)",
      ownSwitch: MY_CAR,
      start: () => {
        void jumpToRecordedLapStart("ctx-fastest", {
          carIdx: MY_CAR,
          carNum: MY_CAR,
          lap: 3,
          frame: LAP_START,
          timeMs: null,
        }).then(() => note("jump ended"));
      },
    },
  ];

  /** Starts `jump` and runs the clock into `phase`, checking the jump is in it. */
  async function intoPhase(jump: JumpUnderTest, row: MatrixRow): Promise<void> {
    jump.start();
    await vi.advanceTimersByTimeAsync(100);

    if (row.phase === "pause wait") {
      // The pause is sent and does not show yet: the seek is still to go out.
      expect(sim.calls).toEqual(["setPlaySpeed 0"]);
      expect(read().ReplayPlaySpeed).not.toBe(0);

      return;
    }

    await vi.advanceTimersByTimeAsync(row.speed.speed === 0 ? 0 : SPEED_LAG_MS + 100);
    // The seek is out and showing.
    expect(commands()).toContain("setPlayPosition");
    expect(sim.busy()).toBe(true);
    expect(read().IsReplayPlaying).toBe(false);
  }

  describe.each(JUMPS)("pressed during $name", (jump) => {
    describe.each(CAMERA_MODES)("%s", (mode) => {
      it.each(ROWS)("in its $phase, the replay $speedName, under $playback playback", async (row) => {
        await setUp(row.speed, row.playback);
        await intoPhase(jump, row);

        await pressKey(mode);
        await vi.advanceTimersByTimeAsync(5_000);

        const ownSwitch = jump.ownSwitch === null ? [] : [`switchNum ${jump.ownSwitch}`];
        // The car-number keys step from the car on camera when their switch goes out: the one the jump's switch put there.
        const expected = [...ownSwitch, "jump ended", keySend(mode, jump.ownSwitch ?? CAMERA_AT_PRESS)];

        expect(seen.map((entry) => entry.what)).toEqual(expected);

        const [ended, keySwitch] = seen.slice(-2);

        // The jump landed on its frame before it ended.
        expect(ended.frame).toBe(TARGET);

        // Nothing camera-shaped went out before the landing: the jump's own switch at its read-back, the key's after its end.
        for (const entry of seen) expect(entry.busy).toBe(false);

        if (jump.ownSwitch !== null) expect(seen[0].open).toBe(true);

        expect(keySwitch.open).toBe(false);
        // And the key's switch went out exactly once.
        expect(camera.switchNum).toHaveBeenCalledTimes(expected.filter((what) => what.startsWith("switchNum")).length);
        expect(action["tapBinding"]).toHaveBeenCalledTimes(mode === "next-car" || mode === "prev-car" ? 1 : 0);

        // The replay ends at the speed the setting asks for, from the speed it had at the jump's press.
        sim.frame();
        expect(sim.speed()).toEqual(playbackSpeed(row.playback, row.speed));
        expect(sim.thrown).toBe(0);
      });
    });
  });

  describe("a key pressed between the landing's read-back and the jump's end() waits for the end", () => {
    it.each(CAMERA_MODES)("%s", async (mode) => {
      await setUp({ speed: 1, slowMotion: false }, "remember");

      // A Replay Markers Next jump run by hand, so the test holds its end().
      const jump = beginReplayJump("next", read(), undefined, Date.now(), { frame: TARGET, origin: "ctx-marker" });
      let outcome: ReplayJumpOutcome | null = null;

      void runReplayJump(jump, { frame: TARGET, readTelemetry: () => read() }).then((result) => {
        outcome = result;
      });
      await vi.advanceTimersByTimeAsync(3_000);

      expect(outcome).toMatchObject({ kind: "landed" });
      expect(sim.busy()).toBe(false);
      expect(isReplayJumpSequenceOpen()).toBe(true);

      await pressKey(mode);
      // Twenty of the waiter's 50 ms reads, every one inside the window: the jump has landed and not ended.
      await vi.advanceTimersByTimeAsync(1_000);

      expect(seen).toEqual([]);

      jump.end();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(seen.map((entry) => entry.what)).toEqual([keySend(mode, CAMERA_AT_PRESS)]);
      expect(seen[0].open).toBe(false);
      expect(sim.frame()).toBeGreaterThan(TARGET);
      expect(sim.speed()).toEqual({ speed: 1, slowMotion: false });
      expect(sim.thrown).toBe(0);
    });
  });
});
