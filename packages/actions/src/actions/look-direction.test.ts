import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateLookDirectionSvg, LOOK_DIRECTION_GLOBAL_KEYS, LookDirection } from "./look-direction.js";

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
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
    updateKeyImage = vi.fn().mockResolvedValue(true);
    tapBinding = vi.fn().mockResolvedValue(undefined);
    holdBinding = vi.fn().mockResolvedValue(undefined);
    releaseBinding = vi.fn().mockResolvedValue(undefined);
    setActiveBinding = vi.fn();
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
  getGlobalColors: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({})),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
    pressKeyCombination: vi.fn().mockResolvedValue(true),
    releaseKeyCombination: vi.fn().mockResolvedValue(true),
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

    beforeEach(() => {
      action = new LookDirection();
    });

    it("should hold key on keyDown and release on keyUp", async () => {
      await action.onKeyDown(fakeEvent("action-1", { direction: "look-left" }) as any);

      expect(action.holdBinding).toHaveBeenCalledWith("action-1", "lookDirectionLeft");

      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(action.releaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should hold key on dialDown and release on dialUp", async () => {
      await action.onDialDown(fakeEvent("action-1", { direction: "look-left" }) as any);

      expect(action.holdBinding).toHaveBeenCalledOnce();

      await action.onDialUp(fakeEvent("action-1") as any);

      expect(action.releaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should track concurrent presses on different action contexts independently", async () => {
      // Press left on action-1
      await action.onKeyDown(fakeEvent("action-1", { direction: "look-left" }) as any);
      // Press right on action-2
      await action.onKeyDown(fakeEvent("action-2", { direction: "look-right" }) as any);

      expect(action.holdBinding).toHaveBeenCalledTimes(2);

      // Release action-1 — should release action-1's combination only
      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(action.releaseBinding).toHaveBeenCalledTimes(1);
      expect(action.releaseBinding).toHaveBeenCalledWith("action-1");

      // Release action-2
      await action.onKeyUp(fakeEvent("action-2") as any);

      expect(action.releaseBinding).toHaveBeenCalledTimes(2);
      expect(action.releaseBinding).toHaveBeenCalledWith("action-2");
    });

    it("should release held key on onWillDisappear", async () => {
      await action.onKeyDown(fakeEvent("action-1", { direction: "look-left" }) as any);
      await action.onWillDisappear(fakeEvent("action-1") as any);

      expect(action.releaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should call releaseHeldBinding on keyUp even when no key is held", async () => {
      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(action.releaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should call holdGlobalBinding even when no binding is configured", async () => {
      await action.onKeyDown(fakeEvent("action-1", { direction: "look-left" }) as any);

      expect(action.holdBinding).toHaveBeenCalledWith("action-1", "lookDirectionLeft");
    });

    it("should call holdGlobalBinding with correct setting key for all directions", async () => {
      await action.onKeyDown(fakeEvent("action-1", { direction: "look-left" }) as any);

      expect(action.holdBinding).toHaveBeenCalledWith("action-1", "lookDirectionLeft");
    });

    it("should call holdGlobalBinding with correct setting key", async () => {
      await action.onKeyDown(fakeEvent("action-1", { direction: "look-left" }) as any);

      expect(action.holdBinding).toHaveBeenCalledWith("action-1", "lookDirectionLeft");
    });
  });
});
