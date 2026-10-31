import type { CalloutSettingKey } from "@iracedeck/callout-settings";
import { OpponentPenaltyFlag } from "@iracedeck/event-bus";
import { type GlobalSettings, GlobalSettingsSchema, isCalloutEnabled } from "@iracedeck/settings";
import {
  CORNER_CALLOUT_DEFAULT_LEAD_SECONDS,
  CORNER_CALLOUT_LEAD_MAX_SECONDS,
  CORNER_CALLOUT_LEAD_MIN_SECONDS,
  FUEL_CALLOUT_DEFAULT_MARGIN_LAPS,
  FUEL_CALLOUT_MARGIN_MAX_LAPS,
  FUEL_CALLOUT_MARGIN_MIN_LAPS,
  GAP_ALERT_THRESHOLD_MAX_S,
  GAP_ALERT_THRESHOLD_MIN_S,
  GAP_DEFAULT_ALERT_THRESHOLD_S,
  GAP_DEFAULT_MIN_CHANGE_S,
  GAP_MIN_CHANGE_MAX_S,
  GAP_MIN_CHANGE_MIN_S,
  OPPONENT_FLAG_DEFAULT_RANGE_SECONDS,
  OPPONENT_FLAG_RANGE_MAX_SECONDS,
  OPPONENT_FLAG_RANGE_MIN_SECONDS,
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

/**
 * Each numeric option's settings schema against the translator's own default
 * and clamp bounds for it (#1376). The translator keeps its constants (its
 * fallbacks are its own, and `sim-events-iracing` takes no deck-layer edge),
 * so this table is what keeps the slider the user sees and the clamp the
 * translator applies from drifting apart. A new numeric option is one row
 * here, and the coverage test below fails until it has one.
 */
type NumericSettingBounds = {
  key: keyof GlobalSettings;
  sanitize: (value: unknown) => number;
  fallback: number;
  min: number;
  max: number;
};

const NUMERIC_SETTING_BOUNDS: readonly NumericSettingBounds[] = [
  {
    key: "fuelCalloutMarginLaps",
    sanitize: sanitizeFuelCalloutMarginLaps,
    fallback: FUEL_CALLOUT_DEFAULT_MARGIN_LAPS,
    min: FUEL_CALLOUT_MARGIN_MIN_LAPS,
    max: FUEL_CALLOUT_MARGIN_MAX_LAPS,
  },
  {
    key: "cornerCalloutLeadSeconds",
    sanitize: sanitizeCornerCalloutLeadSeconds,
    fallback: CORNER_CALLOUT_DEFAULT_LEAD_SECONDS,
    min: CORNER_CALLOUT_LEAD_MIN_SECONDS,
    max: CORNER_CALLOUT_LEAD_MAX_SECONDS,
  },
  {
    key: "gapAlertThresholdSeconds",
    sanitize: sanitizeGapAlertThresholdSeconds,
    fallback: GAP_DEFAULT_ALERT_THRESHOLD_S,
    min: GAP_ALERT_THRESHOLD_MIN_S,
    max: GAP_ALERT_THRESHOLD_MAX_S,
  },
  {
    key: "gapCalloutMinChangeSeconds",
    sanitize: sanitizeGapMinChangeSeconds,
    fallback: GAP_DEFAULT_MIN_CHANGE_S,
    min: GAP_MIN_CHANGE_MIN_S,
    max: GAP_MIN_CHANGE_MAX_S,
  },
  {
    key: "opponentFlagRangeSeconds",
    sanitize: sanitizeOpponentFlagRangeSeconds,
    fallback: OPPONENT_FLAG_DEFAULT_RANGE_SECONDS,
    min: OPPONENT_FLAG_RANGE_MIN_SECONDS,
    max: OPPONENT_FLAG_RANGE_MAX_SECONDS,
  },
];

/**
 * How far past a bound the "just outside" probes sit. Small enough that a
 * bound moved by any slider step (0.1 at the finest) puts the probe on the
 * other side of it.
 */
const OUTSIDE = 0.001;

/** What the settings schema stores for `key` when the persisted file holds `value`. */
function parsed(key: keyof GlobalSettings, value: unknown): unknown {
  return GlobalSettingsSchema.parse({ [key]: value })[key];
}

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

describe("numeric Race Engineer settings against the translator's bounds (#1376)", () => {
  it("has a bounds row for every numeric translator option, with the same sanitizer and default", () => {
    expect(NUMERIC_SETTING_BOUNDS.map(({ key }) => key).sort()).toEqual(NUMERIC_OPTIONS.map(([, key]) => key).sort());

    for (const [option, key, sanitize, fallback] of NUMERIC_OPTIONS) {
      const row = NUMERIC_SETTING_BOUNDS.find((bounds) => bounds.key === key);

      expect(row?.sanitize, `${option}'s sanitizer`).toBe(sanitize);
      expect(row?.fallback, `${option}'s default`).toBe(fallback);
    }
  });

  it.each(NUMERIC_SETTING_BOUNDS)("$key defaults to the translator's default", ({ key, sanitize, fallback }) => {
    expect(GlobalSettingsSchema.parse({})[key], "the schema's default").toBe(fallback);
    expect(sanitize(undefined), "the sanitizer's default").toBe(fallback);
  });

  it.each(NUMERIC_SETTING_BOUNDS)(
    "$key accepts exactly the translator's clamp range",
    ({ key, sanitize, fallback, min, max }) => {
      // Out of range the schema's `.catch` answers the default, so a probe
      // past a bound only tells "rejected" from "kept" while the default
      // sits strictly inside the range.
      expect(fallback, "the default lies strictly inside the range").toBeGreaterThan(min);
      expect(fallback, "the default lies strictly inside the range").toBeLessThan(max);

      expect(parsed(key, min), "the schema keeps the minimum").toBe(min);
      expect(parsed(key, max), "the schema keeps the maximum").toBe(max);
      expect(sanitize(min), "the sanitizer keeps the minimum").toBe(min);
      expect(sanitize(max), "the sanitizer keeps the maximum").toBe(max);

      expect(parsed(key, min - OUTSIDE), "the schema falls back to the default just below the minimum").toBe(fallback);
      expect(parsed(key, max + OUTSIDE), "the schema falls back to the default just above the maximum").toBe(fallback);
      expect(sanitize(min - OUTSIDE), "the sanitizer clamps just below the minimum to it").toBe(min);
      expect(sanitize(max + OUTSIDE), "the sanitizer clamps just above the maximum to it").toBe(max);
    },
  );
});
