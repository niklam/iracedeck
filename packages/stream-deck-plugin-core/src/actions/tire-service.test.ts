import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildTireToggleMacro, generateTireServiceSvg, TireService } from "./tire-service.js";

const {
  mockSendMessage,
  mockPitTireCompound,
  mockPitClearTires,
  mockGetCommands,
  mockGetConnectionStatus,
  mockGetCurrentTelemetry,
} = vi.hoisted(() => ({
  mockSendMessage: vi.fn(() => true),
  mockPitTireCompound: vi.fn(() => true),
  mockPitClearTires: vi.fn(() => true),
  mockGetCommands: vi.fn(() => ({
    chat: {
      sendMessage: mockSendMessage,
    },
    pit: {
      tireCompound: mockPitTireCompound,
      clearTires: mockPitClearTires,
    },
  })),
  mockGetConnectionStatus: vi.fn(() => true),
  mockGetCurrentTelemetry: vi.fn(() => ({ PitSvFlags: 0 })),
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

vi.mock("@iracedeck/iracing-sdk", () => ({
  hasFlag: vi.fn((value: number, flag: number) => (value & flag) !== 0),
  PitSvFlags: {
    LFTireChange: 0x0001,
    RFTireChange: 0x0002,
    LRTireChange: 0x0004,
    RRTireChange: 0x0008,
  },
}));

vi.mock("@iracedeck/stream-deck-shared", () => ({
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    sdkController = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      getConnectionStatus: mockGetConnectionStatus,
      getCurrentTelemetry: mockGetCurrentTelemetry,
    };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    updateKeyImage = vi.fn();
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
  generateIconText: vi.fn(
    (opts: { text: string; fontSize: number; fill: string }) => `<text fill="${opts.fill}">${opts.text}</text>`,
  ),
  renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
    return `<svg>${data.iconContent || ""}|${data.textElement || ""}</svg>`;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
  return {
    action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn(), isKey: () => true },
    payload: { settings },
  };
}

describe("TireService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConnectionStatus.mockReturnValue(true);
    mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0 });
  });

  describe("buildTireToggleMacro", () => {
    it("should build macro for all tires", () => {
      expect(buildTireToggleMacro({ action: "toggle-tires", lf: true, rf: true, lr: true, rr: true })).toBe(
        "#!lf !rf !lr !rr",
      );
    });

    it("should build macro for front tires only", () => {
      expect(buildTireToggleMacro({ action: "toggle-tires", lf: true, rf: true, lr: false, rr: false })).toBe(
        "#!lf !rf",
      );
    });

    it("should build macro for left side only", () => {
      expect(buildTireToggleMacro({ action: "toggle-tires", lf: true, rf: false, lr: true, rr: false })).toBe(
        "#!lf !lr",
      );
    });

    it("should build macro for single tire", () => {
      expect(buildTireToggleMacro({ action: "toggle-tires", lf: false, rf: false, lr: false, rr: true })).toBe("#!rr");
    });

    it("should return null when no tires configured", () => {
      expect(buildTireToggleMacro({ action: "toggle-tires", lf: false, rf: false, lr: false, rr: false })).toBeNull();
    });
  });

  describe("generateTireServiceSvg", () => {
    const noTires = { lf: false, rf: false, lr: false, rr: false };
    const allTires = { lf: true, rf: true, lr: true, rr: true };

    describe("toggle-tires mode", () => {
      it("should generate a valid data URI", () => {
        const result = generateTireServiceSvg(
          { action: "toggle-tires", lf: true, rf: true, lr: true, rr: true },
          noTires,
        );
        expect(result).toContain("data:image/svg+xml");
      });

      it("should show red for configured but inactive tires", () => {
        const result = generateTireServiceSvg(
          { action: "toggle-tires", lf: true, rf: true, lr: true, rr: true },
          noTires,
        );
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("#FF4444");
        expect(decoded).toContain("No Change");
      });

      it("should show green for configured and active tires", () => {
        const result = generateTireServiceSvg(
          { action: "toggle-tires", lf: true, rf: true, lr: true, rr: true },
          allTires,
        );
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("#44FF44");
        expect(decoded).toContain("Change");
      });

      it("should show black for unconfigured tires", () => {
        const result = generateTireServiceSvg(
          { action: "toggle-tires", lf: false, rf: false, lr: false, rr: false },
          allTires,
        );
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("#000000ff");
      });

      it("should show Change when any configured tire is on", () => {
        const result = generateTireServiceSvg(
          { action: "toggle-tires", lf: true, rf: false, lr: false, rr: false },
          { lf: true, rf: false, lr: false, rr: false },
        );
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("Change");
        expect(decoded).not.toContain("No Change");
      });

      it("should show No Change when no configured tire is on", () => {
        const result = generateTireServiceSvg(
          { action: "toggle-tires", lf: true, rf: true, lr: true, rr: true },
          noTires,
        );
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("No Change");
      });
    });

    describe("change-compound mode", () => {
      it("should generate a valid data URI", () => {
        const result = generateTireServiceSvg(
          { action: "change-compound", lf: true, rf: true, lr: true, rr: true },
          noTires,
        );
        expect(result).toContain("data:image/svg+xml");
      });

      it("should include TIRE and COMPOUND labels", () => {
        const result = generateTireServiceSvg(
          { action: "change-compound", lf: true, rf: true, lr: true, rr: true },
          noTires,
        );
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("TIRE");
        expect(decoded).toContain("COMPOUND");
      });
    });

    describe("clear-tires mode", () => {
      it("should generate a valid data URI", () => {
        const result = generateTireServiceSvg(
          { action: "clear-tires", lf: true, rf: true, lr: true, rr: true },
          noTires,
        );
        expect(result).toContain("data:image/svg+xml");
      });

      it("should include CLEAR and TIRES labels", () => {
        const result = generateTireServiceSvg(
          { action: "clear-tires", lf: true, rf: true, lr: true, rr: true },
          noTires,
        );
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("CLEAR");
        expect(decoded).toContain("TIRES");
      });
    });
  });

  describe("key press behavior", () => {
    let action: TireService;

    beforeEach(() => {
      action = new TireService();
    });

    describe("toggle-tires mode", () => {
      it("should send toggle macro for all configured tires", async () => {
        await action.onKeyDown(
          fakeEvent("a1", { action: "toggle-tires", lf: true, rf: true, lr: true, rr: true }) as any,
        );

        expect(mockSendMessage).toHaveBeenCalledOnce();
        expect(mockSendMessage).toHaveBeenCalledWith("#!lf !rf !lr !rr");
      });

      it("should send toggle macro for only configured tires", async () => {
        await action.onKeyDown(
          fakeEvent("a1", { action: "toggle-tires", lf: true, rf: false, lr: true, rr: false }) as any,
        );

        expect(mockSendMessage).toHaveBeenCalledOnce();
        expect(mockSendMessage).toHaveBeenCalledWith("#!lf !lr");
      });

      it("should not send message when no tires configured", async () => {
        await action.onKeyDown(
          fakeEvent("a1", { action: "toggle-tires", lf: false, rf: false, lr: false, rr: false }) as any,
        );

        expect(mockSendMessage).not.toHaveBeenCalled();
      });

      it("should default to toggle-tires with all tires when settings are empty", async () => {
        await action.onKeyDown(fakeEvent("a1", {}) as any);

        expect(mockSendMessage).toHaveBeenCalledOnce();
        expect(mockSendMessage).toHaveBeenCalledWith("#!lf !rf !lr !rr");
      });
    });

    describe("change-compound mode", () => {
      it("should call pit.tireCompound", async () => {
        await action.onKeyDown(fakeEvent("a1", { action: "change-compound" }) as any);

        expect(mockPitTireCompound).toHaveBeenCalledOnce();
        expect(mockPitTireCompound).toHaveBeenCalledWith(0);
        expect(mockSendMessage).not.toHaveBeenCalled();
      });
    });

    describe("clear-tires mode", () => {
      it("should call pit.clearTires", async () => {
        await action.onKeyDown(fakeEvent("a1", { action: "clear-tires" }) as any);

        expect(mockPitClearTires).toHaveBeenCalledOnce();
        expect(mockSendMessage).not.toHaveBeenCalled();
      });
    });

    it("should not execute when not connected", async () => {
      mockGetConnectionStatus.mockReturnValue(false);

      await action.onKeyDown(
        fakeEvent("a1", { action: "toggle-tires", lf: true, rf: true, lr: true, rr: true }) as any,
      );

      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockPitTireCompound).not.toHaveBeenCalled();
      expect(mockPitClearTires).not.toHaveBeenCalled();
    });
  });

  describe("encoder behavior", () => {
    let action: TireService;

    beforeEach(() => {
      action = new TireService();
    });

    it("should send toggle macro on dial down", async () => {
      await action.onDialDown(
        fakeEvent("a1", { action: "toggle-tires", lf: true, rf: true, lr: true, rr: true }) as any,
      );

      expect(mockSendMessage).toHaveBeenCalledOnce();
      expect(mockSendMessage).toHaveBeenCalledWith("#!lf !rf !lr !rr");
    });

    it("should call pit.tireCompound on dial down for change-compound", async () => {
      await action.onDialDown(fakeEvent("a1", { action: "change-compound" }) as any);

      expect(mockPitTireCompound).toHaveBeenCalledOnce();
    });

    it("should call pit.clearTires on dial down for clear-tires", async () => {
      await action.onDialDown(fakeEvent("a1", { action: "clear-tires" }) as any);

      expect(mockPitClearTires).toHaveBeenCalledOnce();
    });
  });
});
