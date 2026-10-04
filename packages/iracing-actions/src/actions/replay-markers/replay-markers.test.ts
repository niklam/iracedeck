import { ReplayPosMode, type TelemetryData } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetReplayCursor, claimReplayCursor, clearReplayLanding } from "../../shared/replay-cursor.js";
import { REPLAY_EXIT_GRACE_MS } from "./replay-markers-ops.js";
import {
  buildMarker,
  CONFIRMATION_FLASH_MS,
  generateReplayMarkersSvg,
  pickMarkerToDelete,
  readSubSessionId,
  REPLAY_MARKERS_UUID,
  ReplayMarkers,
  ReplayMarkersDialSettings,
  ReplayMarkersSettings,
} from "./replay-markers.js";

type Marker = { frame: number; sessionNum: number; sessionTimeMs: number; [key: string]: unknown };

const mocks = vi.hoisted(() => ({
  isStoreInitialized: vi.fn(() => true),
  markers: {
    add: vi.fn((_marker: Marker, _scope?: unknown): boolean => true),
    deleteNearest: vi.fn((): Marker | null => null),
    next: vi.fn((): Marker | null => null),
    previous: vi.fn((): Marker | null => null),
    list: vi.fn((): Marker[] => []),
  },
  setPlayPosition: vi.fn((_mode: number, _frame: number) => true),
}));

vi.mock("@iracedeck/icons/replay-markers/add.svg", () => ({ default: "<svg>add</svg>" }));
vi.mock("@iracedeck/icons/replay-markers/delete.svg", () => ({ default: "<svg>delete</svg>" }));
vi.mock("@iracedeck/icons/replay-markers/next.svg", () => ({ default: "<svg>next</svg>" }));
vi.mock("@iracedeck/icons/replay-markers/previous.svg", () => ({ default: "<svg>previous</svg>" }));
vi.mock("@iracedeck/icons/replay-markers/confirm-added.svg", () => ({ default: "<svg>confirm-added</svg>" }));
vi.mock("@iracedeck/icons/replay-markers/confirm-deleted.svg", () => ({ default: "<svg>confirm-deleted</svg>" }));

vi.mock("@iracedeck/deck-core", async () => {
  const { z } = await import("zod");
  // The real dial-gesture module, by path (zero imports): the dial instances
  // below classify their releases through it.
  const dialGesture = await vi.importActual<typeof import("../../../../deck-core/src/dial-gesture.js")>(
    "../../../../deck-core/src/dial-gesture.js",
  );

  return {
    createHoldPreview: dialGesture.createHoldPreview,
    classifyDialRelease: dialGesture.classifyDialRelease,
    getDualPressThresholdMs: () => 500,
    applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
    escapeXml: (str: string) => str,
    svgToDataUri: (svg: string) => svg,
    // REAL zod semantics for the action's own fields (defaults, coercion, the
    // secondsBack clamp) — only the CommonSettings base fields are absent.
    CommonSettings: {
      extend: (shape: never) => z.object(shape).passthrough(),
    },
    ConnectionStateAwareAction: class MockConnectionStateAwareAction {
      logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      sdkController = {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        getConnectionStatus: vi.fn(() => true),
        getCurrentTelemetry: vi.fn((): TelemetryData | null => null),
        getSessionInfo: vi.fn((): unknown => null),
      };
      updateConnectionState = vi.fn();
      setKeyImage = vi.fn().mockResolvedValue(undefined);
      updateKeyImage = vi.fn().mockResolvedValue(true);
      setRegenerateCallback = vi.fn();
      async onWillAppear() {}
      async onDidReceiveSettings() {}
      async onWillDisappear() {}
    },
    getCommands: vi.fn(() => ({ replay: { setPlayPosition: mocks.setPlayPosition } })),
    getReplaySessionStore: vi.fn(() => ({ markers: mocks.markers })),
    isReplaySessionStoreInitialized: mocks.isStoreInitialized,
    MARKER_DEDUPE_FRAMES: 60,
    MARKER_DELETE_WINDOW_FRAMES: 600,
    MARKER_PREVIOUS_MIN_BEHIND_FRAMES: 120,
    getGlobalBorderSettings: vi.fn(() => ({})),
    getGlobalColors: vi.fn(() => ({})),
    getGlobalGraphicSettings: vi.fn(() => ({})),
    getGlobalTitleSettings: vi.fn(() => ({})),
    resolveIconColors: vi.fn((_svg: string, _global: unknown, overrides: unknown) => ({ overrides })),
    resolveBorderSettings: vi.fn(() => ({ enabled: false })),
    resolveGraphicSettings: vi.fn(() => ({ scale: 1 })),
    resolveTitleSettings: vi.fn(
      (_svg: string, _global: unknown, overrides: { titleText?: string } | undefined, defaultTitle?: string) => ({
        titleText: overrides?.titleText ?? defaultTitle ?? "",
      }),
    ),
    hexToGrayscale: vi.fn((hex: string) => `grey(${hex})`),
    IconUpdateThrottle: class {
      schedule = vi.fn((_id: string, render: () => unknown) => {
        void render();
      });
      clear = vi.fn();
    },
    assembleIcon: vi.fn(
      ({
        graphicSvg,
        title,
        colors,
        dimmed,
      }: {
        graphicSvg: string;
        title: { titleText: string };
        colors: unknown;
        dimmed?: boolean;
      }) => `icon|${graphicSvg}|${title.titleText}|${JSON.stringify(colors)}${dimmed ? "|dimmed" : ""}`,
    ),
  };
});

type Sdk = {
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  getConnectionStatus: ReturnType<typeof vi.fn>;
  getCurrentTelemetry: ReturnType<typeof vi.fn>;
  getSessionInfo: ReturnType<typeof vi.fn>;
};

const LIVE: TelemetryData = {
  IsReplayPlaying: false,
  ReplayFrameNum: 0,
  ReplayFrameNumEnd: 30_000,
  SessionNum: 2,
  SessionTime: 500,
} as TelemetryData;

const REPLAY: TelemetryData = {
  IsReplayPlaying: true,
  ReplayFrameNum: 12_000,
  ReplayFrameNumEnd: 18_000,
  ReplaySessionNum: 1,
  ReplaySessionTime: 200,
  SessionNum: 2,
  SessionTime: 900,
} as TelemetryData;

const NO_SUBSESSION = Symbol("no SubSessionID");

function makeAction(telemetry: TelemetryData | null = LIVE, subSessionId: unknown = 86697546) {
  const action = new ReplayMarkers();
  const sdk = action["sdkController"] as unknown as Sdk;
  sdk.getCurrentTelemetry.mockReturnValue(telemetry);
  sdk.getSessionInfo.mockReturnValue(
    subSessionId === NO_SUBSESSION ? {} : { WeekendInfo: { SubSessionID: subSessionId } },
  );

  return { action, sdk };
}

function keyDown(settings: Record<string, unknown>, id = "ctx-1") {
  return {
    action: { id, setTitle: vi.fn().mockResolvedValue(undefined), isKey: () => true, isDial: () => false },
    payload: { settings },
  } as never;
}

async function appear(action: ReplayMarkers, settings: Record<string, unknown>, id = "ctx-1"): Promise<void> {
  await action.onWillAppear(keyDown(settings, id));
}

describe("ReplayMarkers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isStoreInitialized.mockReturnValue(true);
    mocks.markers.add.mockReturnValue(true);
    mocks.markers.deleteNearest.mockReturnValue(null);
    mocks.markers.next.mockReturnValue(null);
    mocks.markers.previous.mockReturnValue(null);
    mocks.markers.list.mockReturnValue([]);
    mocks.setPlayPosition.mockReturnValue(true);
    _resetReplayCursor();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the core UUID scheme", () => {
    expect(REPLAY_MARKERS_UUID).toBe("com.iracedeck.sd.core.replay-markers");
  });

  describe("settings", () => {
    it("defaults to Add with 5 seconds back", () => {
      expect(ReplayMarkersSettings.parse({})).toMatchObject({ mode: "add", secondsBack: 5 });
    });

    it.each([
      ["7", 7],
      [0, 0],
      [90, 60],
      [-3, 0],
      [2.6, 3],
      ["abc", 5],
      ["", 5],
      [" ", 5],
      [null, 5],
    ])("secondsBack %j reads as %j", (input, expected) => {
      expect(ReplayMarkersSettings.parse({ secondsBack: input }).secondsBack).toBe(expected);
    });

    it("an unreadable secondsBack does not reset the mode", () => {
      expect(ReplayMarkersSettings.parse({ mode: "next", secondsBack: "x" }).mode).toBe("next");
    });

    it("a keypad instance's stored settings parse exactly as before the dial (#1230)", () => {
      const stored = { mode: "previous", secondsBack: "12", colorOverrides: { backgroundColor: "#123456" } };
      const { dial, ...keypad } = ReplayMarkersSettings.parse(stored);

      // Every stored key reads as it did, and nothing else appears beside the new `dial`.
      expect(keypad).toEqual({ mode: "previous", secondsBack: 12, colorOverrides: { backgroundColor: "#123456" } });
      expect(dial).toEqual(ReplayMarkersDialSettings.parse({}));
    });

    it("an empty dial fills every default", () => {
      expect(ReplayMarkersSettings.parse({ dial: {} }).dial).toEqual({
        secondsBack: 5,
        pressAction: "add",
        longPressAction: "delete",
        tapAction: "none",
        longTouchAction: "none",
        colors: { borderColor: "", labelColor: "", valueColor: "", backgroundColor: "" },
      });
    });

    it.each([
      ["7", 7],
      [90, 60],
      [-3, 0],
      ["abc", 5],
      ["", 5],
      [null, 5],
    ])("dial.secondsBack %j reads as %j, as the keypad's does", (input, expected) => {
      expect(ReplayMarkersSettings.parse({ dial: { secondsBack: input } }).dial.secondsBack).toBe(expected);
      expect(ReplayMarkersSettings.parse({ secondsBack: input }).secondsBack).toBe(expected);
    });

    it("an unknown gesture reads as that slot's default without resetting the others", () => {
      const { dial } = ReplayMarkersSettings.parse({
        dial: { pressAction: "warp", longPressAction: "add", tapAction: 3, secondsBack: 9 },
      });

      expect(dial).toMatchObject({ pressAction: "add", longPressAction: "add", tapAction: "none", secondsBack: 9 });
    });

    it("a non-object dial degrades to the dial defaults and keeps the keypad's mode", () => {
      const parsed = ReplayMarkersSettings.parse({ mode: "delete", dial: "garbage" });

      expect(parsed.mode).toBe("delete");
      expect(parsed.dial).toEqual(ReplayMarkersDialSettings.parse({}));
    });
  });

  describe("generateReplayMarkersSvg", () => {
    it.each([
      ["add", "<svg>add</svg>", "MARKER\nADD"],
      ["delete", "<svg>delete</svg>", "MARKER\nDELETE"],
      ["next", "<svg>next</svg>", "MARKER\nNEXT"],
      ["previous", "<svg>previous</svg>", "MARKER\nPREVIOUS"],
    ])("renders %s with its own icon and title", (mode, svg, title) => {
      const result = generateReplayMarkersSvg(ReplayMarkersSettings.parse({ mode }));

      expect(result).toContain(`|${svg}|${title}|`);
    });

    it("renders the Added and Deleted confirmations", () => {
      const settings = ReplayMarkersSettings.parse({ mode: "add" });

      expect(generateReplayMarkersSvg(settings, "added")).toContain("|<svg>confirm-added</svg>|MARKER\nADDED|");
      expect(generateReplayMarkersSvg(settings, "deleted")).toContain("|<svg>confirm-deleted</svg>|MARKER\nDELETED|");
    });

    it("the confirmation ignores the key's colour and title-text overrides", () => {
      const settings = ReplayMarkersSettings.parse({
        mode: "add",
        colorOverrides: { backgroundColor: "#123456" },
        titleOverrides: { titleText: "MINE" },
      });

      expect(generateReplayMarkersSvg(settings)).toContain("|MINE|");
      const flash = generateReplayMarkersSvg(settings, "added");
      expect(flash).toContain("|MARKER\nADDED|");
      expect(flash).not.toContain("#123456");
    });
  });

  describe("buildMarker", () => {
    it("live: seconds back from the live edge, with the live session", () => {
      expect(buildMarker(LIVE, 30_000, 5, false)).toEqual({
        frame: 29_700,
        pressFrame: 30_000,
        sessionNum: 2,
        sessionTimeMs: 495_000,
      });
    });

    it("replay: seconds back from the frame on screen, with the replay's session", () => {
      expect(buildMarker(REPLAY, 12_000, 0, true)).toEqual({
        frame: 12_000,
        pressFrame: 12_000,
        sessionNum: 1,
        sessionTimeMs: 200_000,
      });
    });

    it("in a replay's post-seek blip (IsReplayPlaying reads false): still the replay's session", () => {
      expect(buildMarker({ ...REPLAY, IsReplayPlaying: false } as TelemetryData, 12_000, 0, true)).toMatchObject({
        sessionNum: 1,
        sessionTimeMs: 200_000,
      });
    });

    it("clamps the frame and the time at 0", () => {
      expect(buildMarker({ ...LIVE, SessionTime: 2 } as TelemetryData, 100, 60, false)).toMatchObject({
        frame: 0,
        sessionTimeMs: 0,
      });
    });
  });

  describe("readSubSessionId", () => {
    it.each([
      [{ WeekendInfo: { SubSessionID: 123 } }, 123],
      [{ WeekendInfo: { SubSessionID: "456" } }, 456],
      [{ WeekendInfo: { SubSessionID: 0 } }, 0],
      [{ WeekendInfo: {} }, undefined],
      [null, undefined],
    ])("%j → %j", (info, expected) => {
      expect(readSubSessionId(info)).toBe(expected);
    });
  });

  describe("Add", () => {
    it("live: adds ReplayFrameNumEnd minus seconds back, scoped to the SubSessionID, and flashes Added", async () => {
      const { action } = makeAction(LIVE);
      await appear(action, { mode: "add" });

      await action.onKeyDown(keyDown({ mode: "add" }));

      expect(mocks.markers.add).toHaveBeenCalledWith(
        { frame: 29_700, pressFrame: 30_000, sessionNum: 2, sessionTimeMs: 495_000 },
        { subSessionId: 86697546 },
      );
      expect(action["updateKeyImage"]).toHaveBeenCalledTimes(1);
      expect(action["updateKeyImage"]).toHaveBeenCalledWith("ctx-1", expect.stringContaining("MARKER\nADDED"));
      expect(mocks.setPlayPosition).not.toHaveBeenCalled();
    });

    it("replay: measures from ReplayFrameNum", async () => {
      const { action } = makeAction(REPLAY);

      await action.onKeyDown(keyDown({ mode: "add", secondsBack: 0 }));

      expect(mocks.markers.add).toHaveBeenCalledWith(expect.objectContaining({ frame: 12_000 }), {
        subSessionId: 86697546,
      });
    });

    it("clamps at frame 0 near the start of the recording", async () => {
      const { action } = makeAction({ ...LIVE, ReplayFrameNumEnd: 120 } as TelemetryData);

      await action.onKeyDown(keyDown({ mode: "add", secondsBack: 10 }));

      expect(mocks.markers.add).toHaveBeenCalledWith(expect.objectContaining({ frame: 0 }), expect.anything());
    });

    it("a deduplicated Add shows nothing", async () => {
      mocks.markers.add.mockReturnValue(false);
      const { action } = makeAction(LIVE);
      await appear(action, { mode: "add" });

      await action.onKeyDown(keyDown({ mode: "add" }));

      expect(mocks.markers.add).toHaveBeenCalledTimes(1);
      expect(action["updateKeyImage"]).not.toHaveBeenCalled();
    });

    it("the flash reverts to the mode icon after the confirmation window", async () => {
      const { action } = makeAction(LIVE);
      await appear(action, { mode: "add" });
      await action.onKeyDown(keyDown({ mode: "add" }));

      vi.advanceTimersByTime(CONFIRMATION_FLASH_MS - 1);
      expect(action["updateKeyImage"]).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      expect(action["updateKeyImage"]).toHaveBeenCalledTimes(2);
      expect(action["updateKeyImage"]).toHaveBeenLastCalledWith("ctx-1", expect.stringContaining("MARKER\nADD|"));
    });

    it("a key that disappears mid-flash is not redrawn", async () => {
      const { action } = makeAction(LIVE);
      await appear(action, { mode: "add" });
      await action.onKeyDown(keyDown({ mode: "add" }));

      await action.onWillDisappear(keyDown({ mode: "add" }));
      vi.advanceTimersByTime(CONFIRMATION_FLASH_MS);

      expect(action["updateKeyImage"]).toHaveBeenCalledTimes(1);
    });

    it("with no SubSessionID the call is taken for the active session", async () => {
      const { action } = makeAction(LIVE, NO_SUBSESSION);

      await action.onKeyDown(keyDown({ mode: "add" }));

      expect(mocks.markers.add).toHaveBeenCalledWith(expect.anything(), undefined);
    });

    it("an offline session scopes to SubSessionID 0", async () => {
      const { action } = makeAction(LIVE, 0);

      await action.onKeyDown(keyDown({ mode: "add" }));

      expect(mocks.markers.add).toHaveBeenCalledWith(expect.anything(), { subSessionId: 0 });
    });
  });

  describe("pickMarkerToDelete", () => {
    const m = (frame: number, pressFrame?: number): Marker =>
      pressFrame === undefined
        ? { frame, sessionNum: 0, sessionTimeMs: 0 }
        : { frame, pressFrame, sessionNum: 0, sessionTimeMs: 0 };

    it("reaches a 15 s marker from the car through its press frame", () => {
      const fifteenBack = m(30_000 - 15 * 60, 30_000);

      expect(pickMarkerToDelete([fifteenBack], 30_000 + 60)).toBe(fifteenBack);
    });

    it("a marker without a press frame is measured by its frame alone", () => {
      expect(pickMarkerToDelete([m(30_000 - 15 * 60)], 30_000)).toBeNull();
      expect(pickMarkerToDelete([m(29_500)], 30_000)).toEqual(m(29_500));
    });

    it("picks the nearer of two by either distance", () => {
      const byFrame = m(20_000, 20_300);
      const byPress = m(19_000, 20_050);

      expect(pickMarkerToDelete([byPress, byFrame], 20_060)).toBe(byPress);
    });

    it("on a tie the earlier marker goes", () => {
      const early = m(10_000);
      const late = m(10_200);

      expect(pickMarkerToDelete([early, late], 10_100)).toBe(early);
    });

    it("ignores a non-numeric press frame", () => {
      expect(pickMarkerToDelete([{ ...m(0), pressFrame: "30000" }], 30_000)).toBeNull();
    });
  });

  describe("Delete", () => {
    it("deletes the marker nearest the current frame and flashes Deleted", async () => {
      const near = { frame: 11_800, sessionNum: 1, sessionTimeMs: 0 };
      mocks.markers.list.mockReturnValue([near]);
      mocks.markers.deleteNearest.mockReturnValue(near);
      const { action } = makeAction(REPLAY);

      await action.onKeyDown(keyDown({ mode: "delete" }));

      expect(mocks.markers.list).toHaveBeenCalledWith({ subSessionId: 86697546 });
      expect(mocks.markers.deleteNearest).toHaveBeenCalledWith(11_800, { subSessionId: 86697546 });
      expect(action["updateKeyImage"]).toHaveBeenCalledWith("ctx-1", expect.stringContaining("MARKER\nDELETED"));
    });

    it("from the car, deletes a marker just added with 15 seconds back", async () => {
      const { action } = makeAction(LIVE);
      await action.onKeyDown(keyDown({ mode: "add", secondsBack: 15 }));
      const added = mocks.markers.add.mock.calls[0]![0];
      expect(added).toMatchObject({ frame: 29_100, pressFrame: 30_000 });

      mocks.markers.list.mockReturnValue([added]);
      mocks.markers.deleteNearest.mockReturnValue(added);
      const later = makeAction({ ...LIVE, ReplayFrameNumEnd: 30_120 } as TelemetryData).action;
      await later.onKeyDown(keyDown({ mode: "delete" }));

      expect(mocks.markers.deleteNearest).toHaveBeenCalledWith(29_100, { subSessionId: 86697546 });
      expect(later["updateKeyImage"]).toHaveBeenCalledWith("ctx-1", expect.stringContaining("MARKER\nDELETED"));
    });

    it("nothing in reach deletes nothing and shows nothing", async () => {
      mocks.markers.list.mockReturnValue([{ frame: 1_000, sessionNum: 2, sessionTimeMs: 0 }]);
      const { action } = makeAction(LIVE);

      await action.onKeyDown(keyDown({ mode: "delete" }));

      expect(mocks.markers.deleteNearest).not.toHaveBeenCalled();
      expect(action["updateKeyImage"]).not.toHaveBeenCalled();
    });
  });

  describe("Next / Previous", () => {
    it("Next jumps to the next marker's frame from the Begin position", async () => {
      mocks.markers.next.mockReturnValue({ frame: 15_000, sessionNum: 1, sessionTimeMs: 0 });
      const { action } = makeAction(REPLAY);

      await action.onKeyDown(keyDown({ mode: "next" }));

      expect(mocks.markers.next).toHaveBeenCalledWith(12_000, { subSessionId: 86697546 });
      expect(mocks.setPlayPosition).toHaveBeenCalledWith(ReplayPosMode.Begin, 15_000);
      expect(action["updateKeyImage"]).not.toHaveBeenCalled();
    });

    it("Previous jumps to the previous marker's frame", async () => {
      mocks.markers.previous.mockReturnValue({ frame: 9_000, sessionNum: 1, sessionTimeMs: 0 });
      const { action } = makeAction(REPLAY);

      await action.onKeyDown(keyDown({ mode: "previous" }));

      expect(mocks.markers.previous).toHaveBeenCalledWith(12_000, { subSessionId: 86697546 });
      expect(mocks.setPlayPosition).toHaveBeenCalledWith(ReplayPosMode.Begin, 9_000);
    });

    it("takes the replay cursor from an in-flight fastest-lap walk before jumping", async () => {
      mocks.markers.next.mockReturnValue({ frame: 15_000, sessionNum: 1, sessionTimeMs: 0 });
      const onCancelled = vi.fn(() => {
        expect(mocks.setPlayPosition).not.toHaveBeenCalled();
      });
      const claim = claimReplayCursor("jump-to-fastest-lap", onCancelled);
      const { action } = makeAction(REPLAY);

      await action.onKeyDown(keyDown({ mode: "next" }));

      expect(onCancelled).toHaveBeenCalledWith("next");
      expect(claim.cancelledBy).toBe("next");
      expect(mocks.setPlayPosition).toHaveBeenCalledWith(ReplayPosMode.Begin, 15_000);
      _resetReplayCursor();
    });

    it("Next in the post-seek blip still jumps, from the replay's last frame", async () => {
      mocks.markers.next.mockReturnValue({ frame: 15_000, sessionNum: 1, sessionTimeMs: 0 });
      const { action, sdk } = makeAction(REPLAY);
      await action.onKeyDown(keyDown({ mode: "next" }));
      mocks.setPlayPosition.mockClear();
      mocks.markers.next.mockClear();
      clearReplayLanding(); // the landing alone: the replay state is what is under test

      sdk.getCurrentTelemetry.mockReturnValue({ ...REPLAY, IsReplayPlaying: false } as TelemetryData);
      await vi.advanceTimersByTimeAsync(300);
      await action.onKeyDown(keyDown({ mode: "next" }));

      expect(mocks.markers.next).toHaveBeenCalledWith(12_000, { subSessionId: 86697546 });
      expect(mocks.setPlayPosition).toHaveBeenCalledWith(ReplayPosMode.Begin, 15_000);
    });

    it.each(["next", "previous"])("%s from the car sends nothing and says why at debug", async (mode) => {
      mocks.markers.next.mockReturnValue({ frame: 31_000, sessionNum: 2, sessionTimeMs: 0 });
      mocks.markers.previous.mockReturnValue({ frame: 29_000, sessionNum: 2, sessionTimeMs: 0 });
      const { action } = makeAction(LIVE);

      await action.onKeyDown(keyDown({ mode }));

      expect(mocks.setPlayPosition).not.toHaveBeenCalled();
      const logger = action["logger"] as unknown as { info: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
      expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("Jumped"));
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("open the replay first"));
    });

    it.each(["next", "previous"])("%s with no marker in that direction sends nothing", async (mode) => {
      const { action } = makeAction(REPLAY);

      await action.onKeyDown(keyDown({ mode }));

      expect(mocks.setPlayPosition).not.toHaveBeenCalled();
      expect(action["updateKeyImage"]).not.toHaveBeenCalled();
    });
  });

  describe("does nothing", () => {
    it.each(["add", "delete", "next", "previous"])("%s while not connected", async (mode) => {
      const { action, sdk } = makeAction(LIVE);
      sdk.getConnectionStatus.mockReturnValue(false);

      await action.onKeyDown(keyDown({ mode }));

      expectUntouched(action);
    });

    it.each(["add", "delete", "next", "previous"])("%s with no telemetry", async (mode) => {
      const { action } = makeAction(null);

      await action.onKeyDown(keyDown({ mode }));

      expectUntouched(action);
    });

    it("when the frame field is missing", async () => {
      const { action } = makeAction({ IsReplayPlaying: false } as TelemetryData);

      await action.onKeyDown(keyDown({ mode: "add" }));

      expectUntouched(action);
    });

    it("when the replay store is not initialized", async () => {
      mocks.isStoreInitialized.mockReturnValue(false);
      const { action } = makeAction(LIVE);

      await action.onKeyDown(keyDown({ mode: "add" }));

      expectUntouched(action);
    });
  });

  describe("Next / Previous availability", () => {
    const AHEAD = { frame: 15_000, sessionNum: 1, sessionTimeMs: 0 };
    const BEHIND = { frame: 9_000, sessionNum: 1, sessionTimeMs: 0 };

    /** The store's own windows: next is > 60 frames ahead, previous > 120 behind. */
    function storeWith(markers: Marker[]): void {
      mocks.markers.next.mockImplementation(
        ((frame: number) => markers.find((m) => m.frame - frame > 60) ?? null) as never,
      );
      mocks.markers.previous.mockImplementation(
        ((frame: number) => [...markers].reverse().find((m) => frame - m.frame > 120) ?? null) as never,
      );
    }

    function tick(action: ReplayMarkers, id = "ctx-1"): void {
      const sdk = action["sdkController"] as unknown as Sdk;
      const call = sdk.subscribe.mock.calls.find(([subId]) => subId === id);
      (call![1] as () => void)();
    }

    function atFrame(sdk: Sdk, frame: number): void {
      sdk.getCurrentTelemetry.mockReturnValue({ ...REPLAY, ReplayFrameNum: frame } as TelemetryData);
    }

    const shown = (action: ReplayMarkers) => vi.mocked(action["setKeyImage"]).mock.calls.at(-1)![1] as string;
    const redrawn = (action: ReplayMarkers) => vi.mocked(action["updateKeyImage"]).mock.calls;

    it("renders the unavailable look with the key's own icon, greyed and dimmed", () => {
      const settings = ReplayMarkersSettings.parse({ mode: "next", titleOverrides: { titleText: "MINE" } });
      const result = generateReplayMarkersSvg(settings, "unavailable");

      expect(result).toContain("|<svg>next</svg>|MINE|");
      expect(result).toContain("grey(");
      expect(result).toMatch(/\|dimmed$/);
      expect(generateReplayMarkersSvg(settings)).not.toContain("dimmed");
    });

    it.each(["next", "previous"])("%s is unavailable from the car, even with a marker in reach", async (mode) => {
      storeWith([
        { frame: 1_000, sessionNum: 2, sessionTimeMs: 0 },
        { frame: 60_000, sessionNum: 2, sessionTimeMs: 0 },
      ]);
      const { action } = makeAction(LIVE);

      await appear(action, { mode });

      expect(shown(action)).toMatch(/\|dimmed$/);
    });

    it.each(["next", "previous"])("%s in a replay with a marker in that direction is available", async (mode) => {
      storeWith([BEHIND, AHEAD]);
      const { action } = makeAction(REPLAY);

      await appear(action, { mode });

      expect(shown(action)).not.toContain("dimmed");
      expect(mocks.markers[mode as "next" | "previous"]).toHaveBeenCalledWith(12_000, { subSessionId: 86697546 });
    });

    it.each([
      ["not connected", (sdk: Sdk) => sdk.getConnectionStatus.mockReturnValue(false)],
      ["no telemetry", (sdk: Sdk) => sdk.getCurrentTelemetry.mockReturnValue(null)],
      ["no store", () => mocks.isStoreInitialized.mockReturnValue(false)],
    ])("is unavailable with %s", async (_label, breakIt) => {
      storeWith([AHEAD]);
      const { action, sdk } = makeAction(REPLAY);
      breakIt(sdk);

      await appear(action, { mode: "next" });

      expect(shown(action)).toMatch(/\|dimmed$/);
    });

    it("Next flips to unavailable as the replay plays into the marker's window, and back after a rewind", async () => {
      storeWith([AHEAD]);
      const { action, sdk } = makeAction(REPLAY);
      await appear(action, { mode: "next" });
      expect(shown(action)).not.toContain("dimmed");

      atFrame(sdk, 14_900);
      tick(action);
      expect(redrawn(action)).toHaveLength(0);

      atFrame(sdk, 14_940);
      tick(action);
      expect(redrawn(action)).toHaveLength(1);
      expect(redrawn(action)[0]).toEqual(["ctx-1", expect.stringMatching(/\|dimmed$/)]);

      atFrame(sdk, 10_000);
      tick(action);
      expect(redrawn(action)).toHaveLength(2);
      expect(redrawn(action)[1]![1]).not.toContain("dimmed");
    });

    it("Next stays available through the post-seek blip, and greys only once the replay is really left", async () => {
      storeWith([AHEAD]);
      const { action, sdk } = makeAction(REPLAY);
      await appear(action, { mode: "next" });
      expect(shown(action)).not.toContain("dimmed");

      // For ~300 ms after every `setPlayPosition`, telemetry reads IsReplayPlaying false.
      sdk.getCurrentTelemetry.mockReturnValue({ ...REPLAY, IsReplayPlaying: false } as TelemetryData);
      await vi.advanceTimersByTimeAsync(300);
      tick(action);
      await vi.advanceTimersByTimeAsync(100);
      expect(redrawn(action)).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(REPLAY_EXIT_GRACE_MS);
      tick(action);
      await vi.advanceTimersByTimeAsync(100);
      expect(redrawn(action)).toHaveLength(1);
      expect(redrawn(action)[0]![1]).toMatch(/\|dimmed$/);
    });

    it("Previous flips to available once the replay is past the marker's window", async () => {
      storeWith([AHEAD]);
      const { action, sdk } = makeAction({ ...REPLAY, ReplayFrameNum: 15_100 } as TelemetryData);
      await appear(action, { mode: "previous" });
      expect(shown(action)).toMatch(/\|dimmed$/);

      atFrame(sdk, 15_121);
      tick(action);

      expect(redrawn(action)).toHaveLength(1);
      expect(redrawn(action)[0]![1]).not.toContain("dimmed");
    });

    it("does not re-render, or even schedule, while the state is unchanged", async () => {
      storeWith([AHEAD]);
      const { action, sdk } = makeAction(REPLAY);
      await appear(action, { mode: "next" });

      for (let frame = 12_000; frame < 14_000; frame += 100) {
        atFrame(sdk, frame);
        tick(action);
      }

      expect(redrawn(action)).toHaveLength(0);
      expect(vi.mocked(action["imageThrottle"].schedule)).not.toHaveBeenCalled();
    });

    it("a marker added from another key flips Next to available on the next tick", async () => {
      const markers: Marker[] = [];
      storeWith(markers);
      const { action } = makeAction(REPLAY);
      await appear(action, { mode: "next" });
      expect(shown(action)).toMatch(/\|dimmed$/);

      markers.push(AHEAD);
      tick(action);

      expect(redrawn(action)).toHaveLength(1);
      expect(redrawn(action)[0]![1]).not.toContain("dimmed");
    });

    it("the regenerate callback computes the state fresh", async () => {
      const markers: Marker[] = [];
      storeWith(markers);
      const { action } = makeAction(REPLAY);
      await appear(action, { mode: "next" });
      const regenerate = vi.mocked(action["setRegenerateCallback"]).mock.calls[0]![1] as () => string;
      expect(regenerate()).toMatch(/\|dimmed$/);

      markers.push(AHEAD);

      expect(regenerate()).not.toContain("dimmed");
    });

    it.each(["add", "delete"])("%s is never greyed and never redrawn by a tick", async (mode) => {
      storeWith([]);
      const { action, sdk } = makeAction(LIVE);
      await appear(action, { mode });
      expect(shown(action)).not.toContain("dimmed");

      sdk.getConnectionStatus.mockReturnValue(false);
      tick(action);

      expect(redrawn(action)).toHaveLength(0);
    });

    it("a tick during the Added flash does not clobber it", async () => {
      storeWith([AHEAD]);
      const { action, sdk } = makeAction(REPLAY);
      await appear(action, { mode: "add" });
      await action.onKeyDown(keyDown({ mode: "add" }));
      expect(redrawn(action)).toHaveLength(1);

      sdk.getConnectionStatus.mockReturnValue(false);
      tick(action);
      vi.advanceTimersByTime(CONFIRMATION_FLASH_MS / 2);
      tick(action);
      expect(redrawn(action)).toHaveLength(1);

      vi.advanceTimersByTime(CONFIRMATION_FLASH_MS / 2);
      expect(redrawn(action)).toHaveLength(2);
      expect(redrawn(action)[1]![1]).toContain("MARKER\nADD|");
    });

    it("a mode change to Next starts tracking; one away from Next stops it", async () => {
      storeWith([AHEAD]);
      const { action, sdk } = makeAction(REPLAY);
      await appear(action, { mode: "add" });

      await action.onDidReceiveSettings(keyDown({ mode: "next" }));
      expect(shown(action)).not.toContain("dimmed");
      sdk.getConnectionStatus.mockReturnValue(false);
      tick(action);
      expect(redrawn(action)).toHaveLength(1);

      await action.onDidReceiveSettings(keyDown({ mode: "add" }));
      sdk.getConnectionStatus.mockReturnValue(true);
      tick(action);
      expect(redrawn(action)).toHaveLength(1);
    });

    it("willDisappear unsubscribes and clears that context only", async () => {
      storeWith([AHEAD]);
      const { action, sdk } = makeAction(REPLAY);
      await appear(action, { mode: "next" }, "ctx-1");
      await appear(action, { mode: "next" }, "ctx-2");

      await action.onWillDisappear(keyDown({ mode: "next" }, "ctx-1"));

      expect(sdk.unsubscribe).toHaveBeenCalledWith("ctx-1");
      expect(sdk.unsubscribe).not.toHaveBeenCalledWith("ctx-2");
      expect(vi.mocked(action["imageThrottle"].clear)).toHaveBeenCalledWith("ctx-1");

      sdk.getConnectionStatus.mockReturnValue(false);
      tick(action, "ctx-1");
      tick(action, "ctx-2");
      expect(redrawn(action)).toEqual([["ctx-2", expect.stringMatching(/\|dimmed$/)]]);
    });
  });
});

describe("ReplayMarkers on a dial (#1230)", () => {
  const STRIP = { id: "sd-plus-strip", width: 200, height: 100 } as const;

  function dialEvent(settings: Record<string, unknown>, payload: Record<string, unknown> = {}, id = "dial-1") {
    return {
      action: {
        id,
        isKey: () => false,
        isDial: () => true,
        dialCanvas: () => STRIP,
        setDialCanvas: vi.fn((_uri: string) => Promise.resolve()),
        setImage: vi.fn((_svg: string) => Promise.resolve()),
        setTitle: vi.fn((_title: string) => Promise.resolve()),
        setTriggerDescription: vi.fn((_d: unknown) => Promise.resolve()),
      },
      payload: { settings, ...payload },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isStoreInitialized.mockReturnValue(true);
    mocks.markers.add.mockReturnValue(true);
    mocks.markers.deleteNearest.mockReturnValue(null);
    mocks.markers.next.mockReturnValue(null);
    mocks.markers.previous.mockReturnValue(null);
    mocks.markers.list.mockReturnValue([]);
    mocks.setPlayPosition.mockReturnValue(true);
    _resetReplayCursor();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("appears on the dial's screen, not as a key, and follows the SDK", async () => {
    const { action, sdk } = makeAction(REPLAY);
    const ev = dialEvent({});

    await action.onWillAppear(ev as never);

    expect(action["setKeyImage"]).not.toHaveBeenCalled();
    expect(ev.action.setDialCanvas).toHaveBeenCalledWith(expect.stringContaining(">MARKERS</text>"));
    expect(sdk.subscribe).toHaveBeenCalledWith("dial-1", expect.any(Function));

    // A tick reaches the dial surface: a marker added elsewhere shows on the next one.
    mocks.markers.list.mockReturnValue([{ frame: 1_000, sessionNum: 1, sessionTimeMs: 0 }]);
    (sdk.subscribe.mock.calls[0]![1] as () => void)();
    expect(ev.action.setDialCanvas).toHaveBeenLastCalledWith(expect.stringContaining(">1</text>"));
    expect(action["updateKeyImage"]).not.toHaveBeenCalled();
  });

  it("a turn jumps through the shared store predicate", async () => {
    mocks.markers.next.mockReturnValue({ frame: 14_000, sessionNum: 1, sessionTimeMs: 0 });
    const { action } = makeAction(REPLAY);
    await action.onWillAppear(dialEvent({}) as never);

    await action.onDialRotate(dialEvent({}, { ticks: 1, pressed: false }) as never);

    expect(mocks.markers.next).toHaveBeenCalledWith(12_000, { subSessionId: 86697546 });
    expect(mocks.setPlayPosition).toHaveBeenCalledWith(ReplayPosMode.Begin, 14_000);
  });

  it("a press adds with the dial's own Seconds back, not the keypad's", async () => {
    const { action } = makeAction(LIVE);
    const settings = { secondsBack: 20, dial: { secondsBack: 2 } };
    await action.onWillAppear(dialEvent(settings) as never);

    await action.onDialDown(dialEvent(settings) as never);
    await action.onDialUp(dialEvent(settings) as never);

    expect(mocks.markers.add).toHaveBeenCalledWith(expect.objectContaining({ frame: 30_000 - 120 }), {
      subSessionId: 86697546,
    });
  });

  it("a touch runs the Tap Display gesture", async () => {
    mocks.markers.list.mockReturnValue([{ frame: 12_100, sessionNum: 1, sessionTimeMs: 0 }]);
    mocks.markers.deleteNearest.mockReturnValue({ frame: 12_100, sessionNum: 1, sessionTimeMs: 0 });
    const { action } = makeAction(REPLAY);
    const settings = { dial: { tapAction: "delete" } };
    await action.onWillAppear(dialEvent(settings) as never);

    await action.onTouchTap(dialEvent(settings, { hold: false }) as never);

    expect(mocks.markers.deleteNearest).toHaveBeenCalledWith(12_100, { subSessionId: 86697546 });
  });

  describe("one shared landing across the keypad and every dial", () => {
    const FRAMES: Marker[] = [1_000, 2_000, 3_000, 4_000].map((frame) => ({ frame, sessionNum: 1, sessionTimeMs: 0 }));
    const sent = () => mocks.setPlayPosition.mock.calls.map((c) => c[1]);
    const replayAt = (frame: number) => ({ ...REPLAY, ReplayFrameNum: frame }) as TelemetryData;
    const turn = (action: ReplayMarkers, ticks: number) =>
      action.onDialRotate(dialEvent({}, { ticks, pressed: false }) as never);

    beforeEach(() => {
      // The store's own windows: next is > 60 frames ahead, previous > 120 behind.
      mocks.markers.next.mockImplementation(
        ((frame: number) => FRAMES.find((m) => m.frame - frame > 60) ?? null) as never,
      );
      mocks.markers.previous.mockImplementation(
        ((frame: number) => [...FRAMES].reverse().find((m) => frame - m.frame > 120) ?? null) as never,
      );
      mocks.markers.list.mockReturnValue(FRAMES);
    });

    it("keypad Next right after a dial turn steps beyond the dial's target rather than re-sending it", async () => {
      const { action } = makeAction(replayAt(500));
      await action.onWillAppear(dialEvent({}) as never);

      await turn(action, 1);
      await action.onKeyDown(keyDown({ mode: "next" }, "key-1"));

      expect(sent()).toEqual([1_000, 2_000]);
    });

    it("a dial turn after keypad Previous within the hold measures from the keypad's landing", async () => {
      const { action } = makeAction(replayAt(2_500));
      await action.onWillAppear(dialEvent({}) as never);

      await turn(action, 1);
      await action.onKeyDown(keyDown({ mode: "previous" }, "key-1"));
      await turn(action, 1);

      // From the keypad's 2 000, not from the dial's own 3 000 (which would send 4 000).
      expect(sent()).toEqual([3_000, 2_000, 3_000]);
    });

    it("a keypad Next key greys out once a dial has jumped to the last marker", async () => {
      const { action, sdk } = makeAction(replayAt(500));
      await action.onWillAppear(dialEvent({}) as never);
      await appear(action, { mode: "next" }, "key-1");
      expect(vi.mocked(action["setKeyImage"]).mock.calls.at(-1)![1]).not.toContain("dimmed");

      await turn(action, 9);
      const keyTick = sdk.subscribe.mock.calls.find(([id]) => id === "key-1")![1] as () => void;
      keyTick();

      expect(sent()).toEqual([4_000]);
      expect(vi.mocked(action["updateKeyImage"]).mock.calls.at(-1)).toEqual([
        "key-1",
        expect.stringMatching(/\|dimmed$/),
      ]);
    });

    it("a jump the keypad could not send leaves the dial's landing standing", async () => {
      const { action } = makeAction(replayAt(500));
      await action.onWillAppear(dialEvent({}) as never);

      await turn(action, 1);
      mocks.setPlayPosition.mockReturnValueOnce(false);
      await action.onKeyDown(keyDown({ mode: "next" }, "key-1"));
      await turn(action, 1);

      // The keypad's 2 000 never went out; the replay is still headed for the
      // dial's 1 000, so the dial steps on from there.
      expect(sent()).toEqual([1_000, 2_000, 2_000]);
    });
  });

  it("settings and disappearance stay on the dial side", async () => {
    const { action, sdk } = makeAction(REPLAY);
    await action.onWillAppear(dialEvent({}) as never);

    await action.onDidReceiveSettings(dialEvent({ dial: { pressAction: "none" } }) as never);
    expect(action["setKeyImage"]).not.toHaveBeenCalled();

    await action.onWillDisappear(dialEvent({}) as never);
    expect(sdk.unsubscribe).toHaveBeenCalledWith("dial-1");
  });
});

function expectUntouched(action: ReplayMarkers): void {
  expect(mocks.markers.add).not.toHaveBeenCalled();
  expect(mocks.markers.deleteNearest).not.toHaveBeenCalled();
  expect(mocks.markers.next).not.toHaveBeenCalled();
  expect(mocks.markers.previous).not.toHaveBeenCalled();
  expect(mocks.setPlayPosition).not.toHaveBeenCalled();
  expect(action["updateKeyImage"]).not.toHaveBeenCalled();
}
