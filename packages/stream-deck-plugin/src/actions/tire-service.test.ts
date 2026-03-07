import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTireToggleMacro,
  generateTireIcon,
  generateTireServiceSvg,
  getCompoundColor,
  getCompoundName,
  getDriverTires,
  TireService,
} from "./tire-service.js";

const {
  mockSendMessage,
  mockPitTireCompound,
  mockPitClearTires,
  mockGetCommands,
  mockGetConnectionStatus,
  mockGetCurrentTelemetry,
  mockGetSessionInfo,
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
  mockGetCurrentTelemetry: vi.fn(() => ({ PitSvFlags: 0, PlayerTireCompound: 0, PitSvTireCompound: 0 })),
  mockGetSessionInfo: vi.fn((): Record<string, unknown> | null => null),
}));

vi.mock("@iracedeck/icons/tire-service/clear-tires.svg", () => ({
  default: "<svg>clear-tires-icon</svg>",
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

vi.mock("../shared/index.js", () => ({
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
  getSDK: vi.fn(() => ({ sdk: { getSessionInfo: mockGetSessionInfo } })),
  LogLevel: { Info: 2 },
  generateIconText: vi.fn(
    (opts: { text: string; fontSize: number; fill: string }) => `<text fill="${opts.fill}">${opts.text}</text>`,
  ),
  renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
    const parts = [data.iconContent, data.textElement, data.mainLabel, data.subLabel].filter(Boolean).join("|");

    return `<svg>${parts}</svg>`;
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
    mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0, PlayerTireCompound: 0, PitSvTireCompound: 0 });
  });

  describe("getDriverTires", () => {
    it("should return tires from session info", () => {
      mockGetSessionInfo.mockReturnValue({
        DriverInfo: {
          Drivers: [
            {
              DriverTires: [
                { TireIndex: 0, TireCompoundType: "Hard" },
                { TireIndex: 1, TireCompoundType: "Wet" },
              ],
            },
          ],
        },
      });

      expect(getDriverTires()).toEqual([
        { TireIndex: 0, TireCompoundType: "Hard" },
        { TireIndex: 1, TireCompoundType: "Wet" },
      ]);
    });

    it("should return fallback when session info is null", () => {
      mockGetSessionInfo.mockReturnValue(null);

      expect(getDriverTires()).toEqual([{ TireIndex: 0, TireCompoundType: "Dry" }]);
    });

    it("should return fallback when DriverTires is missing", () => {
      mockGetSessionInfo.mockReturnValue({ DriverInfo: { Drivers: [{}] } });

      expect(getDriverTires()).toEqual([{ TireIndex: 0, TireCompoundType: "Dry" }]);
    });

    it("should return fallback when DriverTires is empty", () => {
      mockGetSessionInfo.mockReturnValue({
        DriverInfo: { Drivers: [{ DriverTires: [] }] },
      });

      expect(getDriverTires()).toEqual([{ TireIndex: 0, TireCompoundType: "Dry" }]);
    });
  });

  describe("getCompoundColor", () => {
    it("should return white for Hard", () => {
      expect(getCompoundColor("Hard")).toBe("#ffffff");
    });

    it("should return yellow for Medium", () => {
      expect(getCompoundColor("Medium")).toBe("#f1c40f");
    });

    it("should return red for Soft", () => {
      expect(getCompoundColor("Soft")).toBe("#e74c3c");
    });

    it("should return green for Intermediate", () => {
      expect(getCompoundColor("Intermediate")).toBe("#2ecc71");
    });

    it("should return blue for Wet", () => {
      expect(getCompoundColor("Wet")).toBe("#3498db");
    });

    it("should be case-insensitive", () => {
      expect(getCompoundColor("HARD")).toBe("#ffffff");
      expect(getCompoundColor("wet")).toBe("#3498db");
    });

    it("should return gray for unknown types", () => {
      expect(getCompoundColor("Unknown")).toBe("#888888");
    });
  });

  describe("getCompoundName", () => {
    it("should return DRY/WET for 2 compounds when one is Wet", () => {
      mockGetSessionInfo.mockReturnValue({
        DriverInfo: {
          Drivers: [
            {
              DriverTires: [
                { TireIndex: 0, TireCompoundType: "Hard" },
                { TireIndex: 1, TireCompoundType: "Wet" },
              ],
            },
          ],
        },
      });

      expect(getCompoundName(0)).toBe("DRY");
      expect(getCompoundName(1)).toBe("WET");
    });

    it("should uppercase single compound name", () => {
      mockGetSessionInfo.mockReturnValue({
        DriverInfo: {
          Drivers: [{ DriverTires: [{ TireIndex: 0, TireCompoundType: "Soft" }] }],
        },
      });

      expect(getCompoundName(0)).toBe("SOFT");
    });

    it("should use actual names for 3+ compounds", () => {
      mockGetSessionInfo.mockReturnValue({
        DriverInfo: {
          Drivers: [
            {
              DriverTires: [
                { TireIndex: 0, TireCompoundType: "Soft" },
                { TireIndex: 1, TireCompoundType: "Medium" },
                { TireIndex: 2, TireCompoundType: "Hard" },
              ],
            },
          ],
        },
      });

      expect(getCompoundName(0)).toBe("Soft");
      expect(getCompoundName(1)).toBe("Medium");
      expect(getCompoundName(2)).toBe("Hard");
    });

    it("should return DRY when session info unavailable (single fallback)", () => {
      mockGetSessionInfo.mockReturnValue(null);

      expect(getCompoundName(0)).toBe("DRY");
    });
  });

  describe("generateTireIcon", () => {
    it("should include compound color in SVG", () => {
      const icon = generateTireIcon("Hard");
      expect(icon).toContain("#ffffff");
    });

    it("should use blue for Wet compound", () => {
      const icon = generateTireIcon("Wet");
      expect(icon).toContain("#3498db");
    });

    it("should use gray for unknown compound", () => {
      const icon = generateTireIcon("Unknown");
      expect(icon).toContain("#888888");
    });
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
      const compoundSettings = { action: "change-compound" as const, lf: true, rf: true, lr: true, rr: true };

      beforeEach(() => {
        mockGetSessionInfo.mockReturnValue({
          DriverInfo: {
            Drivers: [
              {
                DriverTires: [
                  { TireIndex: 0, TireCompoundType: "Hard" },
                  { TireIndex: 1, TireCompoundType: "Wet" },
                ],
              },
            ],
          },
        });
      });

      it("should generate a valid data URI", () => {
        const result = generateTireServiceSvg(compoundSettings, noTires, { player: 0, pitSv: 0 });
        expect(result).toContain("data:image/svg+xml");
      });

      it("should show Stay on DRY when player and pit service are both dry", () => {
        const result = generateTireServiceSvg(compoundSettings, noTires, { player: 0, pitSv: 0 });
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("Stay on");
        expect(decoded).toContain("DRY");
      });

      it("should show Change to WET when player is dry but pit service is wet", () => {
        const result = generateTireServiceSvg(compoundSettings, noTires, { player: 0, pitSv: 1 });
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("Change to");
        expect(decoded).toContain("WET");
      });

      it("should show Stay on WET when player and pit service are both wet", () => {
        const result = generateTireServiceSvg(compoundSettings, noTires, { player: 1, pitSv: 1 });
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("Stay on");
        expect(decoded).toContain("WET");
      });

      it("should show Change to DRY when player is wet but pit service is dry", () => {
        const result = generateTireServiceSvg(compoundSettings, noTires, { player: 1, pitSv: 0 });
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("Change to");
        expect(decoded).toContain("DRY");
      });

      it("should default to Stay on DRY when compound is not provided", () => {
        const result = generateTireServiceSvg(compoundSettings, noTires);
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("Stay on");
        expect(decoded).toContain("DRY");
      });

      it("should use compound color in tire icon", () => {
        const result = generateTireServiceSvg(compoundSettings, noTires, { player: 0, pitSv: 1 });
        const decoded = decodeURIComponent(result);
        // Wet compound uses blue
        expect(decoded).toContain("#3498db");
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
      it("should cycle from 0 to 1 with 2 compounds", async () => {
        mockGetSessionInfo.mockReturnValue({
          DriverInfo: {
            Drivers: [
              {
                DriverTires: [
                  { TireIndex: 0, TireCompoundType: "Hard" },
                  { TireIndex: 1, TireCompoundType: "Wet" },
                ],
              },
            ],
          },
        });
        mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0, PlayerTireCompound: 0, PitSvTireCompound: 0 });

        await action.onKeyDown(fakeEvent("a1", { action: "change-compound" }) as any);

        expect(mockPitTireCompound).toHaveBeenCalledOnce();
        expect(mockPitTireCompound).toHaveBeenCalledWith(1);
        expect(mockSendMessage).not.toHaveBeenCalled();
      });

      it("should wrap from 1 to 0 with 2 compounds", async () => {
        mockGetSessionInfo.mockReturnValue({
          DriverInfo: {
            Drivers: [
              {
                DriverTires: [
                  { TireIndex: 0, TireCompoundType: "Hard" },
                  { TireIndex: 1, TireCompoundType: "Wet" },
                ],
              },
            ],
          },
        });
        mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0, PlayerTireCompound: 0, PitSvTireCompound: 1 });

        await action.onKeyDown(fakeEvent("a1", { action: "change-compound" }) as any);

        expect(mockPitTireCompound).toHaveBeenCalledOnce();
        expect(mockPitTireCompound).toHaveBeenCalledWith(0);
      });

      it("should cycle through 3+ compounds", async () => {
        mockGetSessionInfo.mockReturnValue({
          DriverInfo: {
            Drivers: [
              {
                DriverTires: [
                  { TireIndex: 0, TireCompoundType: "Soft" },
                  { TireIndex: 1, TireCompoundType: "Medium" },
                  { TireIndex: 2, TireCompoundType: "Hard" },
                ],
              },
            ],
          },
        });
        mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0, PlayerTireCompound: 0, PitSvTireCompound: 1 });

        await action.onKeyDown(fakeEvent("a1", { action: "change-compound" }) as any);

        expect(mockPitTireCompound).toHaveBeenCalledOnce();
        expect(mockPitTireCompound).toHaveBeenCalledWith(2);
      });

      it("should wrap around with 3+ compounds", async () => {
        mockGetSessionInfo.mockReturnValue({
          DriverInfo: {
            Drivers: [
              {
                DriverTires: [
                  { TireIndex: 0, TireCompoundType: "Soft" },
                  { TireIndex: 1, TireCompoundType: "Medium" },
                  { TireIndex: 2, TireCompoundType: "Hard" },
                ],
              },
            ],
          },
        });
        mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0, PlayerTireCompound: 0, PitSvTireCompound: 2 });

        await action.onKeyDown(fakeEvent("a1", { action: "change-compound" }) as any);

        expect(mockPitTireCompound).toHaveBeenCalledOnce();
        expect(mockPitTireCompound).toHaveBeenCalledWith(0);
      });

      it("should default to cycling with fallback when session info unavailable", async () => {
        mockGetSessionInfo.mockReturnValue(null);
        mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0 } as any);

        await action.onKeyDown(fakeEvent("a1", { action: "change-compound" }) as any);

        expect(mockPitTireCompound).toHaveBeenCalledOnce();
        // Fallback has 1 compound, (0+1) % 1 = 0
        expect(mockPitTireCompound).toHaveBeenCalledWith(0);
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

    it("should cycle compound on dial down for change-compound", async () => {
      mockGetSessionInfo.mockReturnValue({
        DriverInfo: {
          Drivers: [
            {
              DriverTires: [
                { TireIndex: 0, TireCompoundType: "Hard" },
                { TireIndex: 1, TireCompoundType: "Wet" },
              ],
            },
          ],
        },
      });
      mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0, PlayerTireCompound: 0, PitSvTireCompound: 0 });

      await action.onDialDown(fakeEvent("a1", { action: "change-compound" }) as any);

      expect(mockPitTireCompound).toHaveBeenCalledOnce();
      expect(mockPitTireCompound).toHaveBeenCalledWith(1);
    });

    it("should call pit.clearTires on dial down for clear-tires", async () => {
      await action.onDialDown(fakeEvent("a1", { action: "clear-tires" }) as any);

      expect(mockPitClearTires).toHaveBeenCalledOnce();
    });
  });
});
