import { describe, expect, it } from "vitest";

import * as trafficSettings from "./traffic-settings.js";
import {
  sanitizeTrafficPitExitAfterSeconds,
  sanitizeTrafficPitExitBeforeSeconds,
  TRAFFIC_DEFAULT_PIT_EXIT_AFTER_SECONDS,
  TRAFFIC_DEFAULT_PIT_EXIT_BEFORE_SECONDS,
  TRAFFIC_PIT_EXIT_AFTER_MAX_SECONDS,
  TRAFFIC_PIT_EXIT_AFTER_MIN_SECONDS,
  TRAFFIC_PIT_EXIT_BEFORE_MAX_SECONDS,
  TRAFFIC_PIT_EXIT_BEFORE_MIN_SECONDS,
} from "./traffic-settings.js";

const SETTINGS = [
  {
    name: "pit exit before",
    sanitize: sanitizeTrafficPitExitBeforeSeconds,
    min: TRAFFIC_PIT_EXIT_BEFORE_MIN_SECONDS,
    max: TRAFFIC_PIT_EXIT_BEFORE_MAX_SECONDS,
    fallback: TRAFFIC_DEFAULT_PIT_EXIT_BEFORE_SECONDS,
  },
  {
    name: "pit exit after",
    sanitize: sanitizeTrafficPitExitAfterSeconds,
    min: TRAFFIC_PIT_EXIT_AFTER_MIN_SECONDS,
    max: TRAFFIC_PIT_EXIT_AFTER_MAX_SECONDS,
    fallback: TRAFFIC_DEFAULT_PIT_EXIT_AFTER_SECONDS,
  },
] as const;

describe("approaching-traffic setting bounds (#1113)", () => {
  it("are the spec's defaults and slider ranges", () => {
    expect([
      TRAFFIC_PIT_EXIT_BEFORE_MIN_SECONDS,
      TRAFFIC_DEFAULT_PIT_EXIT_BEFORE_SECONDS,
      TRAFFIC_PIT_EXIT_BEFORE_MAX_SECONDS,
    ]).toEqual([0, 2, 10]);
    expect([
      TRAFFIC_PIT_EXIT_AFTER_MIN_SECONDS,
      TRAFFIC_DEFAULT_PIT_EXIT_AFTER_SECONDS,
      TRAFFIC_PIT_EXIT_AFTER_MAX_SECONDS,
    ]).toEqual([0, 4, 15]);
  });

  it("are the pit-exit window's two sides only: rejoin's bands are fixed and the look-ahead is gone (amended 2026-11-11)", () => {
    expect(Object.keys(trafficSettings).sort()).toEqual([
      "TRAFFIC_DEFAULT_PIT_EXIT_AFTER_SECONDS",
      "TRAFFIC_DEFAULT_PIT_EXIT_BEFORE_SECONDS",
      "TRAFFIC_PIT_EXIT_AFTER_MAX_SECONDS",
      "TRAFFIC_PIT_EXIT_AFTER_MIN_SECONDS",
      "TRAFFIC_PIT_EXIT_BEFORE_MAX_SECONDS",
      "TRAFFIC_PIT_EXIT_BEFORE_MIN_SECONDS",
      "sanitizeTrafficPitExitAfterSeconds",
      "sanitizeTrafficPitExitBeforeSeconds",
    ]);
  });
});

describe.each(SETTINGS)("the $name window sanitizer (#1113)", ({ sanitize, min, max, fallback }) => {
  it("keeps an in-range number and parses a numeric string", () => {
    expect(sanitize(min)).toBe(min);
    expect(sanitize(max)).toBe(max);
    expect(sanitize(String(max - 1))).toBe(max - 1);
    expect(sanitize(fallback + 0.5)).toBe(fallback + 0.5);
  });

  it("clamps to the slider's range", () => {
    expect(sanitize(min - 1)).toBe(min);
    expect(sanitize(max + 100)).toBe(max);
    expect(sanitize(-Number.MAX_VALUE)).toBe(min);
  });

  it("falls back to the default for anything unparseable", () => {
    for (const value of ["junk", undefined, Number.NaN, Number.POSITIVE_INFINITY, true, false, {}, [], [3]]) {
      expect(sanitize(value), String(value)).toBe(fallback);
    }
  });

  it("treats a cleared field as missing, never as zero", () => {
    // `Number("")` and `Number(null)` are a finite 0: for the pit-exit sides
    // that is in range and would silently close that side of the window.
    expect(sanitize("")).toBe(fallback);
    expect(sanitize(null)).toBe(fallback);
  });

  it("treats a whitespace-only field as missing, never as zero", () => {
    // `Number(" ")` is a finite 0 too.
    for (const value of [" ", "   ", "\t", "\n "]) expect(sanitize(value), JSON.stringify(value)).toBe(fallback);
  });

  it("keeps a numeric string with spaces round it", () => {
    expect(sanitize(" 1 ")).toBe(1);
  });
});

it("keeps an explicit 0 on a pit-exit side: it closes that side of the window", () => {
  expect(sanitizeTrafficPitExitBeforeSeconds(0)).toBe(0);
  expect(sanitizeTrafficPitExitAfterSeconds("0")).toBe(0);
});
