import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateLookDirectionSvg, LOOK_DIRECTION_GLOBAL_KEYS, LookDirection } from "./look-direction.js";

const {
  mockPressKeyCombination,
  mockReleaseKeyCombination,
  mockSendKeyCombination,
  mockParseKeyBinding,
  mockGetGlobalSettings,
} = vi.hoisted(() => ({
  mockPressKeyCombination: vi.fn().mockResolvedValue(true),
  mockReleaseKeyCombination: vi.fn().mockResolvedValue(true),
  mockSendKeyCombination: vi.fn().mockResolvedValue(true),
  mockParseKeyBinding: vi.fn(),
  mockGetGlobalSettings: vi.fn(() => ({})),
}));

vi.mock("@iracedeck/icons/look-direction/look-left.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/look-direction/look-right.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/look-direction/look-up.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/look-direction/look-down.svg", () => ({
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
  formatKeyBinding: vi.fn((b: { key: string; modifiers: string[] }) => {
    if (b.modifiers?.length) {
      return `${b.modifiers.join("+")}+${b.key}`;
    }

    return b.key;
  }),
  getGlobalSettings: mockGetGlobalSettings,
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: mockSendKeyCombination,
    pressKeyCombination: mockPressKeyCombination,
    releaseKeyCombination: mockReleaseKeyCombination,
  })),
  LogLevel: { Info: 2 },
  parseKeyBinding: mockParseKeyBinding,
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

describe("LookDirection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("LOOK_DIRECTION_GLOBAL_KEYS", () => {
    it("should have correct mapping for look-left", () => {
      expect(LOOK_DIRECTION_GLOBAL_KEYS["look-left"]).toBe("lookDirectionLeft");
    });

    it("should have correct mapping for look-right", () => {
      expect(LOOK_DIRECTION_GLOBAL_KEYS["look-right"]).toBe("lookDirectionRight");
    });

    it("should have correct mapping for look-up", () => {
      expect(LOOK_DIRECTION_GLOBAL_KEYS["look-up"]).toBe("lookDirectionUp");
    });

    it("should have correct mapping for look-down", () => {
      expect(LOOK_DIRECTION_GLOBAL_KEYS["look-down"]).toBe("lookDirectionDown");
    });

    it("should have exactly 4 entries", () => {
      expect(Object.keys(LOOK_DIRECTION_GLOBAL_KEYS)).toHaveLength(4);
    });
  });

  describe("generateLookDirectionSvg", () => {
    it("should generate a valid data URI for look-left", () => {
      const result = generateLookDirectionSvg({ direction: "look-left" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for look-right", () => {
      const result = generateLookDirectionSvg({ direction: "look-right" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all directions", () => {
      const directions = ["look-left", "look-right", "look-up", "look-down"] as const;

      for (const direction of directions) {
        const result = generateLookDirectionSvg({ direction });
        expect(result).toContain("data:image/svg+xml");
      }
    });

    it("should produce different icons for different directions", () => {
      const left = generateLookDirectionSvg({ direction: "look-left" });
      const right = generateLookDirectionSvg({ direction: "look-right" });

      expect(left).not.toBe(right);
    });

    it("should include LOOK label for all directions", () => {
      const directions = ["look-left", "look-right", "look-up", "look-down"] as const;

      for (const direction of directions) {
        const result = generateLookDirectionSvg({ direction });
        expect(decodeURIComponent(result)).toContain("LOOK");
      }
    });

    it("should include correct labels for all directions", () => {
      const expectedLabels: Record<string, { mainLabel: string; subLabel: string }> = {
        "look-left": { mainLabel: "LEFT", subLabel: "LOOK" },
        "look-right": { mainLabel: "RIGHT", subLabel: "LOOK" },
        "look-up": { mainLabel: "UP", subLabel: "LOOK" },
        "look-down": { mainLabel: "DOWN", subLabel: "LOOK" },
      };

      for (const [direction, labels] of Object.entries(expectedLabels)) {
        const result = generateLookDirectionSvg({ direction: direction as any });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.mainLabel);
        expect(decoded).toContain(labels.subLabel);
      }
    });
  });

  describe("press/release behavior", () => {
    let action: LookDirection;

    function setupKeyBinding(key: string, modifiers: string[] = [], code?: string) {
      mockGetGlobalSettings.mockReturnValue({ lookDirectionLeft: "bound", lookDirectionRight: "bound" });
      mockParseKeyBinding.mockReturnValue({ key, modifiers, code });
    }

    beforeEach(() => {
      action = new LookDirection();
    });

    it("should press key on keyDown and release on keyUp", async () => {
      setupKeyBinding("numpad4", [], "Numpad4");

      await action.onKeyDown(fakeEvent("action-1", { direction: "look-left" }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledWith({
        key: "numpad4",
        modifiers: undefined,
        code: "Numpad4",
      });

      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledWith({
        key: "numpad4",
        modifiers: undefined,
        code: "Numpad4",
      });
    });

    it("should press key on dialDown and release on dialUp", async () => {
      setupKeyBinding("numpad4", [], "Numpad4");

      await action.onDialDown(fakeEvent("action-1", { direction: "look-left" }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledOnce();

      await action.onDialUp(fakeEvent("action-1") as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledOnce();
    });

    it("should track concurrent presses on different action contexts independently", async () => {
      mockGetGlobalSettings.mockReturnValue({
        lookDirectionLeft: "bound",
        lookDirectionRight: "bound",
      });
      mockParseKeyBinding.mockImplementation((val: unknown) => {
        if (val === "bound") {
          return { key: "numpad4", modifiers: [], code: "Numpad4" };
        }

        return undefined;
      });

      // Press left on action-1
      await action.onKeyDown(fakeEvent("action-1", { direction: "look-left" }) as any);
      // Press right on action-2
      await action.onKeyDown(fakeEvent("action-2", { direction: "look-right" }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledTimes(2);

      // Release action-1 — should release action-1's combination only
      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledTimes(1);

      // Release action-2
      await action.onKeyUp(fakeEvent("action-2") as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledTimes(2);
    });

    it("should release held key on onWillDisappear", async () => {
      setupKeyBinding("numpad4", [], "Numpad4");

      await action.onKeyDown(fakeEvent("action-1", { direction: "look-left" }) as any);
      await action.onWillDisappear(fakeEvent("action-1") as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledOnce();
    });

    it("should not call release if no key is held", async () => {
      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(mockReleaseKeyCombination).not.toHaveBeenCalled();
    });

    it("should not press key when no binding is configured", async () => {
      mockGetGlobalSettings.mockReturnValue({});
      mockParseKeyBinding.mockReturnValue(undefined);

      await action.onKeyDown(fakeEvent("action-1", { direction: "look-left" }) as any);

      expect(mockPressKeyCombination).not.toHaveBeenCalled();
    });

    it("should not store combination when press fails", async () => {
      setupKeyBinding("numpad4", [], "Numpad4");
      mockPressKeyCombination.mockResolvedValueOnce(false);

      await action.onKeyDown(fakeEvent("action-1", { direction: "look-left" }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledOnce();

      // Release should be a no-op since press failed
      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(mockReleaseKeyCombination).not.toHaveBeenCalled();
    });

    it("should include modifiers in the combination when present", async () => {
      setupKeyBinding("a", ["ctrl", "shift"], "KeyA");

      await action.onKeyDown(fakeEvent("action-1", { direction: "look-left" }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledWith({
        key: "a",
        modifiers: ["ctrl", "shift"],
        code: "KeyA",
      });
    });
  });
});
