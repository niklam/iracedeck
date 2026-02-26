import { beforeEach, describe, expect, it, vi } from "vitest";

import { formatSessionTime, generateSessionInfoSvg, SessionInfo } from "./session-info.js";

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
    updateKeyImage = vi.fn().mockResolvedValue(true);
    async onWillDisappear() {}
  },
  createSDLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  })),
  LogLevel: { Info: 2 },
  renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
    return `<svg>${data.backgroundColor || ""}|${data.titleLabel || ""}|${data.value || ""}|${data.valueFontSize || ""}|${data.valueY || ""}</svg>`;
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

describe("SessionInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("formatSessionTime", () => {
    it("should format hours, minutes, and seconds", () => {
      expect(formatSessionTime(3661)).toBe("1:01:01");
    });

    it("should format exactly one hour", () => {
      expect(formatSessionTime(3600)).toBe("1:00:00");
    });

    it("should format minutes and seconds without hours", () => {
      expect(formatSessionTime(754)).toBe("12:34");
    });

    it("should format seconds under a minute", () => {
      expect(formatSessionTime(45)).toBe("0:45");
    });

    it("should format zero", () => {
      expect(formatSessionTime(0)).toBe("0:00");
    });

    it("should handle fractional seconds by flooring", () => {
      expect(formatSessionTime(90.7)).toBe("1:30");
    });

    it("should handle negative values", () => {
      expect(formatSessionTime(-10)).toBe("0:00");
    });

    it("should handle Infinity", () => {
      expect(formatSessionTime(Infinity)).toBe("0:00");
    });

    it("should handle NaN", () => {
      expect(formatSessionTime(NaN)).toBe("0:00");
    });

    it("should pad seconds correctly", () => {
      expect(formatSessionTime(61)).toBe("1:01");
    });

    it("should pad minutes in hour format", () => {
      expect(formatSessionTime(3605)).toBe("1:00:05");
    });
  });

  describe("generateSessionInfoSvg", () => {
    it("should generate a valid data URI for incidents mode", () => {
      const result = generateSessionInfoSvg({ mode: "incidents" }, "3x", false);

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for time-remaining mode", () => {
      const result = generateSessionInfoSvg({ mode: "time-remaining" }, "12:34", false);

      expect(result).toContain("data:image/svg+xml");
    });

    it("should use INCIDENTS title for incidents mode", () => {
      const result = generateSessionInfoSvg({ mode: "incidents" }, "0x", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("INCIDENTS");
    });

    it("should use TIME LEFT title for time-remaining mode", () => {
      const result = generateSessionInfoSvg({ mode: "time-remaining" }, "5:00", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("TIME LEFT");
    });

    it("should use font size 24 for incidents mode", () => {
      const result = generateSessionInfoSvg({ mode: "incidents" }, "0x", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("24");
    });

    it("should use font size 18 for short time values", () => {
      const result = generateSessionInfoSvg({ mode: "time-remaining" }, "12:34", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("18");
    });

    it("should use font size 14 for long time values (H:MM:SS)", () => {
      const result = generateSessionInfoSvg({ mode: "time-remaining" }, "1:23:45", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("14");
    });

    it("should use font size 18 for UNLIM", () => {
      const result = generateSessionInfoSvg({ mode: "time-remaining" }, "UNLIM", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("18");
    });

    it("should use default background when not flashing", () => {
      const result = generateSessionInfoSvg({ mode: "incidents" }, "0x", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("#2a3444");
    });

    it("should use red background when flashing", () => {
      const result = generateSessionInfoSvg({ mode: "incidents" }, "2x", true);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("#e74c3c");
    });

    it("should include the value in the output", () => {
      const result = generateSessionInfoSvg({ mode: "incidents" }, "5x", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("5x");
    });

    it("should produce different outputs for different modes", () => {
      const incidents = generateSessionInfoSvg({ mode: "incidents" }, "0x", false);
      const time = generateSessionInfoSvg({ mode: "time-remaining" }, "0:00", false);

      expect(incidents).not.toBe(time);
    });

    it("should use LAPS title for laps mode", () => {
      const result = generateSessionInfoSvg({ mode: "laps" }, "5/20", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("LAPS");
    });

    it("should use font size 18 for short lap values", () => {
      const result = generateSessionInfoSvg({ mode: "laps" }, "5/20", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("18");
    });

    it("should use font size 14 for long lap values", () => {
      const result = generateSessionInfoSvg({ mode: "laps" }, "100/200", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("14");
    });

    it("should include infinity symbol for unlimited laps", () => {
      const result = generateSessionInfoSvg({ mode: "laps" }, "5/\u221E", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("\u221E");
    });
  });

  describe("telemetry-aware lifecycle", () => {
    let action: SessionInfo;

    beforeEach(() => {
      action = new SessionInfo();
    });

    it("should subscribe with telemetry callback on onWillAppear", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "incidents" }) as any);

      expect(action["sdkController"].subscribe).toHaveBeenCalledWith("action-1", expect.any(Function));
    });

    it("should clean up all maps on onWillDisappear", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "incidents" }) as any);
      await action.onWillDisappear(fakeEvent("action-1") as any);

      expect(action["sdkController"].unsubscribe).toHaveBeenCalledWith("action-1");
      expect(action["activeContexts"].has("action-1")).toBe(false);
      expect(action["lastState"].has("action-1")).toBe(false);
      expect(action["lastIncidentCount"].has("action-1")).toBe(false);
      expect(action["flashStates"].has("action-1")).toBe(false);
    });

    it("should update activeContexts on onDidReceiveSettings", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "incidents" }) as any);
      await action.onDidReceiveSettings(fakeEvent("action-1", { mode: "time-remaining" }) as any);

      expect(action["activeContexts"].get("action-1")).toEqual({
        mode: "time-remaining",
      });
    });

    it("should cancel flash on onDidReceiveSettings", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "incidents" }) as any);

      // Simulate a flash state
      action["flashStates"].set("action-1", true);

      await action.onDidReceiveSettings(fakeEvent("action-1", { mode: "time-remaining" }) as any);

      expect(action["flashStates"].get("action-1")).toBe(false);
    });

    it("should use default settings when settings are invalid", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "invalid" }) as any);

      expect(action["activeContexts"].get("action-1")).toEqual({
        mode: "incidents",
      });
    });
  });
});
