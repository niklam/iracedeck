import { beforeEach, describe, expect, it, vi } from "vitest";

import { CAR_CONTROL_GLOBAL_KEYS, generateCarControlSvg } from "./car-control.js";

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
  getGlobalSettings: vi.fn(() => ({})),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  LogLevel: { Info: 2 },
  parseKeyBinding: vi.fn(),
  renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
    return `<svg>${data.iconContent || ""}${data.labelLine1 || ""}${data.labelLine2 || ""}</svg>`;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

describe("CarControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("CAR_CONTROL_GLOBAL_KEYS", () => {
    it("should have correct mapping for starter", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["starter"]).toBe("carControlStarter");
    });

    it("should have correct mapping for ignition", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["ignition"]).toBe("carControlIgnition");
    });

    it("should have correct mapping for pit-speed-limiter", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["pit-speed-limiter"]).toBe("carControlPitSpeedLimiter");
    });

    it("should have correct mapping for enter-exit-tow", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["enter-exit-tow"]).toBe("carControlEnterExitTow");
    });

    it("should have correct mapping for pause-sim", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["pause-sim"]).toBe("carControlPauseSim");
    });

    it("should have exactly 5 entries", () => {
      expect(Object.keys(CAR_CONTROL_GLOBAL_KEYS)).toHaveLength(5);
    });
  });

  describe("generateCarControlSvg", () => {
    it("should generate a valid data URI for starter", () => {
      const result = generateCarControlSvg({ control: "starter" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for ignition", () => {
      const result = generateCarControlSvg({ control: "ignition" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all controls", () => {
      const controls = [
        "starter",
        "ignition",
        "pit-speed-limiter",
        "enter-exit-tow",
        "pause-sim",
      ] as const;

      for (const control of controls) {
        const result = generateCarControlSvg({ control });
        expect(result).toContain("data:image/svg+xml");
      }
    });

    it("should produce different icons for different controls", () => {
      const starter = generateCarControlSvg({ control: "starter" });
      const ignition = generateCarControlSvg({ control: "ignition" });

      expect(starter).not.toBe(ignition);
    });

    it("should include STARTER label for starter control", () => {
      const result = generateCarControlSvg({ control: "starter" });

      expect(decodeURIComponent(result)).toContain("STARTER");
    });

    it("should include IGNITION label for ignition control", () => {
      const result = generateCarControlSvg({ control: "ignition" });

      expect(decodeURIComponent(result)).toContain("IGNITION");
    });

    it("should include CONTROL label for starter control", () => {
      const result = generateCarControlSvg({ control: "starter" });

      expect(decodeURIComponent(result)).toContain("CONTROL");
    });

    it("should include correct labels for all controls", () => {
      const expectedLabels: Record<string, { line1: string; line2: string }> = {
        starter: { line1: "STARTER", line2: "CONTROL" },
        ignition: { line1: "IGNITION", line2: "CONTROL" },
        "pit-speed-limiter": { line1: "PIT SPEED", line2: "LIMITER" },
        "enter-exit-tow": { line1: "ENTER/EXIT", line2: "TOW CAR" },
        "pause-sim": { line1: "PAUSE", line2: "SIM" },
      };

      for (const [control, labels] of Object.entries(expectedLabels)) {
        const result = generateCarControlSvg({ control: control as any });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.line1);
        expect(decoded).toContain(labels.line2);
      }
    });
  });
});
