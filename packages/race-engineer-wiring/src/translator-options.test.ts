import type { CalloutSettingKey } from "@iracedeck/callout-settings";
import { OpponentPenaltyFlag } from "@iracedeck/event-bus";
import { isCalloutEnabled } from "@iracedeck/settings";
import {
  CORNER_CALLOUT_DEFAULT_LEAD_SECONDS,
  FUEL_CALLOUT_DEFAULT_MARGIN_LAPS,
  GAP_DEFAULT_ALERT_THRESHOLD_S,
  GAP_DEFAULT_MIN_CHANGE_S,
  OPPONENT_FLAG_DEFAULT_RANGE_SECONDS,
  sanitizeCornerCalloutLeadSeconds,
  sanitizeFuelCalloutMarginLaps,
  sanitizeGapAlertThresholdSeconds,
  sanitizeGapMinChangeSeconds,
  sanitizeOpponentFlagRangeSeconds,
} from "@iracedeck/sim-events-iracing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIracingTranslatorOptions, isOpponentFlagCalloutEnabled } from "./translator-options.js";

// The settings the closures read, swapped per test. Every option reads
// settings' getGlobalSettings() at call time, so a change applies to an
// already-built option — which is the point of the live-read shape.
const stored = vi.hoisted((): { current: Record<string, unknown> } => ({ current: {} }));

vi.mock("@iracedeck/settings", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGlobalSettings: vi.fn(() => stored.current),
  isCalloutEnabled: vi.fn(() => true),
}));

/**
 * Each bus flag against the settings key that must gate it, written out
 * rather than derived: the meatball arrives as `Repair`, and a mapping that
 * sent it (or any flag) to a sibling's key would silence the wrong callout.
 */
const FLAG_KEYS: readonly (readonly [OpponentPenaltyFlag, CalloutSettingKey])[] = [
  [OpponentPenaltyFlag.Furled, "calloutEnabledOpponentFlagFurled"],
  [OpponentPenaltyFlag.Black, "calloutEnabledOpponentFlagBlack"],
  [OpponentPenaltyFlag.Repair, "calloutEnabledOpponentFlagMeatball"],
  [OpponentPenaltyFlag.Disqualify, "calloutEnabledOpponentFlagDisqualify"],
];

/**
 * The five numeric options: the settings key each reads, the translator's
 * sanitizer it must run that key through, and the sanitizer's default when
 * the key is missing.
 */
const NUMERIC_OPTIONS = [
  [
    "getFuelLapsLeftMarginLaps",
    "fuelCalloutMarginLaps",
    sanitizeFuelCalloutMarginLaps,
    FUEL_CALLOUT_DEFAULT_MARGIN_LAPS,
  ],
  [
    "getCornerCalloutLeadSeconds",
    "cornerCalloutLeadSeconds",
    sanitizeCornerCalloutLeadSeconds,
    CORNER_CALLOUT_DEFAULT_LEAD_SECONDS,
  ],
  [
    "getGapAlertThresholdSeconds",
    "gapAlertThresholdSeconds",
    sanitizeGapAlertThresholdSeconds,
    GAP_DEFAULT_ALERT_THRESHOLD_S,
  ],
  ["getGapMinChangeSeconds", "gapCalloutMinChangeSeconds", sanitizeGapMinChangeSeconds, GAP_DEFAULT_MIN_CHANGE_S],
  [
    "getOpponentFlagRangeSeconds",
    "opponentFlagRangeSeconds",
    sanitizeOpponentFlagRangeSeconds,
    OPPONENT_FLAG_DEFAULT_RANGE_SECONDS,
  ],
] as const;

/**
 * Stored values a slider's setting can hold: missing, malformed, far above
 * any clamp, a fraction, and a number stored as a string. Each option must
 * answer exactly what its sanitizer answers for every one of them.
 */
const PROBES: readonly unknown[] = [undefined, "not a number", 1e9, -1, 0.75, "2"];

describe("createIracingTranslatorOptions", () => {
  beforeEach(() => {
    stored.current = {};
    vi.clearAllMocks();
    vi.mocked(isCalloutEnabled).mockImplementation(() => true);
  });

  it("builds every one of the translator's six options, so none runs at its default", () => {
    const options = createIracingTranslatorOptions();

    expect(Object.keys(options).sort()).toEqual([
      "getCornerCalloutLeadSeconds",
      "getFuelLapsLeftMarginLaps",
      "getGapAlertThresholdSeconds",
      "getGapMinChangeSeconds",
      "getOpponentFlagCalloutEnabled",
      "getOpponentFlagRangeSeconds",
    ]);

    for (const [key, value] of Object.entries(options)) expect(typeof value, key).toBe("function");
  });

  it.each(NUMERIC_OPTIONS)(
    "%s reads %s live and runs it through the translator's sanitizer",
    (option, key, sanitize, fallback) => {
      const read = createIracingTranslatorOptions()[option];

      expect(read(), "missing: the sanitizer's default").toBe(fallback);

      for (const probe of PROBES) {
        stored.current = { [key]: probe };
        expect(read(), `stored ${String(probe)}`).toBe(sanitize(probe));
      }
    },
  );

  it("reads a numeric option from its own key and no other", () => {
    for (const [option, key, sanitize, fallback] of NUMERIC_OPTIONS) {
      const read = createIracingTranslatorOptions()[option];
      const others = Object.fromEntries(NUMERIC_OPTIONS.filter(([, k]) => k !== key).map(([, k]) => [k, 1e9]));

      stored.current = others;
      expect(read(), `${option} with every other key set and its own missing`).toBe(fallback);
      stored.current = { ...others, [key]: 0.75 };
      expect(read(), `${option} follows ${key}`).toBe(sanitize(0.75));
    }
  });

  it("hands the translator the exported opponent-flag gate itself", () => {
    expect(createIracingTranslatorOptions().getOpponentFlagCalloutEnabled).toBe(isOpponentFlagCalloutEnabled);
  });
});

describe("isOpponentFlagCalloutEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isCalloutEnabled).mockImplementation(() => true);
  });

  it("has a row for every opponent penalty flag", () => {
    expect(FLAG_KEYS.map(([flag]) => flag).sort()).toEqual(Object.values(OpponentPenaltyFlag).sort());
  });

  it.each(FLAG_KEYS)("gates the %s opponent flag on %s alone, live", (flag, key) => {
    let off = new Set<unknown>();
    vi.mocked(isCalloutEnabled).mockImplementation((asked) => !off.has(asked));

    expect(isOpponentFlagCalloutEnabled(flag), "every key on").toBe(true);
    off = new Set(FLAG_KEYS.map(([, other]) => other).filter((other) => other !== key));
    expect(isOpponentFlagCalloutEnabled(flag), "every other flag's key off").toBe(true);
    off = new Set([key]);
    expect(isOpponentFlagCalloutEnabled(flag), "its own key off").toBe(false);
    expect(isCalloutEnabled).toHaveBeenLastCalledWith(key);
  });

  it("lets a flag the map does not know through without asking any key (falls open)", () => {
    vi.mocked(isCalloutEnabled).mockImplementation(() => false);

    expect(isOpponentFlagCalloutEnabled("a-flag-added-later" as OpponentPenaltyFlag)).toBe(true);
    expect(isCalloutEnabled).not.toHaveBeenCalled();
  });
});
