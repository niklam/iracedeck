import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateSplitsDeltaCycleSvg,
  GLOBAL_KEY_NAMES,
  SplitsDeltaCycle,
  SplitsDeltaCycleSettings,
} from "./splits-delta-cycle.js";

const { mockTapBinding, mockHoldBinding, mockReleaseBinding } = vi.hoisted(() => ({
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
  mockHoldBinding: vi.fn().mockResolvedValue(undefined),
  mockReleaseBinding: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@iracedeck/icons/splits-delta-cycle/next.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/splits-delta-cycle/previous.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/splits-delta-cycle/display-ref-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg" class="ref-car">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/splits-delta-cycle/custom-sector-start.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg" class="custom-sector-start">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/splits-delta-cycle/custom-sector-end.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg" class="custom-sector-end">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/splits-delta-cycle/active-reset-set.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg" class="active-reset-set">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/splits-delta-cycle/active-reset-run.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg" class="active-reset-run">{{mainLabel}} {{subLabel}}</svg>',
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
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
    isBindingMissing = vi.fn(() => false);
    setActiveBinding = vi.fn();
    tapBinding = mockTapBinding;
    holdBinding = mockHoldBinding;
    releaseBinding = mockReleaseBinding;
    async onWillAppear() {}
    async onDidReceiveSettings() {}
    async onWillDisappear() {}
  },
  applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
  classifyDialRelease: vi.fn(() => "short"),
  escapeXml: (str: string) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  getDualPressThresholdMs: vi.fn(() => 500),
  onGlobalSettingsChange: vi.fn(() => vi.fn()),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
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

/** Create a minimal fake keypad event with the given action ID and settings. */
function fakeKeyEvent(actionId: string, settings: Record<string, unknown> = {}) {
  return {
    action: { id: actionId, isDial: () => false, isKey: () => true, setTitle: vi.fn(), setImage: vi.fn() },
    payload: { settings },
  };
}

describe("SplitsDeltaCycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constants", () => {
    it("should have correct global key name for next", () => {
      expect(GLOBAL_KEY_NAMES.NEXT).toBe("splitsDeltaNext");
    });

    it("should have correct global key name for previous", () => {
      expect(GLOBAL_KEY_NAMES.PREVIOUS).toBe("splitsDeltaPrevious");
    });

    it("should have correct global key name for toggle ref car", () => {
      expect(GLOBAL_KEY_NAMES.TOGGLE_REF_CAR).toBe("toggleUiDisplayRefCar");
    });

    it("should have correct global key name for custom sector start", () => {
      expect(GLOBAL_KEY_NAMES.CUSTOM_SECTOR_START).toBe("splitsDeltaCustomSectorStart");
    });

    it("should have correct global key name for custom sector end", () => {
      expect(GLOBAL_KEY_NAMES.CUSTOM_SECTOR_END).toBe("splitsDeltaCustomSectorEnd");
    });

    it("should have correct global key name for active reset set", () => {
      expect(GLOBAL_KEY_NAMES.ACTIVE_RESET_SET).toBe("splitsDeltaActiveResetSet");
    });

    it("should have correct global key name for active reset run", () => {
      expect(GLOBAL_KEY_NAMES.ACTIVE_RESET_RUN).toBe("splitsDeltaActiveResetRun");
    });
  });

  describe("generateSplitsDeltaCycleSvg", () => {
    it("should generate a valid data URI for next direction", () => {
      const result = generateSplitsDeltaCycleSvg(SplitsDeltaCycleSettings.parse({ mode: "cycle", direction: "next" }));

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for previous direction", () => {
      const result = generateSplitsDeltaCycleSvg(
        SplitsDeltaCycleSettings.parse({ mode: "cycle", direction: "previous" }),
      );

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for next and previous", () => {
      const next = generateSplitsDeltaCycleSvg(SplitsDeltaCycleSettings.parse({ mode: "cycle", direction: "next" }));
      const previous = generateSplitsDeltaCycleSvg(
        SplitsDeltaCycleSettings.parse({ mode: "cycle", direction: "previous" }),
      );

      expect(next).not.toBe(previous);
    });

    it("should include NEXT label for next direction", () => {
      const result = generateSplitsDeltaCycleSvg(SplitsDeltaCycleSettings.parse({ mode: "cycle", direction: "next" }));

      expect(decodeURIComponent(result)).toContain("NEXT");
    });

    it("should include PREVIOUS label for previous direction", () => {
      const result = generateSplitsDeltaCycleSvg(
        SplitsDeltaCycleSettings.parse({ mode: "cycle", direction: "previous" }),
      );

      expect(decodeURIComponent(result)).toContain("PREVIOUS");
    });

    it("should include SPLITS DELTA label for cycle mode", () => {
      const next = generateSplitsDeltaCycleSvg(SplitsDeltaCycleSettings.parse({ mode: "cycle", direction: "next" }));
      const previous = generateSplitsDeltaCycleSvg(
        SplitsDeltaCycleSettings.parse({ mode: "cycle", direction: "previous" }),
      );

      expect(decodeURIComponent(next)).toContain("SPLITS DELTA");
      expect(decodeURIComponent(previous)).toContain("SPLITS DELTA");
    });

    it("should generate ref car icon for toggle-ref-car mode", () => {
      const result = generateSplitsDeltaCycleSvg(
        SplitsDeltaCycleSettings.parse({ mode: "toggle-ref-car", direction: "next" }),
      );

      expect(result).toContain("data:image/svg+xml");
      expect(decodeURIComponent(result)).toContain("ref-car");
    });

    it("should include REFERENCE and CAR labels for toggle-ref-car mode", () => {
      const result = generateSplitsDeltaCycleSvg(
        SplitsDeltaCycleSettings.parse({ mode: "toggle-ref-car", direction: "next" }),
      );
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("REFERENCE");
      expect(decoded).toContain("CAR");
    });

    it("should produce different icons for cycle and toggle-ref-car modes", () => {
      const cycle = generateSplitsDeltaCycleSvg(SplitsDeltaCycleSettings.parse({ mode: "cycle", direction: "next" }));
      const refCar = generateSplitsDeltaCycleSvg(
        SplitsDeltaCycleSettings.parse({ mode: "toggle-ref-car", direction: "next" }),
      );

      expect(cycle).not.toBe(refCar);
    });

    it("should generate custom-sector-start icon", () => {
      const result = generateSplitsDeltaCycleSvg(
        SplitsDeltaCycleSettings.parse({ mode: "custom-sector-start", direction: "next" }),
      );
      expect(result).toContain("data:image/svg+xml");
      expect(decodeURIComponent(result)).toContain("custom-sector-start");
    });

    it("should include SECTOR and START labels for custom-sector-start mode", () => {
      const result = generateSplitsDeltaCycleSvg(
        SplitsDeltaCycleSettings.parse({ mode: "custom-sector-start", direction: "next" }),
      );
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("START");
      expect(decoded).toContain("SECTOR");
    });

    it("should generate custom-sector-end icon", () => {
      const result = generateSplitsDeltaCycleSvg(
        SplitsDeltaCycleSettings.parse({ mode: "custom-sector-end", direction: "next" }),
      );
      expect(result).toContain("data:image/svg+xml");
      expect(decodeURIComponent(result)).toContain("custom-sector-end");
    });

    it("should include SECTOR and END labels for custom-sector-end mode", () => {
      const result = generateSplitsDeltaCycleSvg(
        SplitsDeltaCycleSettings.parse({ mode: "custom-sector-end", direction: "next" }),
      );
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("END");
      expect(decoded).toContain("SECTOR");
    });

    it("should generate active-reset-set icon", () => {
      const result = generateSplitsDeltaCycleSvg(
        SplitsDeltaCycleSettings.parse({ mode: "active-reset-set", direction: "next" }),
      );
      expect(result).toContain("data:image/svg+xml");
      expect(decodeURIComponent(result)).toContain("active-reset-set");
    });

    it("should include SET and RESET POINT labels for active-reset-set mode", () => {
      const result = generateSplitsDeltaCycleSvg(
        SplitsDeltaCycleSettings.parse({ mode: "active-reset-set", direction: "next" }),
      );
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("SET");
      expect(decoded).toContain("RESET POINT");
    });

    it("should generate active-reset-run icon", () => {
      const result = generateSplitsDeltaCycleSvg(
        SplitsDeltaCycleSettings.parse({ mode: "active-reset-run", direction: "next" }),
      );
      expect(result).toContain("data:image/svg+xml");
      expect(decodeURIComponent(result)).toContain("active-reset-run");
    });

    it("should include RESET and TO START labels for active-reset-run mode", () => {
      const result = generateSplitsDeltaCycleSvg(
        SplitsDeltaCycleSettings.parse({ mode: "active-reset-run", direction: "next" }),
      );
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("RESET");
      expect(decoded).toContain("TO START");
    });

    it("should produce different icons for all new modes", () => {
      const sectorStart = generateSplitsDeltaCycleSvg(
        SplitsDeltaCycleSettings.parse({ mode: "custom-sector-start", direction: "next" }),
      );
      const sectorEnd = generateSplitsDeltaCycleSvg(
        SplitsDeltaCycleSettings.parse({ mode: "custom-sector-end", direction: "next" }),
      );
      const resetSet = generateSplitsDeltaCycleSvg(
        SplitsDeltaCycleSettings.parse({ mode: "active-reset-set", direction: "next" }),
      );
      const resetRun = generateSplitsDeltaCycleSvg(
        SplitsDeltaCycleSettings.parse({ mode: "active-reset-run", direction: "next" }),
      );
      const allIcons = [sectorStart, sectorEnd, resetSet, resetRun];
      expect(new Set(allIcons).size).toBe(4);
    });
  });

  describe("press/release behavior", () => {
    let action: SplitsDeltaCycle;

    beforeEach(() => {
      action = new SplitsDeltaCycle();
    });

    it("should hold the active reset run binding while the key is pressed", async () => {
      await action.onKeyDown(fakeKeyEvent("action-1", { mode: "active-reset-run" }) as never);

      expect(mockHoldBinding).toHaveBeenCalledWith("action-1", GLOBAL_KEY_NAMES.ACTIVE_RESET_RUN);
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("should release the active reset run binding on key up", async () => {
      await action.onKeyDown(fakeKeyEvent("action-1", { mode: "active-reset-run" }) as never);
      await action.onKeyUp(fakeKeyEvent("action-1", { mode: "active-reset-run" }) as never);

      expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should hold the key for at least the tap path's 100 ms before releasing", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeKeyEvent("action-1", { mode: "active-reset-run" }) as never);

        // A Multi Action (or a very fast tap) releases immediately; the release
        // must still wait out MIN_HOLD_MS so iRacing's input loop samples the key.
        const keyUp = action.onKeyUp(fakeKeyEvent("action-1", { mode: "active-reset-run" }) as never);
        await vi.advanceTimersByTimeAsync(0);

        expect(mockReleaseBinding).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(100);
        await keyUp;

        expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
      } finally {
        vi.useRealTimers();
      }
    });

    it("should not release a press that started while the previous release waited out the floor", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeKeyEvent("action-1", { mode: "active-reset-run" }) as never);

        // Released instantly, so the floor makes this keyUp wait ~100 ms...
        const keyUp = action.onKeyUp(fakeKeyEvent("action-1", { mode: "active-reset-run" }) as never);

        // ...and the user presses again while it is still waiting.
        await vi.advanceTimersByTimeAsync(20);
        await action.onKeyDown(fakeKeyEvent("action-1", { mode: "active-reset-run" }) as never);

        await vi.advanceTimersByTimeAsync(100);
        await keyUp;

        // The second press owns the binding and is still held — the first
        // keyUp's delayed release must not end it.
        expect(mockReleaseBinding).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("should not delay the release once the key has been held past the floor", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeKeyEvent("action-1", { mode: "active-reset-run" }) as never);
        vi.setSystemTime(Date.now() + 500);

        await action.onKeyUp(fakeKeyEvent("action-1", { mode: "active-reset-run" }) as never);

        expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
      } finally {
        vi.useRealTimers();
      }
    });

    it("should release immediately on key up in a tap mode", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeKeyEvent("action-1", { mode: "cycle", direction: "next" }) as never);
        await action.onKeyUp(fakeKeyEvent("action-1", { mode: "cycle", direction: "next" }) as never);

        // No hold-mode press was recorded, so the floor must not apply — the
        // release is a no-op for tap modes but still has to fire (the mode can
        // change to a tap one while the key is held).
        expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
      } finally {
        vi.useRealTimers();
      }
    });

    it("should release the active reset run binding when the key disappears", async () => {
      await action.onKeyDown(fakeKeyEvent("action-1", { mode: "active-reset-run" }) as never);
      await action.onWillDisappear(fakeKeyEvent("action-1", { mode: "active-reset-run" }) as never);

      expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should not delay teardown by the hold floor when the key disappears mid-press", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeKeyEvent("action-1", { mode: "active-reset-run" }) as never);
        await action.onWillDisappear(fakeKeyEvent("action-1", { mode: "active-reset-run" }) as never);

        expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
      } finally {
        vi.useRealTimers();
      }
    });

    it("should hold independently per action context", async () => {
      await action.onKeyDown(fakeKeyEvent("action-1", { mode: "active-reset-run" }) as never);
      await action.onKeyDown(fakeKeyEvent("action-2", { mode: "active-reset-run" }) as never);

      expect(mockHoldBinding).toHaveBeenCalledTimes(2);
      expect(mockHoldBinding).toHaveBeenCalledWith("action-1", GLOBAL_KEY_NAMES.ACTIVE_RESET_RUN);
      expect(mockHoldBinding).toHaveBeenCalledWith("action-2", GLOBAL_KEY_NAMES.ACTIVE_RESET_RUN);

      await action.onKeyUp(fakeKeyEvent("action-1", { mode: "active-reset-run" }) as never);

      expect(mockReleaseBinding).toHaveBeenCalledTimes(1);
      expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
    });

    it.each([
      ["cycle", GLOBAL_KEY_NAMES.NEXT, { mode: "cycle", direction: "next" }],
      ["toggle-ref-car", GLOBAL_KEY_NAMES.TOGGLE_REF_CAR, { mode: "toggle-ref-car" }],
      ["custom-sector-start", GLOBAL_KEY_NAMES.CUSTOM_SECTOR_START, { mode: "custom-sector-start" }],
      ["custom-sector-end", GLOBAL_KEY_NAMES.CUSTOM_SECTOR_END, { mode: "custom-sector-end" }],
      ["active-reset-set", GLOBAL_KEY_NAMES.ACTIVE_RESET_SET, { mode: "active-reset-set" }],
    ])("should tap rather than hold in %s mode", async (_mode, settingKey, settings) => {
      await action.onKeyDown(fakeKeyEvent("action-1", settings as Record<string, unknown>) as never);

      expect(mockTapBinding).toHaveBeenCalledWith(settingKey);
      expect(mockHoldBinding).not.toHaveBeenCalled();
    });
  });
});
