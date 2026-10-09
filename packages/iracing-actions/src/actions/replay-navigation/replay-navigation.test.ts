import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cursorTestEvent,
  type ReplayCursorProbe,
  stageReplayCursorProbe,
} from "../../shared/replay-cursor.test-support.js";
import { steppedReplayState } from "../../shared/test-support/replay-state.js";
import { generateReplayNavigationSvg, ReplayNavigation } from "./replay-navigation.js";

vi.mock("@iracedeck/icons/replay-navigation/next-session.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-navigation/prev-session.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-navigation/next-lap.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-navigation/prev-lap.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-navigation/next-incident.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-navigation/prev-incident.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-navigation/jump-to-start.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-navigation/jump-to-end.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-navigation/set-play-position.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-navigation/search-session-time.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-navigation/erase-tape.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));

vi.mock("@iracedeck/deck-iracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/deck-iracing")>()),
  getCommands: vi.fn(() => ({
    replay: {
      nextSession: vi.fn(() => true),
      prevSession: vi.fn(() => true),
      nextLap: vi.fn(() => true),
      prevLap: vi.fn(() => true),
      nextIncident: vi.fn(() => true),
      prevIncident: vi.fn(() => true),
      goToStart: vi.fn(() => true),
      goToEnd: vi.fn(() => true),
      setPlayPosition: vi.fn(() => true),
      searchSessionTime: vi.fn(() => true),
      eraseTape: vi.fn(() => true),
    },
  })),
}));

vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: (_fields: unknown) => {
      // Return a mock Zod-like schema
      const schema = {
        parse: (data: Record<string, unknown>) => ({ ...data }),
        safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
      };

      return schema;
    },
    parse: (data: Record<string, unknown>) => ({ ...data }),
    safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
  },
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    sdkController = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      getSessionInfo: vi.fn((): unknown => null),
      noteReplayLeftForLive: vi.fn(),
    };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
  },
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  LogLevel: { Info: 2 },
  getGlobalTitleSettings: vi.fn(() => ({})),
  resolveIconColors: vi.fn((_svg, _global, _overrides) => ({})),
  resolveBorderSettings: vi.fn((_svg: unknown, _global: unknown, _overrides?: unknown, _stateColor?: string) => ({
    enabled: false,
    borderWidth: 7,
    borderColor: "#00aaff",
    glowEnabled: true,
    glowWidth: 18,
  })),
  resolveGraphicSettings: vi.fn(() => ({ scale: 1 })),
  resolveTitleSettings: vi.fn((_svg: unknown, _global: unknown, _overrides: unknown, defaultTitle?: string) => ({
    showTitle: true,
    showGraphics: true,
    titleText: defaultTitle ?? "",
    bold: true,
    fontSize: 18,
    position: "bottom" as const,
    customPosition: 0,
  })),
  assembleIcon: vi.fn(
    ({ graphicSvg, title }: { graphicSvg: string; colors: unknown; title: { titleText: string } }) => {
      const encoded = encodeURIComponent(`<svg>${graphicSvg}${title?.titleText ?? ""}</svg>`);

      return `data:image/svg+xml,${encoded}`;
    },
  ),
}));

vi.mock("@iracedeck/settings", () => ({
  getGlobalColors: vi.fn(() => ({})),
}));

describe("ReplayNavigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("generateReplayNavigationSvg", () => {
    const ALL_NAVIGATIONS = [
      "next-session",
      "prev-session",
      "next-lap",
      "prev-lap",
      "next-incident",
      "prev-incident",
      "jump-to-start",
      "jump-to-end",
      "set-play-position",
      "search-session-time",
      "erase-tape",
    ] as const;

    it.each(ALL_NAVIGATIONS)("should generate a valid data URI for %s", (navigation) => {
      const result = generateReplayNavigationSvg({ navigation });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for different navigation actions", () => {
      const results = ALL_NAVIGATIONS.map((navigation) => generateReplayNavigationSvg({ navigation }));

      const uniqueResults = new Set(results);
      expect(uniqueResults.size).toBe(ALL_NAVIGATIONS.length);
    });

    it("should include NEXT label for next-session", () => {
      const result = generateReplayNavigationSvg({ navigation: "next-session" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("SESSION");
    });

    it("should include PREVIOUS label for prev-session", () => {
      const result = generateReplayNavigationSvg({ navigation: "prev-session" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("PREVIOUS");
      expect(decoded).toContain("SESSION");
    });

    it("should include NEXT label for next-lap", () => {
      const result = generateReplayNavigationSvg({ navigation: "next-lap" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("LAP");
    });

    it("should include PREVIOUS label for prev-lap", () => {
      const result = generateReplayNavigationSvg({ navigation: "prev-lap" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("PREVIOUS");
      expect(decoded).toContain("LAP");
    });

    it("should include NEXT label for next-incident", () => {
      const result = generateReplayNavigationSvg({ navigation: "next-incident" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("INCIDENT");
    });

    it("should include PREVIOUS label for prev-incident", () => {
      const result = generateReplayNavigationSvg({ navigation: "prev-incident" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("PREVIOUS");
      expect(decoded).toContain("INCIDENT");
    });

    it("should include JUMP TO label for jump-to-start", () => {
      const result = generateReplayNavigationSvg({ navigation: "jump-to-start" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("JUMP TO");
      expect(decoded).toContain("START");
    });

    it("should include JUMP TO label for jump-to-end", () => {
      const result = generateReplayNavigationSvg({ navigation: "jump-to-end" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("JUMP TO");
      expect(decoded).toContain("END");
    });

    it("should include SET label for set-play-position", () => {
      const result = generateReplayNavigationSvg({ navigation: "set-play-position" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("SET");
      expect(decoded).toContain("POSITION");
    });

    it("should include SEARCH label for search-session-time", () => {
      const result = generateReplayNavigationSvg({ navigation: "search-session-time" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("SEARCH");
      expect(decoded).toContain("TIME");
    });

    it("should include ERASE label for erase-tape", () => {
      const result = generateReplayNavigationSvg({ navigation: "erase-tape" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("ERASE");
      expect(decoded).toContain("TAPE");
    });
  });

  describe("jump-to-end and the controller's replay grace (#1230, #1324)", () => {
    const mockReplay = { goToEnd: vi.fn(() => true) };
    /** A replay at frame 4 000; `ReplayFrameNumEnd` is the frames left. */
    const REPLAY = { IsReplayPlaying: true, ReplayFrameNum: 4_000, ReplayFrameNumEnd: 90_000 } as TelemetryData;
    /** What telemetry reads in the post-seek blip, and from the car. */
    const NOT_PLAYING = { IsReplayPlaying: false, ReplayFrameNum: 0, ReplayFrameNumEnd: 90_000 } as TelemetryData;
    let action: ReplayNavigation;
    let telemetry: TelemetryData;
    let sessionInfo: unknown;
    let t0: number;

    function fakeEvent(settings: Record<string, unknown>) {
      return { action: { id: "ctx-end", setTitle: vi.fn(), setImage: vi.fn() }, payload: { settings } };
    }

    function inSession(simMode: string): void {
      sessionInfo = { WeekendInfo: { SimMode: simMode } };
    }

    beforeEach(async () => {
      mockReplay.goToEnd.mockReturnValue(true);
      const { getCommands } = await import("@iracedeck/deck-iracing");
      vi.mocked(getCommands).mockReturnValue({ replay: mockReplay } as any);
      action = new ReplayNavigation();
      sessionInfo = null;
      // The controller's state, stepped with the real rule at every read.
      const replay = steppedReplayState(
        () => telemetry,
        () => sessionInfo,
      );
      action["sdkController"].getReplayState = vi.fn(replay.getReplayState);
      action["sdkController"].noteReplayLeftForLive = vi.fn(replay.noteReplayLeftForLive);
      // The replay on screen before the press.
      t0 = Date.now();
      telemetry = REPLAY;
    });

    /** The replay tick before the press, then the state a blip tick reads 50 ms after it. */
    async function pressJumpToEnd(): Promise<{ inReplay: boolean; frame: number | null }> {
      action["sdkController"].getReplayState(t0);
      await action.onKeyDown(fakeEvent({ navigation: "jump-to-end" }) as any);
      telemetry = NOT_PLAYING;

      return action["sdkController"].getReplayState(t0 + 50);
    }

    it("a jump to the end in a live session leaves the replay for the car: no grace follows", async () => {
      inSession("full");

      expect(await pressJumpToEnd()).toMatchObject({ inReplay: false, frame: 90_000 });
      expect(mockReplay.goToEnd).toHaveBeenCalledOnce();
      expect(action["sdkController"].noteReplayLeftForLive).toHaveBeenCalledOnce();
    });

    it("a jump to the end that was not sent tells the controller nothing: the grace stands", async () => {
      inSession("full");
      mockReplay.goToEnd.mockReturnValue(false);

      expect(await pressJumpToEnd()).toMatchObject({ inReplay: true, frame: 4_000 });
      expect(action["sdkController"].noteReplayLeftForLive).not.toHaveBeenCalled();
    });

    it("in a saved replay the jump only seeks to the end of the file: the grace stands", async () => {
      inSession("replay");

      expect(await pressJumpToEnd()).toMatchObject({ inReplay: true, frame: 4_000 });
      expect(mockReplay.goToEnd).toHaveBeenCalledOnce();
      // The action tells the controller every sent goToEnd; the saved-replay rule is the SDK's.
      expect(action["sdkController"].noteReplayLeftForLive).toHaveBeenCalledOnce();
    });
  });

  describe("every command takes the replay cursor first (#1334)", () => {
    const COMMANDS = [
      "nextSession",
      "prevSession",
      "nextLap",
      "prevLap",
      "nextIncident",
      "prevIncident",
      "goToStart",
      "goToEnd",
      "setPlayPosition",
      "searchSessionTime",
      "eraseTape",
    ] as const;
    let probe: ReplayCursorProbe<(typeof COMMANDS)[number]>;
    let action: ReplayNavigation;

    beforeEach(async () => {
      probe = stageReplayCursorProbe(COMMANDS);
      const { getCommands } = await import("@iracedeck/deck-iracing");
      vi.mocked(getCommands).mockReturnValue({ replay: probe.replay } as any);
      action = new ReplayNavigation();
    });

    it.each([
      ["next-session", "nextSession"],
      ["prev-session", "prevSession"],
      ["next-lap", "nextLap"],
      ["prev-lap", "prevLap"],
      ["next-incident", "nextIncident"],
      ["prev-incident", "prevIncident"],
      ["jump-to-start", "goToStart"],
      ["jump-to-end", "goToEnd"],
      ["set-play-position", "setPlayPosition"],
      ["search-session-time", "searchSessionTime"],
      ["erase-tape", "eraseTape"],
    ] as const)("%s stops the walk and clears the landing before sending %s", async (mode, sentCommand) => {
      await action.onKeyDown(cursorTestEvent({ navigation: mode }) as any);

      probe.expectTakenBefore(`replay-navigation-${mode}`, sentCommand);
    });

    it("a dial press takes the cursor as its mode", async () => {
      await action.onDialDown(cursorTestEvent({ navigation: "next-lap" }) as any);

      probe.expectTakenBefore("replay-navigation-next-lap", "nextLap");
    });

    it("a dial turn takes the cursor as the direction it resolved to", async () => {
      await action.onDialRotate(cursorTestEvent({ navigation: "next-lap" }, -1) as any);

      probe.expectTakenBefore("replay-navigation-prev-lap", "prevLap");
    });

    it("a dial turn on a mode with no direction sends nothing and leaves the walk alone", async () => {
      await action.onDialRotate(cursorTestEvent({ navigation: "jump-to-end" }, 1) as any);

      probe.expectUntouched();
    });

    it("a zero-tick dial turn carries no direction: nothing is sent and the walk stands", async () => {
      await action.onDialRotate(cursorTestEvent({ navigation: "next-lap" }, 0) as any);

      probe.expectUntouched();
    });
  });
});
