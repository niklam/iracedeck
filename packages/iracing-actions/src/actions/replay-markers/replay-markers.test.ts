import { ReplayPosMode, type TelemetryData } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildMarker,
  CONFIRMATION_FLASH_MS,
  generateReplayMarkersSvg,
  readSubSessionId,
  REPLAY_MARKERS_UUID,
  ReplayMarkers,
  ReplayMarkersSettings,
} from "./replay-markers.js";

const mocks = vi.hoisted(() => ({
  isStoreInitialized: vi.fn(() => true),
  markers: {
    add: vi.fn((): boolean => true),
    deleteNearest: vi.fn((): { frame: number; sessionNum: number; sessionTimeMs: number } | null => null),
    next: vi.fn((): { frame: number; sessionNum: number; sessionTimeMs: number } | null => null),
    previous: vi.fn((): { frame: number; sessionNum: number; sessionTimeMs: number } | null => null),
    list: vi.fn(() => []),
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

  return {
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
    assembleIcon: vi.fn(
      ({ graphicSvg, title, colors }: { graphicSvg: string; title: { titleText: string }; colors: unknown }) =>
        `icon|${graphicSvg}|${title.titleText}|${JSON.stringify(colors)}`,
    ),
  };
});

type Sdk = {
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
    action: { id, setTitle: vi.fn().mockResolvedValue(undefined), isKey: () => true },
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
    ])("secondsBack %j reads as %j", (input, expected) => {
      expect(ReplayMarkersSettings.parse({ secondsBack: input }).secondsBack).toBe(expected);
    });

    it("an unreadable secondsBack does not reset the mode", () => {
      expect(ReplayMarkersSettings.parse({ mode: "next", secondsBack: "x" }).mode).toBe("next");
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
      expect(buildMarker(LIVE, 30_000, 5)).toEqual({ frame: 29_700, sessionNum: 2, sessionTimeMs: 495_000 });
    });

    it("replay: seconds back from the frame on screen, with the replay's session", () => {
      expect(buildMarker(REPLAY, 12_000, 0)).toEqual({ frame: 12_000, sessionNum: 1, sessionTimeMs: 200_000 });
    });

    it("clamps the frame and the time at 0", () => {
      expect(buildMarker({ ...LIVE, SessionTime: 2 } as TelemetryData, 100, 60)).toMatchObject({
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
        { frame: 29_700, sessionNum: 2, sessionTimeMs: 495_000 },
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

  describe("Delete", () => {
    it("deletes the marker nearest the current frame and flashes Deleted", async () => {
      mocks.markers.deleteNearest.mockReturnValue({ frame: 11_800, sessionNum: 1, sessionTimeMs: 0 });
      const { action } = makeAction(REPLAY);

      await action.onKeyDown(keyDown({ mode: "delete" }));

      expect(mocks.markers.deleteNearest).toHaveBeenCalledWith(12_000, { subSessionId: 86697546 });
      expect(action["updateKeyImage"]).toHaveBeenCalledWith("ctx-1", expect.stringContaining("MARKER\nDELETED"));
    });

    it("nothing in reach shows nothing", async () => {
      const { action } = makeAction(LIVE);

      await action.onKeyDown(keyDown({ mode: "delete" }));

      expect(mocks.markers.deleteNearest).toHaveBeenCalledWith(30_000, { subSessionId: 86697546 });
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

    it("Previous from the car measures from the live edge", async () => {
      mocks.markers.previous.mockReturnValue({ frame: 29_000, sessionNum: 2, sessionTimeMs: 0 });
      const { action } = makeAction(LIVE);

      await action.onKeyDown(keyDown({ mode: "previous" }));

      expect(mocks.markers.previous).toHaveBeenCalledWith(30_000, { subSessionId: 86697546 });
      expect(mocks.setPlayPosition).toHaveBeenCalledWith(ReplayPosMode.Begin, 29_000);
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
});

function expectUntouched(action: ReplayMarkers): void {
  expect(mocks.markers.add).not.toHaveBeenCalled();
  expect(mocks.markers.deleteNearest).not.toHaveBeenCalled();
  expect(mocks.markers.next).not.toHaveBeenCalled();
  expect(mocks.markers.previous).not.toHaveBeenCalled();
  expect(mocks.setPlayPosition).not.toHaveBeenCalled();
  expect(action["updateKeyImage"]).not.toHaveBeenCalled();
}
