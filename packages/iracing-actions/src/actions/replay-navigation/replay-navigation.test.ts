import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetReplayCursor,
  claimReplayCursor,
  currentReplayCursorOwner,
  lastReplaySighting,
  pendingReplayLanding,
  recordReplayLanding,
  recordReplaySighting,
} from "../../shared/replay-cursor.js";
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
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getSessionInfo: vi.fn((): unknown => null) };
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

  describe("jump-to-end and the Replay Markers replay grace (#1230)", () => {
    const mockReplay = { goToEnd: vi.fn(() => true) };
    let action: ReplayNavigation;

    function fakeEvent(settings: Record<string, unknown>) {
      return { action: { id: "ctx-end", setTitle: vi.fn(), setImage: vi.fn() }, payload: { settings } };
    }

    function inSession(simMode: string): void {
      action["sdkController"].getSessionInfo = vi.fn(() => ({ WeekendInfo: { SimMode: simMode } }));
    }

    beforeEach(async () => {
      _resetReplayCursor();
      mockReplay.goToEnd.mockReturnValue(true);
      const { getCommands } = await import("@iracedeck/deck-iracing");
      vi.mocked(getCommands).mockReturnValue({ replay: mockReplay } as any);
      action = new ReplayNavigation();
      recordReplaySighting(4_000, 10_000);
    });

    it("a jump to the end in a live session leaves the replay for the car: the sighting is dropped at once", async () => {
      inSession("full");

      await action.onKeyDown(fakeEvent({ navigation: "jump-to-end" }) as any);

      expect(mockReplay.goToEnd).toHaveBeenCalledOnce();
      expect(lastReplaySighting()).toBeNull();
    });

    it("a jump to the end that was not sent leaves the sighting and its grace", async () => {
      inSession("full");
      mockReplay.goToEnd.mockReturnValue(false);

      await action.onKeyDown(fakeEvent({ navigation: "jump-to-end" }) as any);

      expect(lastReplaySighting()).toEqual({ frame: 4_000, seenAt: 10_000 });
    });

    it("in a saved replay the jump only seeks to the end of the file: the sighting and its grace stand", async () => {
      inSession("replay");

      await action.onKeyDown(fakeEvent({ navigation: "jump-to-end" }) as any);

      expect(mockReplay.goToEnd).toHaveBeenCalledOnce();
      expect(lastReplaySighting()).toEqual({ frame: 4_000, seenAt: 10_000 });
    });
  });

  describe("every command takes the replay cursor first (#1334)", () => {
    const sent: string[] = [];
    const command = (name: string) =>
      vi.fn(() => {
        sent.push(name);

        return true;
      });
    const mockReplay = {
      nextSession: command("nextSession"),
      prevSession: command("prevSession"),
      nextLap: command("nextLap"),
      prevLap: command("prevLap"),
      nextIncident: command("nextIncident"),
      prevIncident: command("prevIncident"),
      goToStart: command("goToStart"),
      goToEnd: command("goToEnd"),
      setPlayPosition: command("setPlayPosition"),
      searchSessionTime: command("searchSessionTime"),
      eraseTape: command("eraseTape"),
    };
    let action: ReplayNavigation;
    let cancelledBy: string | null;
    let sentAtCancel: number | null;

    function fakeEvent(settings: Record<string, unknown>, ticks = 0) {
      return { action: { id: "ctx-cursor", setTitle: vi.fn(), setImage: vi.fn() }, payload: { settings, ticks } };
    }

    beforeEach(async () => {
      _resetReplayCursor();
      sent.length = 0;
      cancelledBy = null;
      sentAtCancel = null;
      const { getCommands } = await import("@iracedeck/deck-iracing");
      vi.mocked(getCommands).mockReturnValue({ replay: mockReplay } as any);
      action = new ReplayNavigation();
      // A Jump to Fastest Lap walk in flight, and a marker landing still pending.
      claimReplayCursor("jump-to-fastest-lap", (by) => {
        cancelledBy = by;
        sentAtCancel = sent.length;
      });
      recordReplayLanding(4_000, 10_000);
    });

    function expectCursorTakenBefore(owner: string, sentCommand: string): void {
      expect(cancelledBy).toBe(owner);
      expect(sentAtCancel).toBe(0);
      expect(sent).toEqual([sentCommand]);
      expect(currentReplayCursorOwner()).toBeNull();
      expect(pendingReplayLanding()).toBeNull();
    }

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
    ])("%s stops the walk and clears the landing before sending %s", async (mode, sentCommand) => {
      await action.onKeyDown(fakeEvent({ navigation: mode }) as any);

      expectCursorTakenBefore(`replay-navigation-${mode}`, sentCommand);
    });

    it("a dial press takes the cursor as its mode", async () => {
      await action.onDialDown(fakeEvent({ navigation: "next-lap" }) as any);

      expectCursorTakenBefore("replay-navigation-next-lap", "nextLap");
    });

    it("a dial turn takes the cursor as the direction it resolved to", async () => {
      await action.onDialRotate(fakeEvent({ navigation: "next-lap" }, -1) as any);

      expectCursorTakenBefore("replay-navigation-prev-lap", "prevLap");
    });
  });
});
