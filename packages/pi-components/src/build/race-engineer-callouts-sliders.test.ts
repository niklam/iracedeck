import { GlobalSettingsSchema } from "@iracedeck/settings";
import ejs from "ejs";
import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

import { loadCalloutPiGroups } from "./callout-pi-groups.mjs";

/**
 * The settings window's Callouts card writes the Race Engineer's numeric
 * settings through `<ird-range-input … global>` sliders whose `min`, `max`
 * and `default` attributes are written by hand in
 * `partials/race-engineer-callouts.ejs` — a third copy of each range and
 * default, beside the settings schema and the translator's constants
 * (`race-engineer-wiring`'s `translator-options.test.ts` ties those two). This
 * holds every slider in the card to the schema (#1376): its default is the
 * schema's, and its ends are exactly the bounds the schema accepts.
 *
 * The three plugins' `settings-window.html` are compiled from
 * `iracing-actions`' `settings-window.ejs`, which includes this partial on
 * every platform, so rendering the partial covers what each of them ships.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");
const settingsWindowTemplate = path.resolve(
  partialsDir,
  "../../iracing-actions/src/actions/settings-window/settings-window.ejs",
);

/** The numeric settings the translator also clamps; the card must render a slider for each. */
const TRANSLATOR_CLAMPED = [
  "fuelCalloutMarginLaps",
  "cornerCalloutLeadSeconds",
  "gapAlertThresholdSeconds",
  "gapCalloutMinChangeSeconds",
  "opponentFlagRangeSeconds",
] as const;

/**
 * How far past a slider's end the "just outside" probes sit: small enough
 * that a bound moved by any slider step (0.1 at the finest) puts the probe on
 * the other side of it.
 */
const OUTSIDE = 0.001;

type Slider = { setting: string; attributes: ReadonlyMap<string, string | true> };

function renderCard(): string {
  const calloutPiGroups = loadCalloutPiGroups().groups;

  return ejs.render(
    "<%- include('race-engineer-callouts') %>",
    { calloutPiGroups },
    { views: [partialsDir], filename: path.join(partialsDir, "_test.ejs") },
  );
}

/** Every global `<ird-range-input>` in `html`, with its attributes (a bare one maps to `true`). */
function globalSliders(html: string): Slider[] {
  return [...html.matchAll(/<ird-range-input\b([^>]*)>/g)]
    .map(([, body]) => {
      const attributes = new Map<string, string | true>();

      for (const [, name, value] of body.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attributes.set(name, value ?? true);

      return { setting: String(attributes.get("setting")), attributes };
    })
    .filter(({ attributes }) => attributes.has("global"));
}

/** A slider attribute read as the number the component reads it as; a missing one fails, naming it. */
function numberAttribute(slider: Slider, name: string): number {
  const value = slider.attributes.get(name);

  expect(typeof value, `${slider.setting}'s slider sets ${name}="…"`).toBe("string");

  return Number(value);
}

const defaults: Record<string, unknown> = GlobalSettingsSchema.parse({});

/** What the settings schema stores for `key` when the persisted file holds `value`. */
function parsed(key: string, value: unknown): unknown {
  return (GlobalSettingsSchema.parse({ [key]: value }) as Record<string, unknown>)[key];
}

const sliders = globalSliders(renderCard());

describe("race-engineer-callouts sliders against the settings schema (#1376)", () => {
  it("is the partial the settings window ships", () => {
    expect(readFileSync(settingsWindowTemplate, "utf-8")).toContain("include('race-engineer-callouts')");
  });

  it("renders a global slider for each setting the translator also clamps", () => {
    const found = sliders.map(({ setting }) => setting);

    for (const key of TRANSLATOR_CLAMPED) expect(found, `a slider for ${key}`).toContain(key);
  });

  it("writes only numeric settings fields through its global sliders", () => {
    for (const { setting } of sliders) {
      expect(typeof defaults[setting], `${setting} is a numeric GlobalSettingsSchema field`).toBe("number");
    }
  });

  it.each(sliders.map((slider) => [slider.setting, slider] as const))(
    "%s's slider default is the schema's default",
    (key, slider) => {
      expect(numberAttribute(slider, "default"), `${key}'s slider default`).toBe(defaults[key]);
    },
  );

  it.each(sliders.map((slider) => [slider.setting, slider] as const))(
    "%s's slider ends are exactly the bounds the schema accepts",
    (key, slider) => {
      const min = numberAttribute(slider, "min");
      const max = numberAttribute(slider, "max");
      const fallback = defaults[key];

      // Out of range the schema's `.catch` answers the default, so a probe
      // past an end only tells "rejected" from "kept" while the default sits
      // strictly inside the range.
      expect(fallback, "the default lies strictly inside the slider's range").toBeGreaterThan(min);
      expect(fallback, "the default lies strictly inside the slider's range").toBeLessThan(max);

      expect(parsed(key, min), "the schema keeps the slider's minimum").toBe(min);
      expect(parsed(key, max), "the schema keeps the slider's maximum").toBe(max);
      expect(parsed(key, min - OUTSIDE), "the schema rejects just below the slider's minimum").toBe(fallback);
      expect(parsed(key, max + OUTSIDE), "the schema rejects just above the slider's maximum").toBe(fallback);
    },
  );
});
