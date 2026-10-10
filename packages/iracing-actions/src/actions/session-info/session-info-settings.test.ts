import { describe, expect, it, vi } from "vitest";

import { SessionInfoSettings } from "./session-info-settings.js";

// Real zod semantics for the extended schema: the parsing under test is the
// schema's own, not a stand-in's.
vi.mock("@iracedeck/deck-core", async () => {
  const { z } = await import("zod");

  return {
    CommonSettings: { extend: (shape: never) => z.object(shape).passthrough() },
  };
});

describe("Session Info settings — fuelLapWindow", () => {
  const windowOf = (fuelLapWindow: unknown): number => SessionInfoSettings.parse({ fuelLapWindow }).fuelLapWindow;

  it("a blank or missing window is the default five laps", () => {
    expect(windowOf("")).toBe(5);
    expect(windowOf(undefined)).toBe(5);
    expect(windowOf(null)).toBe(5);
  });

  it("reads the PI's string and a persisted number alike", () => {
    expect(windowOf("10")).toBe(10);
    expect(windowOf(10)).toBe(10);
  });

  it("clamps to one lap at the bottom and the translator's history cap at the top", () => {
    expect(windowOf(0)).toBe(1);
    expect(windowOf(-3)).toBe(1);
    expect(windowOf(25)).toBe(20);
  });

  it("rounds a hand-typed decimal to whole laps", () => {
    expect(windowOf(4.6)).toBe(5);
    expect(windowOf("7.4")).toBe(7);
  });

  it("an unreadable window falls back to the default", () => {
    expect(windowOf("abc")).toBe(5);
  });

  it("a bad window never fails the whole parse — the key keeps its other settings", () => {
    const parsed = SessionInfoSettings.safeParse({ mode: "fuel", fuelSubMode: "avgN", fuelLapWindow: "abc" });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ mode: "fuel", fuelSubMode: "avgN", fuelLapWindow: 5 });
  });
});

describe("Session Info settings — Tire Temperatures (issue #254)", () => {
  it("is a mode of its own", () => {
    expect(SessionInfoSettings.parse({ mode: "tire-temps" }).mode).toBe("tire-temps");
  });

  it("defaults to all four tires, the weighted center and colors on, in Celsius", () => {
    expect(SessionInfoSettings.parse({})).toMatchObject({
      tireTempCorner: "all",
      tireTempMethod: "weighted",
      tireTempColors: true,
      tireTempThresholdUnit: "c",
    });
  });

  it("each threshold unit has its own default set", () => {
    expect(SessionInfoSettings.parse({})).toMatchObject({
      tireTempColdBelow: 75,
      tireTempHotAbove: 90,
      tireTempCriticalAbove: 100,
      tireTempColdBelowF: 165,
      tireTempHotAboveF: 195,
      tireTempCriticalAboveF: 210,
    });
  });

  it("reads the color checkbox as a boolean or the PI's string", () => {
    expect(SessionInfoSettings.parse({ tireTempColors: false }).tireTempColors).toBe(false);
    expect(SessionInfoSettings.parse({ tireTempColors: "false" }).tireTempColors).toBe(false);
    expect(SessionInfoSettings.parse({ tireTempColors: "true" }).tireTempColors).toBe(true);
  });

  it("reads a threshold from the PI's string and a persisted number alike, decimals kept", () => {
    expect(SessionInfoSettings.parse({ tireTempColdBelow: "68" }).tireTempColdBelow).toBe(68);
    expect(SessionInfoSettings.parse({ tireTempHotAbove: 92.5 }).tireTempHotAbove).toBe(92.5);
    expect(SessionInfoSettings.parse({ tireTempCriticalAboveF: "221.5" }).tireTempCriticalAboveF).toBe(221.5);
  });

  it("a blank threshold is its default, never zero", () => {
    expect(SessionInfoSettings.parse({ tireTempColdBelow: "" }).tireTempColdBelow).toBe(75);
    expect(SessionInfoSettings.parse({ tireTempHotAbove: "  " }).tireTempHotAbove).toBe(90);
    expect(SessionInfoSettings.parse({ tireTempCriticalAbove: null }).tireTempCriticalAbove).toBe(100);
    expect(SessionInfoSettings.parse({ tireTempColdBelowF: undefined }).tireTempColdBelowF).toBe(165);
  });

  it("keeps an out-of-order set exactly as typed", () => {
    expect(
      SessionInfoSettings.parse({ tireTempColdBelow: 110, tireTempHotAbove: 60, tireTempCriticalAbove: 40 }),
    ).toMatchObject({ tireTempColdBelow: 110, tireTempHotAbove: 60, tireTempCriticalAbove: 40 });
  });

  it("switching the threshold unit changes neither stored set", () => {
    const stored = {
      tireTempColdBelow: 70,
      tireTempHotAbove: 95,
      tireTempCriticalAbove: 110,
      tireTempColdBelowF: 160,
      tireTempHotAboveF: 200,
      tireTempCriticalAboveF: 230,
    };

    expect(SessionInfoSettings.parse({ ...stored, tireTempThresholdUnit: "c" })).toMatchObject(stored);
    expect(SessionInfoSettings.parse({ ...stored, tireTempThresholdUnit: "f" })).toMatchObject(stored);
  });

  it("a malformed threshold falls back alone — the key keeps its other settings", () => {
    const parsed = SessionInfoSettings.safeParse({
      mode: "tire-temps",
      tireTempCorner: "rf",
      tireTempMethod: "max",
      tireTempColors: "false",
      tireTempThresholdUnit: "f",
      tireTempColdBelow: 70,
      tireTempHotAbove: "abc",
      tireTempCriticalAboveF: "NaN",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      mode: "tire-temps",
      tireTempCorner: "rf",
      tireTempMethod: "max",
      tireTempColors: false,
      tireTempThresholdUnit: "f",
      tireTempColdBelow: 70,
      tireTempHotAbove: 90,
      tireTempCriticalAboveF: 210,
    });
  });
});
