import { assembleIcon } from "@iracedeck/deck-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BLACK_BOX_CONTROL_KEYS } from "../../shared/black-box.js";
import {
  BLACK_BOX_GLOBAL_KEYS,
  BlackBoxSelector,
  BlackBoxSelectorSettings,
  generateBlackBoxSelectorSvg,
  resolveBlackBoxSettingKey,
} from "./black-box-selector.js";

const { mockTapBinding } = vi.hoisted(() => ({
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
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
vi.mock("@iracedeck/icons/black-box-selector/quick-access.svg", () => ({
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
vi.mock("@iracedeck/icons/black-box-selector/toggle-size.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">toggle-size</svg>',
}));

vi.mock("@iracedeck/deck-core", async () => {
  const { z } = await import("zod");

  return {
    assembleIcon: vi.fn(
      ({ graphicSvg, title }: { graphicSvg: string; colors: unknown; title: { titleText: string } }) => {
        const encoded = encodeURIComponent(`<svg>${graphicSvg}${title?.titleText ?? ""}</svg>`);

        return `data:image/svg+xml,${encoded}`;
      },
    ),
    // The action's own fields parse through real zod, so the `mode` enum is what
    // the settings tests exercise (the CommonSettings base keys are not filled).
    CommonSettings: {
      extend: (shape: never) => z.looseObject(shape),
    },
    ConnectionStateAwareAction: class MockConnectionStateAwareAction {
      logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn() };
      setKeyImage = vi.fn();
      setRegenerateCallback = vi.fn();
      tapBinding = mockTapBinding;
      holdBinding = vi.fn().mockResolvedValue(undefined);
      releaseBinding = vi.fn().mockResolvedValue(undefined);
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
    getGlobalGraphicSettings: vi.fn(() => ({})),
    getGlobalTitleSettings: vi.fn(() => ({})),
    getKeyboard: vi.fn(() => ({
      sendKeyCombination: vi.fn().mockResolvedValue(true),
    })),
    // Dial surface (imported transitively) needs these at construct / render time.
    applyBindingWarning: vi.fn((content: string) => `${content}<binding-warning/>`),
    escapeXml: vi.fn((s: string) => s),
    svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
    classifyDialRelease: vi.fn(() => "short"),
    getDualPressThresholdMs: vi.fn(() => 500),
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
  };
});

vi.mock("@iracedeck/settings", () => ({
  getGlobalColors: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({})),
  // Dial surface (imported transitively) subscribes at construct time.
  onGlobalSettingsChange: vi.fn(() => vi.fn()),
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

  describe("BlackBoxSelectorSettings mode (#1238)", () => {
    it.each(["direct", "next", "previous", "toggle-size"] as const)("parses mode %s", (mode) => {
      expect(BlackBoxSelectorSettings.parse({ mode }).mode).toBe(mode);
    });

    it("defaults to Direct", () => {
      expect(BlackBoxSelectorSettings.parse({}).mode).toBe("direct");
    });

    it("rejects a mode it does not know", () => {
      expect(BlackBoxSelectorSettings.safeParse({ mode: "make-large" }).success).toBe(false);
    });

    it("keeps the stored box while in Toggle Size, so switching back restores it", () => {
      expect(BlackBoxSelectorSettings.parse({ mode: "toggle-size", blackBox: "weather" }).blackBox).toBe("weather");
    });
  });

  describe("resolveBlackBoxSettingKey", () => {
    it("names the Toggle Black Box Size key", () => {
      expect(BLACK_BOX_CONTROL_KEYS.toggleSize).toBe("blackBoxToggleSize");
    });

    it.each([
      [{ mode: "direct", blackBox: "relative" }, "blackBoxRelative"],
      [{ mode: "next" }, "blackBoxCycleNext"],
      [{ mode: "previous" }, "blackBoxCyclePrevious"],
      [{ mode: "toggle-size", blackBox: "relative" }, "blackBoxToggleSize"],
    ] as const)("maps %o to %s", (settings, key) => {
      expect(resolveBlackBoxSettingKey(BlackBoxSelectorSettings.parse(settings))).toBe(key);
    });

    it("throws on a mode it has no key for, rather than falling through to another mode's", () => {
      expect(() =>
        resolveBlackBoxSettingKey({ ...BlackBoxSelectorSettings.parse({}), mode: "selected-control" } as never),
      ).toThrow(/selected-control/);
    });
  });

  describe("generateBlackBoxSelectorSvg", () => {
    it("draws the Toggle Size icon titled BOX SIZE (#1238)", () => {
      const decoded = decodeURIComponent(
        generateBlackBoxSelectorSvg(BlackBoxSelectorSettings.parse({ mode: "toggle-size", blackBox: "fuel" })),
      );

      expect(decoded).toContain(">toggle-size<");
      expect(decoded).toContain("BOX SIZE");
      expect(decoded).not.toContain(">fuel<");
    });

    it("passes the missing-binding state through for Toggle Size", () => {
      generateBlackBoxSelectorSvg(BlackBoxSelectorSettings.parse({ mode: "toggle-size" }), true);

      expect(vi.mocked(assembleIcon)).toHaveBeenCalledWith(expect.objectContaining({ bindingMissing: true }));
    });

    it("should generate a valid data URI for direct mode with lap-timing", () => {
      const result = generateBlackBoxSelectorSvg(
        BlackBoxSelectorSettings.parse({ mode: "direct", blackBox: "lap-timing" }),
      );

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all direct black boxes", () => {
      for (const blackBox of ALL_BLACK_BOXES) {
        const result = generateBlackBoxSelectorSvg(BlackBoxSelectorSettings.parse({ mode: "direct", blackBox }));

        expect(result).toContain("data:image/svg+xml");
      }
    });

    it("should generate a valid data URI for next cycle mode", () => {
      const result = generateBlackBoxSelectorSvg(
        BlackBoxSelectorSettings.parse({ mode: "next", blackBox: "lap-timing" }),
      );

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for previous cycle mode", () => {
      const result = generateBlackBoxSelectorSvg(
        BlackBoxSelectorSettings.parse({ mode: "previous", blackBox: "lap-timing" }),
      );

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for different black boxes", () => {
      const lapTiming = generateBlackBoxSelectorSvg(
        BlackBoxSelectorSettings.parse({ mode: "direct", blackBox: "lap-timing" }),
      );
      const fuel = generateBlackBoxSelectorSvg(BlackBoxSelectorSettings.parse({ mode: "direct", blackBox: "fuel" }));

      expect(lapTiming).not.toBe(fuel);
    });

    it("should produce different icons for next vs previous cycle mode", () => {
      const next = generateBlackBoxSelectorSvg(
        BlackBoxSelectorSettings.parse({ mode: "next", blackBox: "lap-timing" }),
      );
      const previous = generateBlackBoxSelectorSvg(
        BlackBoxSelectorSettings.parse({ mode: "previous", blackBox: "lap-timing" }),
      );

      expect(next).not.toBe(previous);
    });

    it("should include correct labels for direct lap-timing", () => {
      const result = generateBlackBoxSelectorSvg(
        BlackBoxSelectorSettings.parse({ mode: "direct", blackBox: "lap-timing" }),
      );
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("LAP TIMING");
    });

    it("should include NEXT label for next cycle mode", () => {
      const result = generateBlackBoxSelectorSvg(
        BlackBoxSelectorSettings.parse({ mode: "next", blackBox: "lap-timing" }),
      );
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("NEXT");
    });

    it("should include PREVIOUS label for previous cycle mode", () => {
      const result = generateBlackBoxSelectorSvg(
        BlackBoxSelectorSettings.parse({ mode: "previous", blackBox: "lap-timing" }),
      );
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
        mirror: "QUICK ACCESS",
        radio: "RADIO",
        weather: "WEATHER",
      };

      for (const [blackBox, titleText] of Object.entries(expectedTitleText)) {
        const result = generateBlackBoxSelectorSvg(
          BlackBoxSelectorSettings.parse({ mode: "direct", blackBox: blackBox }),
        );
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
        action: {
          id: actionId,
          setTitle: vi.fn(),
          setImage: vi.fn(),
          isKey: vi.fn().mockReturnValue(true),
          isDial: vi.fn().mockReturnValue(false),
        },
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

      it("taps Toggle Black Box Size exactly once in toggle-size mode, with no prime (#1238)", async () => {
        await action.onKeyDown(fakeEvent("a1", { mode: "toggle-size", blackBox: "fuel" }) as never);

        expect(mockTapBinding.mock.calls).toEqual([["blackBoxToggleSize"]]);
      });
    });

    describe("key icon in toggle-size mode (#1238)", () => {
      it("shows the missing-binding state while Toggle Black Box Size is unbound", async () => {
        vi.mocked(action["isBindingMissing"]).mockImplementation((key) => key === "blackBoxToggleSize");

        await action.onWillAppear(fakeEvent("a1", { mode: "toggle-size" }) as never);

        expect(action["isBindingMissing"]).toHaveBeenCalledWith("blackBoxToggleSize");
        expect(vi.mocked(assembleIcon)).toHaveBeenLastCalledWith(
          expect.objectContaining({ bindingMissing: true, title: expect.objectContaining({ titleText: "BOX SIZE" }) }),
        );
      });

      it("drops the missing-binding state once it is bound", async () => {
        await action.onWillAppear(fakeEvent("a1", { mode: "toggle-size" }) as never);

        expect(vi.mocked(assembleIcon)).toHaveBeenLastCalledWith(expect.objectContaining({ bindingMissing: false }));
      });
    });
  });
});
