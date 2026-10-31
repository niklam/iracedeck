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

type TranslatorOptions = ReturnType<typeof createIracingTranslatorOptions>;

/**
 * The one translator option that is not a number read from a setting: the
 * opponent-flag gate, a lookup over the callout opt-ins, tested on its own
 * below. Every other option the translator takes is a numeric setting, and
 * has a row in {@link NUMERIC_OPTIONS}.
 */
const NON_NUMERIC_OPTION = "getOpponentFlagCalloutEnabled" satisfies keyof TranslatorOptions;

type NumericOption = Exclude<keyof TranslatorOptions, typeof NON_NUMERIC_OPTION>;

/**
 * One row per numeric translator option: the option, the settings key it
 * reads, the translator's sanitizer it must run that key through, the
 * sanitizer's default when the key is missing, and the translator's clamp
 * bounds. The translator keeps its constants (its fallbacks are its own, and
 * `sim-events-iracing` takes no deck-layer edge), so this table is what ties
 * the option to its key and keeps the slider the user sees and the clamp the
 * translator applies from drifting apart (#1376). Every test below iterates
 * it, and the first one compares it against what
 * `createIracingTranslatorOptions()` actually builds, so a new numeric option
 * fails until it has a row here.
 */
type NumericOptionRow = {
  option: NumericOption;
  key: keyof GlobalSettings;
  sanitize: (value: unknown) => number;
  fallback: number;
  min: number;
  max: number;
};

const NUMERIC_OPTIONS: readonly NumericOptionRow[] = [
  {
    option: "getFuelLapsLeftMarginLaps",
    key: "fuelCalloutMarginLaps",
    sanitize: sanitizeFuelCalloutMarginLaps,
    fallback: FUEL_CALLOUT_DEFAULT_MARGIN_LAPS,
    min: FUEL_CALLOUT_MARGIN_MIN_LAPS,
    max: FUEL_CALLOUT_MARGIN_MAX_LAPS,
  },
  {
    option: "getCornerCalloutLeadSeconds",
    key: "cornerCalloutLeadSeconds",
    sanitize: sanitizeCornerCalloutLeadSeconds,
    fallback: CORNER_CALLOUT_DEFAULT_LEAD_SECONDS,
    min: CORNER_CALLOUT_LEAD_MIN_SECONDS,
    max: CORNER_CALLOUT_LEAD_MAX_SECONDS,
  },
  {
    option: "getGapAlertThresholdSeconds",
    key: "gapAlertThresholdSeconds",
    sanitize: sanitizeGapAlertThresholdSeconds,
    fallback: GAP_DEFAULT_ALERT_THRESHOLD_S,
    min: GAP_ALERT_THRESHOLD_MIN_S,
    max: GAP_ALERT_THRESHOLD_MAX_S,
  },
  {
    option: "getGapMinChangeSeconds",
    key: "gapCalloutMinChangeSeconds",
    sanitize: sanitizeGapMinChangeSeconds,
    fallback: GAP_DEFAULT_MIN_CHANGE_S,
    min: GAP_MIN_CHANGE_MIN_S,
    max: GAP_MIN_CHANGE_MAX_S,
  },
  {
    option: "getOpponentFlagRangeSeconds",
    key: "opponentFlagRangeSeconds",
    sanitize: sanitizeOpponentFlagRangeSeconds,
    fallback: OPPONENT_FLAG_DEFAULT_RANGE_SECONDS,
    min: OPPONENT_FLAG_RANGE_MIN_SECONDS,
    max: OPPONENT_FLAG_RANGE_MAX_SECONDS,
  },
];

/**
 * Stored values a slider's setting can hold: missing, malformed, far above
 * any clamp, a fraction, and a number stored as a string. Each option must
 * answer exactly what its sanitizer answers for every one of them.
 */
const PROBES: readonly unknown[] = [undefined, "not a number", 1e9, -1, 0.75, "2"];

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

  it("builds the opponent-flag gate and exactly one option per numeric row, so none runs at its default", () => {
    const options = createIracingTranslatorOptions();
    const rows = NUMERIC_OPTIONS.map(({ option }) => option);

    expect(new Set(rows).size, "no option has two rows").toBe(rows.length);
    expect(new Set(NUMERIC_OPTIONS.map(({ key }) => key)).size, "no two rows read one key").toBe(rows.length);
    expect(
      Object.keys(options).sort(),
      `every option createIracingTranslatorOptions() builds other than ${NON_NUMERIC_OPTION} is numeric ` +
        `and needs a row in NUMERIC_OPTIONS: its settings key, the translator's sanitizer, default and clamp bounds`,
    ).toEqual([NON_NUMERIC_OPTION, ...rows].sort());

    for (const [option, value] of Object.entries(options)) expect(typeof value, option).toBe("function");
  });

  it.each(NUMERIC_OPTIONS)(
    "$option reads $key live and runs it through the translator's sanitizer",
    ({ option, key, sanitize, fallback }) => {
      const read = createIracingTranslatorOptions()[option];

      expect(read(), "missing: the sanitizer's default").toBe(fallback);

      for (const probe of PROBES) {
        stored.current = { [key]: probe };
        expect(read(), `stored ${String(probe)}`).toBe(sanitize(probe));
      }
    },
  );

  it("reads a numeric option from its own key and no other", () => {
    for (const { option, key, sanitize, fallback } of NUMERIC_OPTIONS) {
      const read = createIracingTranslatorOptions()[option];
      const others = Object.fromEntries(NUMERIC_OPTIONS.filter((row) => row.key !== key).map((row) => [row.key, 1e9]));

      stored.current = others;
      expect(read(), `${option} with every other key set and its own missing`).toBe(fallback);
      stored.current = { ...others, [key]: 0.75 };
      expect(read(), `${option} follows ${key}`).toBe(sanitize(0.75));
    }
  });

  it("hands the translator the exported opponent-flag gate itself", () => {
    expect(createIracingTranslatorOptions()[NON_NUMERIC_OPTION]).toBe(isOpponentFlagCalloutEnabled);
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
  it.each(NUMERIC_OPTIONS)("$key defaults to the translator's default", ({ key, sanitize, fallback }) => {
    expect(GlobalSettingsSchema.parse({})[key], "the schema's default").toBe(fallback);
    expect(sanitize(undefined), "the sanitizer's default").toBe(fallback);
  });

  it.each(NUMERIC_OPTIONS)(
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
