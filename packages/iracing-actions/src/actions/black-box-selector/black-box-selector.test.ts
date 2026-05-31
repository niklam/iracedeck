import { beforeEach, describe, expect, it, vi } from "vitest";

import { BLACK_BOX_GLOBAL_KEYS, BlackBoxSelector, generateBlackBoxSelectorSvg } from "./black-box-selector.js";

const { mockTapBinding, mockSetActiveBinding } = vi.hoisted(() => ({
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
  mockSetActiveBinding: vi.fn(),
}));

vi.mock("@iracedeck/icons/black-box-selector/lap-timing.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">lap-timing</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/standings.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">standings</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/relative.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">relative</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/fuel.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">fuel</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/tires.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">tires</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/tire-info.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">tire-info</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/pit-stop.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">pit-stop</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/in-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">in-car</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/mirror.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">mirror</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/radio.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">radio</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/weather.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">weather</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/next.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">next</svg>',
}));
vi.mock("@iracedeck/icons/black-box-selector/previous.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">previous</svg>',
}));

vi.mock("@iracedeck/deck-core", () => ({
  assembleIcon: vi.fn(
    ({ graphicSvg, title }: { graphicSvg: string; colors: unknown; title: { titleText: string } }) => {
      const encoded = encodeURIComponent(`<svg>${graphicSvg}${title?.titleText ?? ""}</svg>`);

      return `data:image/svg+xml,${encoded}`;
    },
  ),
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
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
    tapBinding = mockTapBinding;
    holdBinding = vi.fn().mockResolvedValue(undefined);
    releaseBinding = vi.fn().mockResolvedValue(undefined);
    setActiveBinding = mockSetActiveBinding;
    isBindingMissing = vi.fn(() => false);
    async onWillAppear() {}
    async onDidReceiveSettings() {}
    async onWillDisappear() {}
  },
  formatKeyBinding: vi.fn((b: { key: string; modifiers: string[] }) => {
    if (b.modifiers?.length) {
      return `${b.modifiers.join("+")}+${b.key}`;
    }

    return b.key;
  }),
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({})),
  getGlobalTitleSettings: vi.fn(() => ({})),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  LogLevel: { Info: 2 },
  parseKeyBinding: vi.fn(),
  resolveIconColors: vi.fn((_svg: unknown, _global: unknown, _overrides: unknown) => ({})),
  resolveBorderSettings: vi.fn((_svg: unknown, _global: unknown, _overrides?: unknown, _stateColor?: string) => ({
    enabled: false,
    borderWidth: 7,
    borderColor: "#00aaff",
    glowEnabled: true,
    glowWidth: 18,
  })),
  resolveGraphicSettings: vi.fn(() => ({ scale: 1 })),
  resolveTitleSettings: vi.fn((_svg: unknown, _global: unknown, _overrides: unknown, defaultTitle: string) => ({
    showTitle: true,
    showGraphics: true,
    titleText: defaultTitle ?? "",
    bold: true,
    fontSize: 9,
    position: "bottom" as const,
    customPosition: 0,
  })),
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
    });

    it("should include NEXT label for next cycle mode", () => {
      const result = generateBlackBoxSelectorSvg({ mode: "next", blackBox: "lap-timing" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("NEXT");
    });

    it("should include PREVIOUS label for previous cycle mode", () => {
      const result = generateBlackBoxSelectorSvg({ mode: "previous", blackBox: "lap-timing" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("PREVIOUS");
    });

    it("should include correct labels for all direct black boxes", () => {
      const expectedTitleText: Record<string, string> = {
        "lap-timing": "LAP TIMING",
        standings: "STANDINGS",
        relative: "RELATIVE",
        fuel: "FUEL",
        tires: "TIRES",
        "tire-info": "TIRE INFO",
        "pit-stop": "PIT-STOP",
        "in-car": "IN-CAR",
        mirror: "GRAPHICS",
        radio: "RADIO",
        weather: "WEATHER",
      };

      for (const [blackBox, titleText] of Object.entries(expectedTitleText)) {
        const result = generateBlackBoxSelectorSvg({ mode: "direct", blackBox: blackBox as any });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(titleText);
        // Regression guard: catch anyone reintroducing a leading "\n" in BLACK_BOX_TITLE_TEXT.
        expect(decoded).not.toContain(`\n${titleText}`);
      }
    });
  });

  describe("action behavior", () => {
    let action: BlackBoxSelector;

    function fakeEvent(actionId: string, settings: Record<string, unknown>) {
      return {
        action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn(), isKey: vi.fn().mockReturnValue(true) },
        payload: { settings },
      };
    }

    beforeEach(() => {
      action = new BlackBoxSelector();
    });

    describe("onKeyDown", () => {
      it("should call tapBinding with correct key for direct mode", async () => {
        await action.onKeyDown(fakeEvent("a1", { mode: "direct", blackBox: "fuel" }) as never);

        expect(mockTapBinding).toHaveBeenCalledWith("blackBoxFuel");
      });

      it("should call tapBinding with cycle next key for next mode", async () => {
        await action.onKeyDown(fakeEvent("a1", { mode: "next", blackBox: "lap-timing" }) as never);

        expect(mockTapBinding).toHaveBeenCalledWith("blackBoxCycleNext");
      });

      it("should call tapBinding with cycle previous key for previous mode", async () => {
        await action.onKeyDown(fakeEvent("a1", { mode: "previous", blackBox: "lap-timing" }) as never);

        expect(mockTapBinding).toHaveBeenCalledWith("blackBoxCyclePrevious");
      });
    });

    describe("setActiveBinding", () => {
      it("should set active binding in onWillAppear for direct mode", async () => {
        await action.onWillAppear(fakeEvent("a1", { mode: "direct", blackBox: "standings" }) as never);

        expect(mockSetActiveBinding).toHaveBeenCalledWith("blackBoxStandings");
      });

      it("should update active binding in onDidReceiveSettings", async () => {
        await action.onDidReceiveSettings(fakeEvent("a1", { mode: "direct", blackBox: "tires" }) as never);

        expect(mockSetActiveBinding).toHaveBeenCalledWith("blackBoxTires");
      });

      it("should set cycle key for next mode", async () => {
        await action.onWillAppear(fakeEvent("a1", { mode: "next", blackBox: "lap-timing" }) as never);

        expect(mockSetActiveBinding).toHaveBeenCalledWith("blackBoxCycleNext");
      });
    });
  });
});
