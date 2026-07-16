import { beforeEach, describe, expect, it, vi } from "vitest";

import { FORCE_FEEDBACK_GLOBAL_KEYS, ForceFeedback, generateForceFeedbackSvg } from "./force-feedback.js";

const { mockTapBinding } = vi.hoisted(() => ({
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@iracedeck/icons/force-feedback/auto-compute-ffb-force.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">auto-compute</svg>',
}));
vi.mock("@iracedeck/icons/force-feedback/ffb-force-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">ffb-increase</svg>',
}));
vi.mock("@iracedeck/icons/force-feedback/ffb-force-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">ffb-decrease</svg>',
}));
vi.mock("@iracedeck/icons/force-feedback/wheel-lfe-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">wheel-lfe-increase</svg>',
}));
vi.mock("@iracedeck/icons/force-feedback/wheel-lfe-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">wheel-lfe-decrease</svg>',
}));
vi.mock("@iracedeck/icons/force-feedback/bass-shaker-lfe-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">bass-shaker-increase</svg>',
}));
vi.mock("@iracedeck/icons/force-feedback/bass-shaker-lfe-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">bass-shaker-decrease</svg>',
}));
vi.mock("@iracedeck/deck-core", () => ({
  deleteGlobalSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
  CommonSettings: {
    extend: (_fields: unknown) => {
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
    updateKeyImage = vi.fn().mockResolvedValue(true);
    tapBinding = mockTapBinding;
    holdBinding = vi.fn().mockResolvedValue(undefined);
    releaseBinding = vi.fn().mockResolvedValue(undefined);
    setActiveBinding = vi.fn();
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
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  LogLevel: { Info: 2 },
  onGlobalSettingsChange: vi.fn(() => vi.fn()),
  parseBinding: vi.fn(),
  parseKeyBinding: vi.fn(),
  isSimHubBinding: vi.fn(
    (v: unknown) => v !== null && typeof v === "object" && (v as Record<string, unknown>).type === "simhub",
  ),
  isSimHubInitialized: vi.fn(() => false),
  getSimHub: vi.fn(() => ({
    startRole: vi.fn().mockResolvedValue(true),
    stopRole: vi.fn().mockResolvedValue(true),
  })),
  getGlobalTitleSettings: vi.fn(() => ({})),
  resolveIconColors: vi.fn((_svg: unknown, _global: unknown, _overrides: unknown) => ({})),
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

/** Create a minimal fake event with the given action ID and settings. */
function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
  return {
    action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn(), setSettings: vi.fn().mockResolvedValue(undefined) },
    payload: { settings },
  };
}

describe("ForceFeedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("FORCE_FEEDBACK_GLOBAL_KEYS", () => {
    it("should have correct mapping for auto-compute-ffb-force", () => {
      expect(FORCE_FEEDBACK_GLOBAL_KEYS["auto-compute-ffb-force"]).toBe("forceFeedbackAutoCompute");
    });

    it("should share FFB Force increase key with cockpit-misc", () => {
      expect(FORCE_FEEDBACK_GLOBAL_KEYS["ffb-force-increase"]).toBe("cockpitMiscFfbForceIncrease");
    });

    it("should share FFB Force decrease key with cockpit-misc", () => {
      expect(FORCE_FEEDBACK_GLOBAL_KEYS["ffb-force-decrease"]).toBe("cockpitMiscFfbForceDecrease");
    });

    it("should have correct mapping for wheel-lfe-increase", () => {
      expect(FORCE_FEEDBACK_GLOBAL_KEYS["wheel-lfe-increase"]).toBe("forceFeedbackWheelLfeLouder");
    });

    it("should have correct mapping for wheel-lfe-decrease", () => {
      expect(FORCE_FEEDBACK_GLOBAL_KEYS["wheel-lfe-decrease"]).toBe("forceFeedbackWheelLfeQuieter");
    });

    it("should have correct mapping for bass-shaker-lfe-increase", () => {
      expect(FORCE_FEEDBACK_GLOBAL_KEYS["bass-shaker-lfe-increase"]).toBe("forceFeedbackBassShakerLfeLouder");
    });

    it("should have correct mapping for bass-shaker-lfe-decrease", () => {
      expect(FORCE_FEEDBACK_GLOBAL_KEYS["bass-shaker-lfe-decrease"]).toBe("forceFeedbackBassShakerLfeQuieter");
    });

    it("should have no entries for the retired intensity modes", () => {
      const keys = Object.keys(FORCE_FEEDBACK_GLOBAL_KEYS);
      expect(keys.filter((k) => k.includes("intensity"))).toEqual([]);
    });

    it("should have exactly 7 entries", () => {
      expect(Object.keys(FORCE_FEEDBACK_GLOBAL_KEYS)).toHaveLength(7);
    });
  });

  describe("generateForceFeedbackSvg", () => {
    it("should generate a valid data URI for auto-compute-ffb-force", () => {
      const result = generateForceFeedbackSvg({ mode: "auto-compute-ffb-force", direction: "increase" });
      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce same icon for auto-compute regardless of direction", () => {
      const increase = generateForceFeedbackSvg({ mode: "auto-compute-ffb-force", direction: "increase" });
      const decrease = generateForceFeedbackSvg({ mode: "auto-compute-ffb-force", direction: "decrease" });
      expect(increase).toBe(decrease);
    });

    it("should produce different icons for increase vs decrease on directional modes", () => {
      const increase = generateForceFeedbackSvg({ mode: "ffb-force", direction: "increase" });
      const decrease = generateForceFeedbackSvg({ mode: "ffb-force", direction: "decrease" });
      expect(increase).not.toBe(decrease);
    });

    it("should generate valid data URIs for all mode + direction combinations", () => {
      const modes = ["auto-compute-ffb-force", "ffb-force", "wheel-lfe", "bass-shaker-lfe"] as const;
      const directions = ["increase", "decrease"] as const;

      for (const mode of modes) {
        for (const direction of directions) {
          const result = generateForceFeedbackSvg({ mode, direction });
          expect(result).toContain("data:image/svg+xml");
        }
      }
    });

    it("should produce different icons for different modes", () => {
      const ffb = generateForceFeedbackSvg({ mode: "ffb-force", direction: "increase" });
      const wheelLfe = generateForceFeedbackSvg({ mode: "wheel-lfe", direction: "increase" });
      expect(ffb).not.toBe(wheelLfe);
    });

    it("should include correct labels for auto-compute-ffb-force", () => {
      const result = generateForceFeedbackSvg({ mode: "auto-compute-ffb-force", direction: "increase" });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("AUTO");
      expect(decoded).toContain("FFB FORCE");
    });

    it("should include correct labels for ffb-force increase", () => {
      const result = generateForceFeedbackSvg({ mode: "ffb-force", direction: "increase" });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("INCREASE");
      expect(decoded).toContain("FFB FORCE");
    });

    it("should include correct labels for wheel-lfe decrease", () => {
      const result = generateForceFeedbackSvg({ mode: "wheel-lfe", direction: "decrease" });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("QUIETER");
      expect(decoded).toContain("WHEEL LFE");
    });

    it("should include correct labels for bass-shaker-lfe increase", () => {
      const result = generateForceFeedbackSvg({ mode: "bass-shaker-lfe", direction: "increase" });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("LOUDER");
      expect(decoded).toContain("BASS SHAKER");
    });
  });

  describe("tap behavior", () => {
    let action: ForceFeedback;

    beforeEach(() => {
      action = new ForceFeedback();
    });

    it("should call tapBinding on keyDown for auto-compute-ffb-force", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "auto-compute-ffb-force" }) as any);
      expect(mockTapBinding).toHaveBeenCalledWith("forceFeedbackAutoCompute");
    });

    it("should call tapBinding for ffb-force increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "ffb-force", direction: "increase" }) as any);
      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscFfbForceIncrease");
    });

    it("should call tapBinding for ffb-force decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "ffb-force", direction: "decrease" }) as any);
      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscFfbForceDecrease");
    });

    it("should call tapBinding for wheel-lfe increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "wheel-lfe", direction: "increase" }) as any);
      expect(mockTapBinding).toHaveBeenCalledWith("forceFeedbackWheelLfeLouder");
    });

    it("should call tapBinding for bass-shaker-lfe decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "bass-shaker-lfe", direction: "decrease" }) as any);
      expect(mockTapBinding).toHaveBeenCalledWith("forceFeedbackBassShakerLfeQuieter");
    });

    it("should tap the canonical wheel-lfe binding for the retired wheel-lfe-intensity mode", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "wheel-lfe-intensity", direction: "increase" }) as any);
      expect(mockTapBinding).toHaveBeenCalledWith("forceFeedbackWheelLfeLouder");
    });

    it("should tap the canonical bass-shaker-lfe binding for the retired haptic-lfe-intensity mode", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "haptic-lfe-intensity", direction: "decrease" }) as any);
      expect(mockTapBinding).toHaveBeenCalledWith("forceFeedbackBassShakerLfeQuieter");
    });
  });

  describe("legacy mode persistence", () => {
    let action: ForceFeedback;

    beforeEach(() => {
      action = new ForceFeedback();
    });

    it("should persist the migrated mode on willAppear for a retired mode", async () => {
      const ev = fakeEvent("action-1", { mode: "wheel-lfe-intensity", direction: "decrease" });
      await action.onWillAppear(ev as any);
      expect(ev.action.setSettings).toHaveBeenCalledWith({ mode: "wheel-lfe", direction: "decrease" });
    });

    it("should persist the migrated mode on didReceiveSettings for a retired mode", async () => {
      const ev = fakeEvent("action-1", { mode: "haptic-lfe-intensity", direction: "increase" });
      await action.onDidReceiveSettings(ev as any);
      expect(ev.action.setSettings).toHaveBeenCalledWith({ mode: "bass-shaker-lfe", direction: "increase" });
    });

    it("should not persist anything for canonical modes", async () => {
      const ev = fakeEvent("action-1", { mode: "wheel-lfe", direction: "increase" });
      await action.onWillAppear(ev as any);
      expect(ev.action.setSettings).not.toHaveBeenCalled();
    });
  });
});
