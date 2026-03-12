import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateReplayNavigationSvg } from "./replay-navigation.js";

vi.mock("@elgato/streamdeck", () => ({
  default: {
    logger: {
      createScope: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        trace: vi.fn(),
      })),
    },
  },
  action: () => (target: unknown) => target,
}));

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

vi.mock("../shared/index.js", () => ({
  CommonSettings: {
    extend: (_fields) => {
      // Return a mock Zod-like schema
      const schema = {
        parse: (data) => ({ flagsOverlay: false, ...data }),
        safeParse: (data) => ({ success: true, data: { flagsOverlay: false, ...data } }),
      };

      return schema;
    },
    parse: (data) => ({ flagsOverlay: false, ...data }),
    safeParse: (data) => ({ success: true, data: { flagsOverlay: false, ...data } }),
  },
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
  },
  createSDLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  })),
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
  LogLevel: { Info: 2 },
  renderIconTemplate: vi.fn((template: string, data: Record<string, string>) => {
    let result = template;

    for (const [key, value] of Object.entries(data)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    return result;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
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

    it("should include PREV label for prev-session", () => {
      const result = generateReplayNavigationSvg({ navigation: "prev-session" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("PREV");
      expect(decoded).toContain("SESSION");
    });

    it("should include NEXT label for next-lap", () => {
      const result = generateReplayNavigationSvg({ navigation: "next-lap" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("LAP");
    });

    it("should include PREV label for prev-lap", () => {
      const result = generateReplayNavigationSvg({ navigation: "prev-lap" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("PREV");
      expect(decoded).toContain("LAP");
    });

    it("should include NEXT label for next-incident", () => {
      const result = generateReplayNavigationSvg({ navigation: "next-incident" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("INCIDENT");
    });

    it("should include PREV label for prev-incident", () => {
      const result = generateReplayNavigationSvg({ navigation: "prev-incident" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("PREV");
      expect(decoded).toContain("INCIDENT");
    });

    it("should include GO TO label for jump-to-start", () => {
      const result = generateReplayNavigationSvg({ navigation: "jump-to-start" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("GO TO");
      expect(decoded).toContain("START");
    });

    it("should include GO TO label for jump-to-end", () => {
      const result = generateReplayNavigationSvg({ navigation: "jump-to-end" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("GO TO");
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
});
