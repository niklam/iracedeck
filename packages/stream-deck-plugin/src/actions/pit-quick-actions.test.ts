import { beforeEach, describe, expect, it, vi } from "vitest";

import { generatePitQuickActionsSvg, PitQuickActions } from "./pit-quick-actions.js";

const { mockPitClear, mockPitWindshield, mockPitFastRepair, mockGetCommands } = vi.hoisted(() => ({
  mockPitClear: vi.fn(() => true),
  mockPitWindshield: vi.fn(() => true),
  mockPitFastRepair: vi.fn(() => true),
  mockGetCommands: vi.fn(() => ({
    pit: {
      clear: mockPitClear,
      windshield: mockPitWindshield,
      fastRepair: mockPitFastRepair,
    },
  })),
}));

vi.mock("@iracedeck/icons/pit-quick-actions/clear-all-checkboxes.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/pit-quick-actions/windshield-tearoff.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/pit-quick-actions/request-fast-repair.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
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
    extend: () => {
      const defaults = { action: "clear-all-checkboxes" };
      const schema = {
        parse: (data: Record<string, unknown>) => ({ ...defaults, ...data }),
        safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...defaults, ...data } }),
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
    setRegenerateCallback = vi.fn();
    async onWillAppear() {}
    async onDidReceiveSettings() {}
    async onWillDisappear() {}
  },
  createSDLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  })),
  getCommands: mockGetCommands,
  getGlobalColors: vi.fn(() => ({})),
  LogLevel: { Info: 2 },
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

/** Create a minimal fake event with the given action ID and settings. */
function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
  return {
    action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn() },
    payload: { settings },
  };
}

describe("PitQuickActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("generatePitQuickActionsSvg", () => {
    it("should generate a valid data URI for clear-all-checkboxes", () => {
      const result = generatePitQuickActionsSvg({ action: "clear-all-checkboxes" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for windshield-tearoff", () => {
      const result = generatePitQuickActionsSvg({ action: "windshield-tearoff" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for request-fast-repair", () => {
      const result = generatePitQuickActionsSvg({ action: "request-fast-repair" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for different action types", () => {
      const clearAll = generatePitQuickActionsSvg({ action: "clear-all-checkboxes" });
      const windshield = generatePitQuickActionsSvg({ action: "windshield-tearoff" });
      const fastRepair = generatePitQuickActionsSvg({ action: "request-fast-repair" });

      expect(clearAll).not.toBe(windshield);
      expect(clearAll).not.toBe(fastRepair);
      expect(windshield).not.toBe(fastRepair);
    });

    it("should include correct labels for all action types", () => {
      const expectedLabels: Record<string, { mainLabel: string; subLabel: string }> = {
        "clear-all-checkboxes": { mainLabel: "CLEAR ALL", subLabel: "PIT" },
        "windshield-tearoff": { mainLabel: "WINDSHIELD", subLabel: "TEAROFF" },
        "request-fast-repair": { mainLabel: "FAST", subLabel: "REPAIR" },
      };

      for (const [actionType, labels] of Object.entries(expectedLabels)) {
        const result = generatePitQuickActionsSvg({ action: actionType as any });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.mainLabel);
        expect(decoded).toContain(labels.subLabel);
      }
    });
  });

  describe("key press behavior", () => {
    let action: PitQuickActions;

    beforeEach(() => {
      action = new PitQuickActions();
    });

    it("should call pit.clear() on keyDown for clear-all-checkboxes", async () => {
      await action.onKeyDown(fakeEvent("action-1", { action: "clear-all-checkboxes" }) as any);

      expect(mockPitClear).toHaveBeenCalledOnce();
      expect(mockPitWindshield).not.toHaveBeenCalled();
      expect(mockPitFastRepair).not.toHaveBeenCalled();
    });

    it("should call pit.windshield() on keyDown for windshield-tearoff", async () => {
      await action.onKeyDown(fakeEvent("action-1", { action: "windshield-tearoff" }) as any);

      expect(mockPitWindshield).toHaveBeenCalledOnce();
      expect(mockPitClear).not.toHaveBeenCalled();
      expect(mockPitFastRepair).not.toHaveBeenCalled();
    });

    it("should call pit.fastRepair() on keyDown for request-fast-repair", async () => {
      await action.onKeyDown(fakeEvent("action-1", { action: "request-fast-repair" }) as any);

      expect(mockPitFastRepair).toHaveBeenCalledOnce();
      expect(mockPitClear).not.toHaveBeenCalled();
      expect(mockPitWindshield).not.toHaveBeenCalled();
    });

    it("should default to clear-all-checkboxes when no action is specified", async () => {
      await action.onKeyDown(fakeEvent("action-1", {}) as any);

      expect(mockPitClear).toHaveBeenCalledOnce();
    });
  });

  describe("encoder behavior", () => {
    let action: PitQuickActions;

    beforeEach(() => {
      action = new PitQuickActions();
    });

    it("should call pit.clear() on dialDown for clear-all-checkboxes", async () => {
      await action.onDialDown(fakeEvent("action-1", { action: "clear-all-checkboxes" }) as any);

      expect(mockPitClear).toHaveBeenCalledOnce();
    });

    it("should call pit.windshield() on dialDown for windshield-tearoff", async () => {
      await action.onDialDown(fakeEvent("action-1", { action: "windshield-tearoff" }) as any);

      expect(mockPitWindshield).toHaveBeenCalledOnce();
    });

    it("should call pit.fastRepair() on dialDown for request-fast-repair", async () => {
      await action.onDialDown(fakeEvent("action-1", { action: "request-fast-repair" }) as any);

      expect(mockPitFastRepair).toHaveBeenCalledOnce();
    });
  });
});
