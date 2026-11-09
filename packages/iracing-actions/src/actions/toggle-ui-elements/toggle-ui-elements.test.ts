import { assembleIcon } from "@iracedeck/deck-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateToggleUiElementsSvg,
  ToggleUiElements,
  ToggleUiElementsSettings,
  UI_ELEMENT_GLOBAL_KEYS,
} from "./toggle-ui-elements.js";

const { mockTapBinding } = vi.hoisted(() => ({
  mockTapBinding: vi.fn().mockResolvedValue(true),
}));

/** Every `element` value that existed before Minimal Drive UI (#1584). */
const PRE_1584_ELEMENTS = [
  "dash-box",
  "speed-gear-pedals",
  "radio-display",
  "fps-network-display",
  "weather-radar",
  "virtual-mirror",
  "ui-edit-mode",
  "driving-line",
  "display-ref-car",
  "replay-ui",
] as const;

const ALL_ELEMENTS = [...PRE_1584_ELEMENTS, "minimal-drive-ui"] as const;

vi.mock("@iracedeck/icons/toggle-ui-elements/dash-box.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/toggle-ui-elements/speed-gear-pedals.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/toggle-ui-elements/radio-display.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/toggle-ui-elements/fps-network-display.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/toggle-ui-elements/weather-radar.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/toggle-ui-elements/virtual-mirror.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/toggle-ui-elements/ui-edit-mode.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/toggle-ui-elements/driving-line.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/toggle-ui-elements/minimal-drive-ui.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">minimal-drive-ui-graphic</svg>',
}));
vi.mock("@iracedeck/icons/toggle-ui-elements/display-ref-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/toggle-ui-elements/replay-ui.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));

vi.mock("@iracedeck/deck-iracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/deck-iracing")>()),
  getCommands: vi.fn(() => ({
    camera: {
      hideUI: vi.fn(),
      showUI: vi.fn(),
    },
  })),
}));

vi.mock("@iracedeck/deck-core", async () => {
  const { z } = await import("zod");

  return {
    // The action's own fields parse through real zod, so the `element` enum is what
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
    getKeyboard: vi.fn(() => ({
      sendKeyCombination: vi.fn().mockResolvedValue(true),
    })),
    LogLevel: { Info: 2 },
    parseBinding: vi.fn(),
    parseKeyBinding: vi.fn(),
    isSimHubInitialized: vi.fn(() => false),
    getSimHub: vi.fn(() => ({
      startRole: vi.fn().mockResolvedValue(true),
      stopRole: vi.fn().mockResolvedValue(true),
    })),
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
  };
});

vi.mock("@iracedeck/settings", () => ({
  getGlobalColors: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({})),
  isSimHubBinding: vi.fn(
    (v: unknown) => v !== null && typeof v === "object" && (v as Record<string, unknown>).type === "simhub",
  ),
}));

vi.mock("@iracedeck/iracing-sdk", () => ({
  CameraState: { UIHidden: 0x0008 },
  hasFlag: vi.fn((value: number | undefined, flag: number) => {
    if (value === undefined || value === null) return false;

    return (value & flag) !== 0;
  }),
}));

describe("ToggleUiElements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("ToggleUiElementsSettings", () => {
    it("accepts minimal-drive-ui (#1584)", () => {
      const result = ToggleUiElementsSettings.safeParse({ element: "minimal-drive-ui" });

      expect(result.success).toBe(true);
      expect(result.data?.element).toBe("minimal-drive-ui");
    });

    it.each(PRE_1584_ELEMENTS)("still accepts the existing value %s unchanged", (element) => {
      const result = ToggleUiElementsSettings.safeParse({ element });

      expect(result.success).toBe(true);
      expect(result.data?.element).toBe(element);
    });

    it("keeps dash-box as the default element", () => {
      expect(ToggleUiElementsSettings.parse({}).element).toBe("dash-box");
    });

    it("rejects an unknown element", () => {
      expect(ToggleUiElementsSettings.safeParse({ element: "minimal" }).success).toBe(false);
    });
  });

  describe("UI_ELEMENT_GLOBAL_KEYS", () => {
    it("should have correct mapping for dash-box", () => {
      expect(UI_ELEMENT_GLOBAL_KEYS["dash-box"]).toBe("toggleUiDashBox");
    });

    it("should have correct mapping for speed-gear-pedals", () => {
      expect(UI_ELEMENT_GLOBAL_KEYS["speed-gear-pedals"]).toBe("toggleUiSpeedGearPedals");
    });

    it("should have correct mapping for radio-display", () => {
      expect(UI_ELEMENT_GLOBAL_KEYS["radio-display"]).toBe("toggleUiRadioDisplay");
    });

    it("should have correct mapping for fps-network-display", () => {
      expect(UI_ELEMENT_GLOBAL_KEYS["fps-network-display"]).toBe("toggleUiFpsNetworkDisplay");
    });

    it("should have correct mapping for weather-radar", () => {
      expect(UI_ELEMENT_GLOBAL_KEYS["weather-radar"]).toBe("toggleUiWeatherRadar");
    });

    it("should have correct mapping for virtual-mirror", () => {
      expect(UI_ELEMENT_GLOBAL_KEYS["virtual-mirror"]).toBe("toggleUiVirtualMirror");
    });

    it("should have correct mapping for ui-edit-mode", () => {
      expect(UI_ELEMENT_GLOBAL_KEYS["ui-edit-mode"]).toBe("toggleUiEditMode");
    });

    it("should have correct mapping for driving-line", () => {
      expect(UI_ELEMENT_GLOBAL_KEYS["driving-line"]).toBe("toggleUiDrivingLine");
    });

    it("should have correct mapping for minimal-drive-ui (#1584)", () => {
      expect(UI_ELEMENT_GLOBAL_KEYS["minimal-drive-ui"]).toBe("toggleUiMinimalDriveUi");
    });

    it("should have correct mapping for display-ref-car", () => {
      expect(UI_ELEMENT_GLOBAL_KEYS["display-ref-car"]).toBe("toggleUiDisplayRefCar");
    });

    it("should not have a mapping for replay-ui", () => {
      expect((UI_ELEMENT_GLOBAL_KEYS as Readonly<Record<string, string>>)["replay-ui"]).toBeUndefined();
    });

    it("should have exactly 10 entries", () => {
      expect(Object.keys(UI_ELEMENT_GLOBAL_KEYS)).toHaveLength(10);
    });
  });

  describe("generateToggleUiElementsSvg", () => {
    it("should generate a valid data URI for dash-box", () => {
      const result = generateToggleUiElementsSvg(ToggleUiElementsSettings.parse({ element: "dash-box" }));

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for replay-ui", () => {
      const result = generateToggleUiElementsSvg(ToggleUiElementsSettings.parse({ element: "replay-ui" }));

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all elements", () => {
      for (const element of ALL_ELEMENTS) {
        const result = generateToggleUiElementsSvg(ToggleUiElementsSettings.parse({ element }));
        expect(result).toContain("data:image/svg+xml");
      }
    });

    it("should produce different icons for different elements", () => {
      const dashBox = generateToggleUiElementsSvg(ToggleUiElementsSettings.parse({ element: "dash-box" }));
      const replayUi = generateToggleUiElementsSvg(ToggleUiElementsSettings.parse({ element: "replay-ui" }));

      expect(dashBox).not.toBe(replayUi);
    });

    it("should include DASH BOX label for dash-box element", () => {
      const result = generateToggleUiElementsSvg(ToggleUiElementsSettings.parse({ element: "dash-box" }));

      expect(decodeURIComponent(result)).toContain("DASH BOX");
    });

    it("should include REPLAY UI label for replay-ui element", () => {
      const result = generateToggleUiElementsSvg(ToggleUiElementsSettings.parse({ element: "replay-ui" }));

      expect(decodeURIComponent(result)).toContain("REPLAY UI");
    });

    it("should include TOGGLE label for dash-box element", () => {
      const result = generateToggleUiElementsSvg(ToggleUiElementsSettings.parse({ element: "dash-box" }));

      expect(decodeURIComponent(result)).toContain("TOGGLE");
    });

    it("renders minimal-drive-ui with its own graphic and the MINIMAL / DRIVE UI title (#1584)", () => {
      generateToggleUiElementsSvg(ToggleUiElementsSettings.parse({ element: "minimal-drive-ui" }));

      expect(vi.mocked(assembleIcon)).toHaveBeenLastCalledWith(
        expect.objectContaining({
          graphicSvg: expect.stringContaining("minimal-drive-ui-graphic"),
          title: expect.objectContaining({ titleText: "MINIMAL\nDRIVE UI" }),
          bindingMissing: false,
        }),
      );
    });

    it("should include correct labels for all elements", () => {
      const expectedLabels: Record<(typeof ALL_ELEMENTS)[number], { mainLabel: string; subLabel: string }> = {
        "dash-box": { mainLabel: "DASH BOX", subLabel: "TOGGLE" },
        "speed-gear-pedals": { mainLabel: "INPUTS", subLabel: "TOGGLE" },
        "radio-display": { mainLabel: "RADIO", subLabel: "DISPLAY" },
        "fps-network-display": { mainLabel: "SYSTEM", subLabel: "METERS" },
        "weather-radar": { mainLabel: "WEATHER", subLabel: "RADAR" },
        "virtual-mirror": { mainLabel: "VIRTUAL", subLabel: "MIRROR" },
        "ui-edit-mode": { mainLabel: "UI EDIT", subLabel: "MODE" },
        "driving-line": { mainLabel: "DRIVING LINE", subLabel: "TOGGLE" },
        "minimal-drive-ui": { mainLabel: "DRIVE UI", subLabel: "MINIMAL" },
        "display-ref-car": { mainLabel: "REFERENCE", subLabel: "CAR" },
        "replay-ui": { mainLabel: "REPLAY UI", subLabel: "TOGGLE" },
      };

      for (const [element, labels] of Object.entries(expectedLabels)) {
        const result = generateToggleUiElementsSvg(ToggleUiElementsSettings.parse({ element: element }));
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.mainLabel);
        expect(decoded).toContain(labels.subLabel);
      }
    });
  });

  describe("action behavior", () => {
    let action: ToggleUiElements;

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
      action = new ToggleUiElements();
    });

    describe("onKeyDown", () => {
      it("taps Toggle Minimal Drive UI exactly once for minimal-drive-ui (#1584)", async () => {
        await action.onKeyDown(fakeEvent("a1", { element: "minimal-drive-ui" }) as never);

        expect(mockTapBinding.mock.calls).toEqual([["toggleUiMinimalDriveUi"]]);
      });

      it("still taps the Driving Line binding for driving-line", async () => {
        await action.onKeyDown(fakeEvent("a1", { element: "driving-line" }) as never);

        expect(mockTapBinding.mock.calls).toEqual([["toggleUiDrivingLine"]]);
      });
    });

    describe("key icon for minimal-drive-ui (#1584)", () => {
      it("shows the missing-binding state while Toggle Minimal Drive UI is unbound", async () => {
        vi.mocked(action["isBindingMissing"]).mockImplementation((key) => key === "toggleUiMinimalDriveUi");

        await action.onWillAppear(fakeEvent("a1", { element: "minimal-drive-ui" }) as never);

        expect(action["isBindingMissing"]).toHaveBeenCalledWith("toggleUiMinimalDriveUi");
        expect(vi.mocked(assembleIcon)).toHaveBeenLastCalledWith(
          expect.objectContaining({
            bindingMissing: true,
            title: expect.objectContaining({ titleText: "MINIMAL\nDRIVE UI" }),
          }),
        );
        expect(action["setKeyImage"]).toHaveBeenCalled();
      });

      it("drops the missing-binding state once it is bound", async () => {
        await action.onWillAppear(fakeEvent("a1", { element: "minimal-drive-ui" }) as never);

        expect(vi.mocked(assembleIcon)).toHaveBeenLastCalledWith(expect.objectContaining({ bindingMissing: false }));
      });
    });
  });
});
