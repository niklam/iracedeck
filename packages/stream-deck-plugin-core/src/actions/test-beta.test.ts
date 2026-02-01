import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateTestBetaSvg, GLOBAL_KEY_NAME, TestBeta } from "./test-beta.js";

const { mockSendKeyCombination, mockParseKeyBinding, mockGetGlobalSettings } = vi.hoisted(() => ({
  mockSendKeyCombination: vi.fn().mockResolvedValue(true),
  mockParseKeyBinding: vi.fn(),
  mockGetGlobalSettings: vi.fn(() => ({})),
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
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
  },
  createSDLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  })),
  formatKeyBinding: vi.fn((b: { key: string; modifiers: string[] }) => {
    if (b.modifiers?.length) {
      return `${b.modifiers.join("+")}+${b.key}`;
    }

    return b.key;
  }),
  getGlobalSettings: mockGetGlobalSettings,
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: mockSendKeyCombination,
  })),
  LogLevel: { Info: 2 },
  parseKeyBinding: mockParseKeyBinding,
  renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
    return `<svg>${data.iconContent || ""}${data.labelLine1 || ""}${data.labelLine2 || ""}</svg>`;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

function fakeEvent(actionId = "test-action-1") {
  return {
    action: {
      id: actionId,
      setTitle: vi.fn(),
      setImage: vi.fn(),
    },
    payload: {
      settings: {},
    },
  };
}

describe("TestBeta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constants", () => {
    it("should have correct global key name", () => {
      expect(GLOBAL_KEY_NAME).toBe("testBetaActivate");
    });
  });

  describe("generateTestBetaSvg", () => {
    it("should generate a valid data URI", () => {
      const result = generateTestBetaSvg();

      expect(result).toContain("data:image/svg+xml");
    });

    it("should include TEST label", () => {
      const result = generateTestBetaSvg();

      expect(decodeURIComponent(result)).toContain("TEST");
    });

    it("should include BETA label", () => {
      const result = generateTestBetaSvg();

      expect(decodeURIComponent(result)).toContain("BETA");
    });
  });

  describe("tap behavior", () => {
    it("should call sendKeyCombination on keyDown when binding exists", async () => {
      mockParseKeyBinding.mockReturnValue({ key: "2", modifiers: ["ctrl", "shift"], code: undefined });

      const action = new TestBeta();
      const ev = fakeEvent();

      await action.onKeyDown(ev as never);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "2",
        modifiers: ["ctrl", "shift"],
        code: undefined,
      });
    });

    it("should handle missing key binding gracefully", async () => {
      mockParseKeyBinding.mockReturnValue(null);

      const action = new TestBeta();
      const ev = fakeEvent();

      await action.onKeyDown(ev as never);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should send key with empty modifiers as undefined", async () => {
      mockParseKeyBinding.mockReturnValue({ key: "2", modifiers: [], code: undefined });

      const action = new TestBeta();
      const ev = fakeEvent();

      await action.onKeyDown(ev as never);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "2",
        modifiers: undefined,
        code: undefined,
      });
    });
  });
});
