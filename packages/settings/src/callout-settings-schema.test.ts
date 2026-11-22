import { CALLOUT_SETTING_KEYS } from "@iracedeck/callout-settings";
import { describe, expect, it } from "vitest";

import { GlobalSettingsSchema } from "./global-settings.js";

describe("callout settings in GlobalSettingsSchema (#1350)", () => {
  it("has a schema field for every registry key", () => {
    const shape = GlobalSettingsSchema.shape as Record<string, unknown>;

    for (const key of CALLOUT_SETTING_KEYS) expect(shape[key], key).toBeDefined();
  });

  it("still passes a retired calloutEnabled key through", () => {
    const parsed = GlobalSettingsSchema.parse({ calloutEnabledFlagOneLapToGreen: false }) as Record<string, unknown>;
    expect(parsed.calloutEnabledFlagOneLapToGreen).toBe(false);
  });
});

describe("the fuel countdown session-kind opt-ins (#1702)", () => {
  const KEYS = [
    "calloutEnabledFuelCountdownRace",
    "calloutEnabledFuelCountdownPractice",
    "calloutEnabledFuelCountdownQualifying",
    "calloutEnabledFuelCountdownTest",
  ] as const;

  it.each(KEYS)("%s defaults to true and keeps a stored false", (key) => {
    const empty = GlobalSettingsSchema.parse({}) as Record<string, unknown>;
    const off = GlobalSettingsSchema.parse({ [key]: false }) as Record<string, unknown>;
    const offString = GlobalSettingsSchema.parse({ [key]: "false" }) as Record<string, unknown>;

    expect(empty[key]).toBe(true);
    expect(off[key]).toBe(false);
    expect(offString[key]).toBe(false);
  });
});
