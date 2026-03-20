import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateTelemetryControlSvg, TELEMETRY_CONTROL_GLOBAL_KEYS } from "./telemetry-control.js";

vi.mock("@iracedeck/icons/telemetry-control/toggle-logging.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/telemetry-control/mark-event.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/telemetry-control/start-recording.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/telemetry-control/stop-recording.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/telemetry-control/restart-recording.svg", () => ({
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
  },
  formatKeyBinding: vi.fn((b: { key: string; modifiers: string[] }) => {
    if (b.modifiers?.length) {
      return `${b.modifiers.join("+")}+${b.key}`;
    }

    return b.key;
  }),
  getCommands: vi.fn(() => ({
    telem: {
      start: vi.fn(() => true),
      stop: vi.fn(() => true),
      restart: vi.fn(() => true),
    },
  })),
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

const ALL_ACTIONS = [
  "toggle-logging",
  "mark-event",
  "start-recording",
  "stop-recording",
  "restart-recording",
] as const;

describe("TelemetryControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("TELEMETRY_CONTROL_GLOBAL_KEYS", () => {
    it("should have exactly 2 keyboard-based actions", () => {
      expect(Object.keys(TELEMETRY_CONTROL_GLOBAL_KEYS)).toHaveLength(2);
    });

    it("should have correct mapping for toggle-logging", () => {
      expect(TELEMETRY_CONTROL_GLOBAL_KEYS["toggle-logging"]).toBe("telemetryControlToggleLogging");
    });

    it("should have correct mapping for mark-event", () => {
      expect(TELEMETRY_CONTROL_GLOBAL_KEYS["mark-event"]).toBe("telemetryControlMarkEvent");
    });

    it("should use telemetryControl prefix for all global keys", () => {
      for (const [_action, key] of Object.entries(TELEMETRY_CONTROL_GLOBAL_KEYS)) {
        expect(key).toMatch(/^telemetryControl/);
      }
    });

    it("should have unique global keys for all actions", () => {
      const values = Object.values(TELEMETRY_CONTROL_GLOBAL_KEYS);
      const uniqueValues = new Set(values);

      expect(uniqueValues.size).toBe(values.length);
    });
  });

  describe("generateTelemetryControlSvg", () => {
    it("should generate a valid data URI for toggle-logging", () => {
      const result = generateTelemetryControlSvg({ action: "toggle-logging" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all 5 actions", () => {
      for (const action of ALL_ACTIONS) {
        const result = generateTelemetryControlSvg({ action });

        expect(result).toContain("data:image/svg+xml");
      }
    });

    it("should produce different icons for different actions", () => {
      const toggleLogging = generateTelemetryControlSvg({ action: "toggle-logging" });
      const markEvent = generateTelemetryControlSvg({ action: "mark-event" });

      expect(toggleLogging).not.toBe(markEvent);
    });

    it("should include correct labels for toggle-logging", () => {
      const result = generateTelemetryControlSvg({ action: "toggle-logging" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("LOGGING");
      expect(decoded).toContain("TOGGLE");
    });

    it("should include correct labels for mark-event", () => {
      const result = generateTelemetryControlSvg({ action: "mark-event" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("MARK");
      expect(decoded).toContain("EVENT");
    });

    it("should include correct labels for all actions", () => {
      const expectedLabels: Record<string, { mainLabel: string; subLabel: string }> = {
        "toggle-logging": { mainLabel: "LOGGING", subLabel: "TOGGLE" },
        "mark-event": { mainLabel: "MARK", subLabel: "EVENT" },
        "start-recording": { mainLabel: "RECORDING", subLabel: "START" },
        "stop-recording": { mainLabel: "RECORDING", subLabel: "STOP" },
        "restart-recording": { mainLabel: "RECORDING", subLabel: "RESTART" },
      };

      for (const [action, labels] of Object.entries(expectedLabels)) {
        const result = generateTelemetryControlSvg({
          action: action as (typeof ALL_ACTIONS)[number],
        });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.mainLabel);
        expect(decoded).toContain(labels.subLabel);
      }
    });
  });
});
