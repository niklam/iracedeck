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
