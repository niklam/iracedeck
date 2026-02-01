import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateTireServiceSvg, TireService } from "./tire-service.js";

const {
  mockPitLeftFront,
  mockPitRightFront,
  mockPitLeftRear,
  mockPitRightRear,
  mockPitAllTires,
  mockPitTireCompound,
  mockPitClearTires,
  mockGetCommands,
} = vi.hoisted(() => ({
  mockPitLeftFront: vi.fn(() => true),
  mockPitRightFront: vi.fn(() => true),
  mockPitLeftRear: vi.fn(() => true),
  mockPitRightRear: vi.fn(() => true),
  mockPitAllTires: vi.fn(() => true),
  mockPitTireCompound: vi.fn(() => true),
  mockPitClearTires: vi.fn(() => true),
  mockGetCommands: vi.fn(() => ({
    pit: {
      leftFront: mockPitLeftFront,
      rightFront: mockPitRightFront,
      leftRear: mockPitLeftRear,
      rightRear: mockPitRightRear,
      allTires: mockPitAllTires,
      tireCompound: mockPitTireCompound,
      clearTires: mockPitClearTires,
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

vi.mock("@iracedeck/stream-deck-shared", () => ({
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

describe("TireService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("generateTireServiceSvg", () => {
    it("should generate a valid data URI for request-lf", () => {
      const result = generateTireServiceSvg({ action: "request-lf" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for request-rf", () => {
      const result = generateTireServiceSvg({ action: "request-rf" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for request-lr", () => {
      const result = generateTireServiceSvg({ action: "request-lr" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for request-rr", () => {
      const result = generateTireServiceSvg({ action: "request-rr" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for request-all", () => {
      const result = generateTireServiceSvg({ action: "request-all" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for change-compound", () => {
      const result = generateTireServiceSvg({ action: "change-compound" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for clear-tires", () => {
      const result = generateTireServiceSvg({ action: "clear-tires" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for different action types", () => {
      const lf = generateTireServiceSvg({ action: "request-lf" });
      const rf = generateTireServiceSvg({ action: "request-rf" });
      const lr = generateTireServiceSvg({ action: "request-lr" });
      const rr = generateTireServiceSvg({ action: "request-rr" });
      const all = generateTireServiceSvg({ action: "request-all" });
      const compound = generateTireServiceSvg({ action: "change-compound" });
      const clear = generateTireServiceSvg({ action: "clear-tires" });

      const icons = [lf, rf, lr, rr, all, compound, clear];
      const unique = new Set(icons);
      expect(unique.size).toBe(icons.length);
    });

    it("should include correct labels for all action types", () => {
      const expectedLabels: Record<string, { line1: string; line2: string }> = {
        "request-lf": { line1: "LEFT", line2: "FRONT" },
        "request-rf": { line1: "RIGHT", line2: "FRONT" },
        "request-lr": { line1: "LEFT", line2: "REAR" },
        "request-rr": { line1: "RIGHT", line2: "REAR" },
        "request-all": { line1: "ALL", line2: "TIRES" },
        "change-compound": { line1: "TIRE", line2: "COMPOUND" },
        "clear-tires": { line1: "CLEAR", line2: "TIRES" },
      };

      for (const [actionType, labels] of Object.entries(expectedLabels)) {
        const result = generateTireServiceSvg({ action: actionType as any });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.line1);
        expect(decoded).toContain(labels.line2);
      }
    });
  });

  describe("key press behavior", () => {
    let action: TireService;

    beforeEach(() => {
      action = new TireService();
    });

    it("should call pit.leftFront() on keyDown for request-lf", async () => {
      await action.onKeyDown(fakeEvent("action-1", { action: "request-lf" }) as any);

      expect(mockPitLeftFront).toHaveBeenCalledOnce();
      expect(mockPitRightFront).not.toHaveBeenCalled();
      expect(mockPitLeftRear).not.toHaveBeenCalled();
      expect(mockPitRightRear).not.toHaveBeenCalled();
      expect(mockPitAllTires).not.toHaveBeenCalled();
      expect(mockPitTireCompound).not.toHaveBeenCalled();
      expect(mockPitClearTires).not.toHaveBeenCalled();
    });

    it("should call pit.rightFront() on keyDown for request-rf", async () => {
      await action.onKeyDown(fakeEvent("action-1", { action: "request-rf" }) as any);

      expect(mockPitRightFront).toHaveBeenCalledOnce();
      expect(mockPitLeftFront).not.toHaveBeenCalled();
      expect(mockPitLeftRear).not.toHaveBeenCalled();
      expect(mockPitRightRear).not.toHaveBeenCalled();
      expect(mockPitAllTires).not.toHaveBeenCalled();
      expect(mockPitTireCompound).not.toHaveBeenCalled();
      expect(mockPitClearTires).not.toHaveBeenCalled();
    });

    it("should call pit.leftRear() on keyDown for request-lr", async () => {
      await action.onKeyDown(fakeEvent("action-1", { action: "request-lr" }) as any);

      expect(mockPitLeftRear).toHaveBeenCalledOnce();
      expect(mockPitLeftFront).not.toHaveBeenCalled();
      expect(mockPitRightFront).not.toHaveBeenCalled();
      expect(mockPitRightRear).not.toHaveBeenCalled();
      expect(mockPitAllTires).not.toHaveBeenCalled();
      expect(mockPitTireCompound).not.toHaveBeenCalled();
      expect(mockPitClearTires).not.toHaveBeenCalled();
    });

    it("should call pit.rightRear() on keyDown for request-rr", async () => {
      await action.onKeyDown(fakeEvent("action-1", { action: "request-rr" }) as any);

      expect(mockPitRightRear).toHaveBeenCalledOnce();
      expect(mockPitLeftFront).not.toHaveBeenCalled();
      expect(mockPitRightFront).not.toHaveBeenCalled();
      expect(mockPitLeftRear).not.toHaveBeenCalled();
      expect(mockPitAllTires).not.toHaveBeenCalled();
      expect(mockPitTireCompound).not.toHaveBeenCalled();
      expect(mockPitClearTires).not.toHaveBeenCalled();
    });

    it("should call pit.allTires() on keyDown for request-all", async () => {
      await action.onKeyDown(fakeEvent("action-1", { action: "request-all" }) as any);

      expect(mockPitAllTires).toHaveBeenCalledOnce();
      expect(mockPitLeftFront).not.toHaveBeenCalled();
      expect(mockPitRightFront).not.toHaveBeenCalled();
      expect(mockPitLeftRear).not.toHaveBeenCalled();
      expect(mockPitRightRear).not.toHaveBeenCalled();
      expect(mockPitTireCompound).not.toHaveBeenCalled();
      expect(mockPitClearTires).not.toHaveBeenCalled();
    });

    it("should call pit.tireCompound(0) on keyDown for change-compound", async () => {
      await action.onKeyDown(fakeEvent("action-1", { action: "change-compound" }) as any);

      expect(mockPitTireCompound).toHaveBeenCalledOnce();
      expect(mockPitTireCompound).toHaveBeenCalledWith(0);
      expect(mockPitLeftFront).not.toHaveBeenCalled();
      expect(mockPitRightFront).not.toHaveBeenCalled();
      expect(mockPitLeftRear).not.toHaveBeenCalled();
      expect(mockPitRightRear).not.toHaveBeenCalled();
      expect(mockPitAllTires).not.toHaveBeenCalled();
      expect(mockPitClearTires).not.toHaveBeenCalled();
    });

    it("should call pit.clearTires() on keyDown for clear-tires", async () => {
      await action.onKeyDown(fakeEvent("action-1", { action: "clear-tires" }) as any);

      expect(mockPitClearTires).toHaveBeenCalledOnce();
      expect(mockPitLeftFront).not.toHaveBeenCalled();
      expect(mockPitRightFront).not.toHaveBeenCalled();
      expect(mockPitLeftRear).not.toHaveBeenCalled();
      expect(mockPitRightRear).not.toHaveBeenCalled();
      expect(mockPitAllTires).not.toHaveBeenCalled();
      expect(mockPitTireCompound).not.toHaveBeenCalled();
    });

    it("should default to request-all when no action is specified", async () => {
      await action.onKeyDown(fakeEvent("action-1", {}) as any);

      expect(mockPitAllTires).toHaveBeenCalledOnce();
    });
  });

  describe("encoder behavior", () => {
    let action: TireService;

    beforeEach(() => {
      action = new TireService();
    });

    it("should call pit.leftFront() on dialDown for request-lf", async () => {
      await action.onDialDown(fakeEvent("action-1", { action: "request-lf" }) as any);

      expect(mockPitLeftFront).toHaveBeenCalledOnce();
    });

    it("should call pit.rightFront() on dialDown for request-rf", async () => {
      await action.onDialDown(fakeEvent("action-1", { action: "request-rf" }) as any);

      expect(mockPitRightFront).toHaveBeenCalledOnce();
    });

    it("should call pit.leftRear() on dialDown for request-lr", async () => {
      await action.onDialDown(fakeEvent("action-1", { action: "request-lr" }) as any);

      expect(mockPitLeftRear).toHaveBeenCalledOnce();
    });

    it("should call pit.rightRear() on dialDown for request-rr", async () => {
      await action.onDialDown(fakeEvent("action-1", { action: "request-rr" }) as any);

      expect(mockPitRightRear).toHaveBeenCalledOnce();
    });

    it("should call pit.allTires() on dialDown for request-all", async () => {
      await action.onDialDown(fakeEvent("action-1", { action: "request-all" }) as any);

      expect(mockPitAllTires).toHaveBeenCalledOnce();
    });

    it("should call pit.tireCompound(0) on dialDown for change-compound", async () => {
      await action.onDialDown(fakeEvent("action-1", { action: "change-compound" }) as any);

      expect(mockPitTireCompound).toHaveBeenCalledOnce();
      expect(mockPitTireCompound).toHaveBeenCalledWith(0);
    });

    it("should call pit.clearTires() on dialDown for clear-tires", async () => {
      await action.onDialDown(fakeEvent("action-1", { action: "clear-tires" }) as any);

      expect(mockPitClearTires).toHaveBeenCalledOnce();
    });
  });
});
