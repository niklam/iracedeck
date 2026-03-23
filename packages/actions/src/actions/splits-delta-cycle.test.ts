import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateSplitsDeltaCycleSvg, GLOBAL_KEY_NAMES } from "./splits-delta-cycle.js";

vi.mock("@iracedeck/icons/splits-delta-cycle/next.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/splits-delta-cycle/previous.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/toggle-ui-elements/display-ref-car.svg", () => ({
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
  },
  formatKeyBinding: vi.fn((b: { key: string; modifiers: string[] }) => {
    if (b.modifiers?.length) {
      return `${b.modifiers.join("+")}+${b.key}`;
    }

    return b.key;
  }),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({})),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  LogLevel: { Info: 2 },
  parseKeyBinding: vi.fn(),
  resolveIconColors: vi.fn((_svg, _global, _overrides) => ({})),
  renderIconTemplate: vi.fn((template: string, data: Record<string, string>) => {
    let result = template;

    for (const [key, value] of Object.entries(data)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    return result;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

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
      const result = generateSplitsDeltaCycleSvg({ mode: "cycle", direction: "next" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for previous direction", () => {
      const result = generateSplitsDeltaCycleSvg({ mode: "cycle", direction: "previous" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for next and previous", () => {
      const next = generateSplitsDeltaCycleSvg({ mode: "cycle", direction: "next" });
      const previous = generateSplitsDeltaCycleSvg({ mode: "cycle", direction: "previous" });

      expect(next).not.toBe(previous);
    });

    it("should include NEXT label for next direction", () => {
      const result = generateSplitsDeltaCycleSvg({ mode: "cycle", direction: "next" });

      expect(decodeURIComponent(result)).toContain("NEXT");
    });

    it("should include PREVIOUS label for previous direction", () => {
      const result = generateSplitsDeltaCycleSvg({ mode: "cycle", direction: "previous" });

      expect(decodeURIComponent(result)).toContain("PREVIOUS");
    });

    it("should include SPLITS DELTA label for cycle mode", () => {
      const next = generateSplitsDeltaCycleSvg({ mode: "cycle", direction: "next" });
      const previous = generateSplitsDeltaCycleSvg({ mode: "cycle", direction: "previous" });

      expect(decodeURIComponent(next)).toContain("SPLITS DELTA");
      expect(decodeURIComponent(previous)).toContain("SPLITS DELTA");
    });

    it("should generate ref car icon for toggle-ref-car mode", () => {
      const result = generateSplitsDeltaCycleSvg({ mode: "toggle-ref-car", direction: "next" });

      expect(result).toContain("data:image/svg+xml");
      expect(decodeURIComponent(result)).toContain("ref-car");
    });

    it("should include REFERENCE and CAR labels for toggle-ref-car mode", () => {
      const result = generateSplitsDeltaCycleSvg({ mode: "toggle-ref-car", direction: "next" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("REFERENCE");
      expect(decoded).toContain("CAR");
    });

    it("should produce different icons for cycle and toggle-ref-car modes", () => {
      const cycle = generateSplitsDeltaCycleSvg({ mode: "cycle", direction: "next" });
      const refCar = generateSplitsDeltaCycleSvg({ mode: "toggle-ref-car", direction: "next" });

      expect(cycle).not.toBe(refCar);
    });

    it("should generate custom-sector-start icon", () => {
      const result = generateSplitsDeltaCycleSvg({ mode: "custom-sector-start", direction: "next" });
      expect(result).toContain("data:image/svg+xml");
      expect(decodeURIComponent(result)).toContain("custom-sector-start");
    });

    it("should include SECTOR and START labels for custom-sector-start mode", () => {
      const result = generateSplitsDeltaCycleSvg({ mode: "custom-sector-start", direction: "next" });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("START");
      expect(decoded).toContain("SECTOR");
    });

    it("should generate custom-sector-end icon", () => {
      const result = generateSplitsDeltaCycleSvg({ mode: "custom-sector-end", direction: "next" });
      expect(result).toContain("data:image/svg+xml");
      expect(decodeURIComponent(result)).toContain("custom-sector-end");
    });

    it("should include SECTOR and END labels for custom-sector-end mode", () => {
      const result = generateSplitsDeltaCycleSvg({ mode: "custom-sector-end", direction: "next" });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("END");
      expect(decoded).toContain("SECTOR");
    });

    it("should generate active-reset-set icon", () => {
      const result = generateSplitsDeltaCycleSvg({ mode: "active-reset-set", direction: "next" });
      expect(result).toContain("data:image/svg+xml");
      expect(decodeURIComponent(result)).toContain("active-reset-set");
    });

    it("should include SET and RESET POINT labels for active-reset-set mode", () => {
      const result = generateSplitsDeltaCycleSvg({ mode: "active-reset-set", direction: "next" });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("SET");
      expect(decoded).toContain("RESET POINT");
    });

    it("should generate active-reset-run icon", () => {
      const result = generateSplitsDeltaCycleSvg({ mode: "active-reset-run", direction: "next" });
      expect(result).toContain("data:image/svg+xml");
      expect(decodeURIComponent(result)).toContain("active-reset-run");
    });

    it("should include RESET and TO START labels for active-reset-run mode", () => {
      const result = generateSplitsDeltaCycleSvg({ mode: "active-reset-run", direction: "next" });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("RESET");
      expect(decoded).toContain("TO START");
    });

    it("should produce different icons for all new modes", () => {
      const sectorStart = generateSplitsDeltaCycleSvg({ mode: "custom-sector-start", direction: "next" });
      const sectorEnd = generateSplitsDeltaCycleSvg({ mode: "custom-sector-end", direction: "next" });
      const resetSet = generateSplitsDeltaCycleSvg({ mode: "active-reset-set", direction: "next" });
      const resetRun = generateSplitsDeltaCycleSvg({ mode: "active-reset-run", direction: "next" });
      const allIcons = [sectorStart, sectorEnd, resetSet, resetRun];
      expect(new Set(allIcons).size).toBe(4);
    });
  });
});
