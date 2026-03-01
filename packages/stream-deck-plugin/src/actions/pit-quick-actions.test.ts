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
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
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
  LogLevel: { Info: 2 },
  renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
    return `<svg>${data.iconContent || ""}${data.labelLine1 || ""}${data.labelLine2 || ""}</svg>`;
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
      const expectedLabels: Record<string, { line1: string; line2: string }> = {
        "clear-all-checkboxes": { line1: "CLEAR ALL", line2: "PIT" },
        "windshield-tearoff": { line1: "WINDSHIELD", line2: "TEAROFF" },
        "request-fast-repair": { line1: "FAST", line2: "REPAIR" },
      };

      for (const [actionType, labels] of Object.entries(expectedLabels)) {
        const result = generatePitQuickActionsSvg({ action: actionType as any });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.line1);
        expect(decoded).toContain(labels.line2);
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
