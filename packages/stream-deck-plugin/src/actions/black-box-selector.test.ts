import { beforeEach, describe, expect, it, vi } from "vitest";

import { BLACK_BOX_GLOBAL_KEYS, generateBlackBoxSelectorSvg } from "./black-box-selector.js";

vi.mock("@iracedeck/icons/black-box-selector/lap-timing.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">lap-timing {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/standings.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">standings {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/relative.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">relative {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/fuel.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">fuel {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/tires.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">tires {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/tire-info.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">tire-info {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/pit-stop.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">pit-stop {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/in-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">in-car {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/mirror.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">mirror {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/radio.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">radio {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/weather.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">weather {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/next.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">next {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/previous.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">previous {{mainLabel}} {{subLabel}}</svg>',
}));

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

vi.mock("../shared/index.js", () => ({
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
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn() };
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
  formatKeyBinding: vi.fn((b: { key: string; modifiers: string[] }) => {
    if (b.modifiers?.length) {
      return `${b.modifiers.join("+")}+${b.key}`;
    }

    return b.key;
  }),
  getGlobalSettings: vi.fn(() => ({})),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  LogLevel: { Info: 2 },
  parseKeyBinding: vi.fn(),
  renderIconTemplate: vi.fn((template: string, data: Record<string, string>) => {
    let result = template;

    for (const [key, value] of Object.entries(data)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    return result;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

const ALL_BLACK_BOXES = [
  "lap-timing",
  "standings",
  "relative",
  "fuel",
  "tires",
  "tire-info",
  "pit-stop",
  "in-car",
  "mirror",
  "radio",
  "weather",
] as const;

describe("BlackBoxSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("BLACK_BOX_GLOBAL_KEYS", () => {
    it("should have exactly 11 entries", () => {
      expect(Object.keys(BLACK_BOX_GLOBAL_KEYS)).toHaveLength(11);
    });

    it("should have correct mapping for lap-timing", () => {
      expect(BLACK_BOX_GLOBAL_KEYS["lap-timing"]).toBe("blackBoxLapTiming");
    });

    it("should have correct mapping for standings", () => {
      expect(BLACK_BOX_GLOBAL_KEYS["standings"]).toBe("blackBoxStandings");
    });

    it("should use blackBox prefix for all global keys", () => {
      for (const [_action, key] of Object.entries(BLACK_BOX_GLOBAL_KEYS)) {
        expect(key).toMatch(/^blackBox/);
      }
    });

    it("should have unique global keys for all actions", () => {
      const values = Object.values(BLACK_BOX_GLOBAL_KEYS);
      const uniqueValues = new Set(values);

      expect(uniqueValues.size).toBe(values.length);
    });
  });

  describe("generateBlackBoxSelectorSvg", () => {
    it("should generate a valid data URI for direct mode with lap-timing", () => {
      const result = generateBlackBoxSelectorSvg({ mode: "direct", blackBox: "lap-timing" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all direct black boxes", () => {
      for (const blackBox of ALL_BLACK_BOXES) {
        const result = generateBlackBoxSelectorSvg({ mode: "direct", blackBox });

        expect(result).toContain("data:image/svg+xml");
      }
    });

    it("should generate a valid data URI for next cycle mode", () => {
      const result = generateBlackBoxSelectorSvg({ mode: "next", blackBox: "lap-timing" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for previous cycle mode", () => {
      const result = generateBlackBoxSelectorSvg({ mode: "previous", blackBox: "lap-timing" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for different black boxes", () => {
      const lapTiming = generateBlackBoxSelectorSvg({ mode: "direct", blackBox: "lap-timing" });
      const fuel = generateBlackBoxSelectorSvg({ mode: "direct", blackBox: "fuel" });

      expect(lapTiming).not.toBe(fuel);
    });

    it("should produce different icons for next vs previous cycle mode", () => {
      const next = generateBlackBoxSelectorSvg({ mode: "next", blackBox: "lap-timing" });
      const previous = generateBlackBoxSelectorSvg({ mode: "previous", blackBox: "lap-timing" });

      expect(next).not.toBe(previous);
    });

    it("should include correct labels for direct lap-timing", () => {
      const result = generateBlackBoxSelectorSvg({ mode: "direct", blackBox: "lap-timing" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("LAP TIMING");
      expect(decoded).toContain("TOGGLE");
    });

    it("should include NEXT label for next cycle mode", () => {
      const result = generateBlackBoxSelectorSvg({ mode: "next", blackBox: "lap-timing" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("BLACK BOX");
    });

    it("should include PREVIOUS label for previous cycle mode", () => {
      const result = generateBlackBoxSelectorSvg({ mode: "previous", blackBox: "lap-timing" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("PREVIOUS");
      expect(decoded).toContain("BLACK BOX");
    });

    it("should include correct labels for all direct black boxes", () => {
      const expectedLabels: Record<string, { mainLabel: string; subLabel: string }> = {
        "lap-timing": { mainLabel: "LAP TIMING", subLabel: "TOGGLE" },
        standings: { mainLabel: "STANDINGS", subLabel: "TOGGLE" },
        relative: { mainLabel: "RELATIVE", subLabel: "TOGGLE" },
        fuel: { mainLabel: "FUEL", subLabel: "ADJUSTMENTS" },
        tires: { mainLabel: "TIRES", subLabel: "ADJUSTMENTS" },
        "tire-info": { mainLabel: "TIRE INFO", subLabel: "TOGGLE" },
        "pit-stop": { mainLabel: "PIT-STOP", subLabel: "ADJUSTMENTS" },
        "in-car": { mainLabel: "IN-CAR", subLabel: "ADJUSTMENTS" },
        mirror: { mainLabel: "GRAPHICS", subLabel: "ADJUSTMENTS" },
        radio: { mainLabel: "RADIO", subLabel: "CHANNELS" },
        weather: { mainLabel: "WEATHER", subLabel: "FORECAST" },
      };

      for (const [blackBox, labels] of Object.entries(expectedLabels)) {
        const result = generateBlackBoxSelectorSvg({ mode: "direct", blackBox: blackBox as any });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.mainLabel);
        expect(decoded).toContain(labels.subLabel);
      }
    });
  });
});
