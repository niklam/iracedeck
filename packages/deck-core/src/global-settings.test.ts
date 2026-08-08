import type { ILogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetGlobalSettings,
  deleteGlobalSettings,
  getGlobalSettings,
  GlobalSettingsSchema,
  initGlobalSettings,
  onGlobalSettingsChange,
  resolveActiveDriverName,
  resolveActiveRaceEngineerVoice,
  updateGlobalSettings,
} from "./global-settings.js";
import type { IDeckPlatformAdapter } from "./types.js";
import { CHANGELOG_NOTIFICATION_POLICIES } from "./version-check.js";

type EchoCallback = (settings: unknown) => void;

function createMockLogger(): ILogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ILogger;
}

interface MockAdapter {
  adapter: IDeckPlatformAdapter;
  echo: EchoCallback | null;
  setGlobalSettings: ReturnType<typeof vi.fn<(settings: Record<string, unknown>) => void>>;
  getGlobalSettings: ReturnType<typeof vi.fn<() => void>>;
}

function createMockAdapter(): MockAdapter {
  const echoHolder: { echo: EchoCallback | null } = { echo: null };
  const setGlobalSettings = vi.fn<(settings: Record<string, unknown>) => void>();
  const getGlobalSettings = vi.fn<() => void>();

  const adapter = {
    onDidReceiveGlobalSettings: (cb: EchoCallback) => {
      echoHolder.echo = cb;
    },
    setGlobalSettings,
    getGlobalSettings,
  } as unknown as IDeckPlatformAdapter;

  return {
    adapter,
    get echo() {
      return echoHolder.echo;
    },
    setGlobalSettings,
    getGlobalSettings,
  };
}

describe("global-settings cache (synchronous update on local writes)", () => {
  let mock: MockAdapter;

  beforeEach(() => {
    _resetGlobalSettings();
    mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger());
  });

  it("updateGlobalSettings reflects the new value on the very next getGlobalSettings call", () => {
    updateGlobalSettings({ pitCrewRadarEnabled: false });

    expect((getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled).toBe(false);
  });

  it("alternates pitCrewRadarEnabled across consecutive local writes without any host echo", () => {
    updateGlobalSettings({ pitCrewRadarEnabled: false });
    expect((getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled).toBe(false);

    updateGlobalSettings({ pitCrewRadarEnabled: true });
    expect((getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled).toBe(true);

    updateGlobalSettings({ pitCrewRadarEnabled: false });
    expect((getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled).toBe(false);

    // No echo has fired yet — the adapter's echo callback was captured
    // but never invoked.
    expect(mock.echo).not.toBeNull();
  });

  it("matches the toggle pattern used by Pit Crew (read → flip → write → read)", () => {
    // Simulates toggleRadar: reads isRadarEnabled(), flips, writes. The
    // production helper uses `=== true` (default-off semantic, #378), so
    // the first read on an unset cache returns false → flip → write true.
    const readFlipWrite = () => {
      const current = (getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled === true;
      updateGlobalSettings({ pitCrewRadarEnabled: !current });
    };

    readFlipWrite();
    expect((getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled).toBe(true);

    readFlipWrite();
    expect((getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled).toBe(false);

    readFlipWrite();
    expect((getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled).toBe(true);
  });

  it("applies the same behaviour to pitCrewRaceEngineerEnabled (same toggle code path)", () => {
    updateGlobalSettings({ pitCrewRaceEngineerEnabled: false });
    expect((getGlobalSettings() as Record<string, unknown>).pitCrewRaceEngineerEnabled).toBe(false);

    updateGlobalSettings({ pitCrewRaceEngineerEnabled: true });
    expect((getGlobalSettings() as Record<string, unknown>).pitCrewRaceEngineerEnabled).toBe(true);
  });

  it("notifies listeners on every local write, not just on host echoes", () => {
    const listener = vi.fn();
    onGlobalSettingsChange(listener);

    updateGlobalSettings({ radarVolume: 80 });
    updateGlobalSettings({ radarVolume: 75 });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0][0].radarVolume).toBe(80);
    expect(listener.mock.calls[1][0].radarVolume).toBe(75);
  });

  it("forwards the full merged+parsed settings payload to the adapter", () => {
    // Open the #896 first-arrival gate — writes before the first host
    // settings arrival are queued, not persisted.
    mock.echo!({});
    updateGlobalSettings({ pitCrewRadarEnabled: false });

    expect(mock.setGlobalSettings).toHaveBeenCalledTimes(1);
    const sent = mock.setGlobalSettings.mock.calls[0][0] as Record<string, unknown>;
    // Assert both the partial override and the Zod-produced defaults are
    // all present — this proves the adapter receives the parsed result,
    // not just the caller's bare partial.
    expect(sent).toMatchObject({
      pitCrewRadarEnabled: false,
      pitCrewRaceEngineerEnabled: false,
      raceEngineerVolume: 50,
      radarVolume: 50,
      backgroundVolume: 25,
      disableWhenDisconnected: true,
      focusIRacingWindow: false,
      enableFuelingOnChange: true,
      simHubHost: "127.0.0.1",
      simHubPort: 8888,
    });
  });

  it("reconciles on host echo without losing later local writes' semantics", () => {
    updateGlobalSettings({ pitCrewRadarEnabled: false });
    expect((getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled).toBe(false);

    // initGlobalSettings must register an echo callback; fail loudly if
    // not, otherwise the reconciliation step below silently skips.
    expect(mock.echo).not.toBeNull();

    // Host finally echoes the earlier write — cache stays false.
    mock.echo!({ pitCrewRadarEnabled: false });
    expect((getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled).toBe(false);

    // New local write still flips immediately.
    updateGlobalSettings({ pitCrewRadarEnabled: true });
    expect((getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled).toBe(true);
  });

  it("no-ops when the adapter is not initialized", () => {
    _resetGlobalSettings();
    // Not calling initGlobalSettings — adapterRef stays null.

    updateGlobalSettings({ pitCrewRadarEnabled: true });

    // No throw; cache stays at the schema default (false per #378).
    expect((getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled).toBe(false);
  });
});

describe("deleteGlobalSettings (issue #515 migration helper)", () => {
  let mock: MockAdapter;

  beforeEach(() => {
    _resetGlobalSettings();
    mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger());
    mock.setGlobalSettings.mockClear();
  });

  it("removes the listed keys from the cache", () => {
    // Seed the cache via the host-echo path so the keys exist as
    // passthrough values (the schema doesn't define them).
    mock.echo!({ legacyA: 1, legacyB: 2, keepMe: 3 });
    expect((getGlobalSettings() as Record<string, unknown>).legacyA).toBe(1);

    deleteGlobalSettings(["legacyA", "legacyB"]);

    const settings = getGlobalSettings() as Record<string, unknown>;
    expect(settings.legacyA).toBeUndefined();
    expect(settings.legacyB).toBeUndefined();
    expect(settings.keepMe).toBe(3);
  });

  it("writes the trimmed cache to the adapter exactly once per call", () => {
    mock.echo!({ legacyA: 1 });
    mock.setGlobalSettings.mockClear();

    deleteGlobalSettings(["legacyA"]);

    expect(mock.setGlobalSettings).toHaveBeenCalledTimes(1);
    const written = mock.setGlobalSettings.mock.calls[0][0] as Record<string, unknown>;
    expect(written.legacyA).toBeUndefined();
  });

  it("is a no-op when none of the listed keys are present", () => {
    mock.echo!({ keepMe: 3 });
    mock.setGlobalSettings.mockClear();
    const listener = vi.fn();
    onGlobalSettingsChange(listener);

    deleteGlobalSettings(["legacyA", "legacyB"]);

    // No write to the adapter, no listener fire — the cache is unchanged.
    expect(mock.setGlobalSettings).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect((getGlobalSettings() as Record<string, unknown>).keepMe).toBe(3);
  });

  it("removes only the listed keys when same-prefix keys also exist", () => {
    // Specifically exercises the issue #515 migration shape: the renamed
    // pitCrew* keys can coexist with their legacy counterparts during
    // the transition; deleting the legacy names must not touch the new
    // ones.
    mock.echo!({
      pitCrewRaceEngineerEnabled: false,
      pitCrewRadarEnabled: false,
      raceEngineerEnabled: true,
      radarEnabled: true,
    });
    mock.setGlobalSettings.mockClear();

    deleteGlobalSettings(["raceEngineerEnabled", "radarEnabled"]);

    const settings = getGlobalSettings() as Record<string, unknown>;
    expect(settings.raceEngineerEnabled).toBeUndefined();
    expect(settings.radarEnabled).toBeUndefined();
    expect(settings.pitCrewRaceEngineerEnabled).toBe(false);
    expect(settings.pitCrewRadarEnabled).toBe(false);
  });

  it("subsequent call with the same key list is a no-op (idempotent)", () => {
    mock.echo!({ legacyA: 1 });
    deleteGlobalSettings(["legacyA"]);
    mock.setGlobalSettings.mockClear();

    deleteGlobalSettings(["legacyA"]);

    expect(mock.setGlobalSettings).not.toHaveBeenCalled();
  });

  it("notifies listeners with the trimmed payload", () => {
    mock.echo!({ legacyA: 1, keepMe: 3 });
    const listener = vi.fn();
    onGlobalSettingsChange(listener);

    deleteGlobalSettings(["legacyA"]);

    expect(listener).toHaveBeenCalledTimes(1);
    const payload = listener.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.legacyA).toBeUndefined();
    expect(payload.keepMe).toBe(3);
  });

  it("no-ops when the adapter is not initialized", () => {
    _resetGlobalSettings();
    // No initGlobalSettings call.

    expect(() => deleteGlobalSettings(["whatever"])).not.toThrow();
  });
});

describe("flag-callout opt-in defaults (issue #467)", () => {
  const FLAG_KEYS = [
    "calloutEnabledFlagYellowLocal",
    "calloutEnabledFlagYellowFull",
    "calloutEnabledFlagYellowCleared",
    "calloutEnabledFlagGreen",
    "calloutEnabledFlagBlue",
    "calloutEnabledFlagWhite",
    "calloutEnabledFlagRed",
    "calloutEnabledFlagBlack",
    "calloutEnabledFlagCheckered",
    "calloutEnabledFlagDebris",
    "calloutEnabledFlagMeatball",
  ] as const;

  it.each(FLAG_KEYS)("%s defaults to true", (key) => {
    const parsed = GlobalSettingsSchema.parse({}) as Record<string, unknown>;
    expect(parsed[key]).toBe(true);
  });

  it.each(FLAG_KEYS)('%s coerces the literal string "false" to boolean false', (key) => {
    const parsed = GlobalSettingsSchema.parse({ [key]: "false" }) as Record<string, unknown>;
    expect(parsed[key]).toBe(false);
  });

  it.each(FLAG_KEYS)("%s accepts boolean false directly", (key) => {
    const parsed = GlobalSettingsSchema.parse({ [key]: false }) as Record<string, unknown>;
    expect(parsed[key]).toBe(false);
  });

  it.each(FLAG_KEYS)('%s coerces the literal string "true" to boolean true', (key) => {
    const parsed = GlobalSettingsSchema.parse({ [key]: "true" }) as Record<string, unknown>;
    expect(parsed[key]).toBe(true);
  });
});

describe("spotter callout defaults (issue #651)", () => {
  const SPOTTER_CALLOUT_KEYS = ["calloutEnabledSpotterCars", "calloutEnabledSpotterStillThere"] as const;

  it.each(SPOTTER_CALLOUT_KEYS)("%s defaults to true", (key) => {
    const parsed = GlobalSettingsSchema.parse({}) as Record<string, unknown>;
    expect(parsed[key]).toBe(true);
  });

  it.each(SPOTTER_CALLOUT_KEYS)('%s coerces the literal string "false" to boolean false', (key) => {
    const parsed = GlobalSettingsSchema.parse({ [key]: "false" }) as Record<string, unknown>;
    expect(parsed[key]).toBe(false);
  });

  it("spotterStillThereSeconds defaults to 3", () => {
    const parsed = GlobalSettingsSchema.parse({}) as Record<string, unknown>;
    expect(parsed.spotterStillThereSeconds).toBe(3);
  });

  it("spotterStillThereSeconds coerces a numeric string within 1–10", () => {
    const parsed = GlobalSettingsSchema.parse({ spotterStillThereSeconds: "7" }) as Record<string, unknown>;
    expect(parsed.spotterStillThereSeconds).toBe(7);
  });
});

describe("corner-names toggle ack opt-in default (issue #897)", () => {
  it("defaults calloutEnabledToggleCornerNames to true", () => {
    const parsed = GlobalSettingsSchema.parse({}) as Record<string, unknown>;
    expect(parsed.calloutEnabledToggleCornerNames).toBe(true);
  });

  it('coerces the string "false" to boolean false', () => {
    const parsed = GlobalSettingsSchema.parse({ calloutEnabledToggleCornerNames: "false" }) as Record<string, unknown>;
    expect(parsed.calloutEnabledToggleCornerNames).toBe(false);
  });
});

describe("gap callout settings (issue #933)", () => {
  it("defaults the toggles on with threshold 1.0 and cooldown 30", () => {
    const parsed = GlobalSettingsSchema.parse({}) as Record<string, unknown>;

    expect(parsed.calloutEnabledGapTrend).toBe(true);
    expect(parsed.calloutEnabledGapThreshold).toBe(true);
    expect(parsed.gapAlertThresholdSeconds).toBe(1);
    expect(parsed.gapCalloutCooldownSeconds).toBe(30);
  });

  it("coerces numeric strings and falls back on malformed values", () => {
    const parsed = GlobalSettingsSchema.parse({
      gapAlertThresholdSeconds: "2.5",
      gapCalloutCooldownSeconds: "junk",
    }) as Record<string, unknown>;

    expect(parsed.gapAlertThresholdSeconds).toBe(2.5);
    expect(parsed.gapCalloutCooldownSeconds).toBe(30);
  });
});

describe("resolveActiveRaceEngineerVoice", () => {
  beforeEach(() => {
    _resetGlobalSettings();
  });

  it("returns null when no voices are available", () => {
    expect(resolveActiveRaceEngineerVoice([])).toBeNull();
  });

  it("returns the first voice when nothing is persisted", () => {
    expect(resolveActiveRaceEngineerVoice(["luca", "titan"])).toBe("luca");
  });

  it("returns the persisted voice when it's in the available list", () => {
    const mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger());
    mock.echo!({ raceEngineerVoice: "titan" });

    expect(resolveActiveRaceEngineerVoice(["luca", "titan"])).toBe("titan");
  });

  it("falls back to the first available voice when the persisted one is gone", () => {
    const mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger());
    mock.echo!({ raceEngineerVoice: "removed-voice" });

    expect(resolveActiveRaceEngineerVoice(["luca", "titan"])).toBe("luca");
  });

  it("treats empty string as 'no preference' and falls back to first", () => {
    const mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger());
    mock.echo!({ raceEngineerVoice: "" });

    expect(resolveActiveRaceEngineerVoice(["luca", "titan"])).toBe("luca");
  });

  // Migration regression: when audio-assets renamed `voice/luca/` to
  // `voice/default/`, the persisted `raceEngineerVoice: "luca"` value no
  // longer matches any scanned voice. The existing "falls back to the
  // first available voice" path covers this without code changes — this
  // test pins the behaviour explicitly so a future refactor that breaks
  // the fallback fails loudly.
  it("falls back to 'default' when persisted value is the legacy 'luca' (post-rename)", () => {
    const mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger());
    mock.echo!({ raceEngineerVoice: "luca" });

    expect(resolveActiveRaceEngineerVoice(["default"])).toBe("default");
  });
});

describe("resolveActiveDriverName", () => {
  beforeEach(() => {
    _resetGlobalSettings();
  });

  it("returns null when no names are available", () => {
    expect(resolveActiveDriverName([])).toBeNull();
  });

  it("returns the first name when nothing is persisted and no default given", () => {
    expect(resolveActiveDriverName(["adam", "niklas"])).toBe("adam");
  });

  it("returns the persisted name when it's in the available list", () => {
    const mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger());
    mock.echo!({ driverName: "niklas" });

    expect(resolveActiveDriverName(["adam", "niklas"])).toBe("niklas");
  });

  it("prefers the supplied default over the alphabetically-first name when nothing is persisted", () => {
    expect(resolveActiveDriverName(["adam", "driver", "niklas"], "driver")).toBe("driver");
  });

  it("ignores the supplied default when it's missing from the available list", () => {
    expect(resolveActiveDriverName(["adam", "niklas"], "driver")).toBe("adam");
  });

  it("prefers the persisted name over the supplied default", () => {
    const mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger());
    mock.echo!({ driverName: "niklas" });

    expect(resolveActiveDriverName(["adam", "driver", "niklas"], "driver")).toBe("niklas");
  });

  it("falls back to the supplied default when the persisted name is gone", () => {
    const mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger());
    mock.echo!({ driverName: "removed" });

    expect(resolveActiveDriverName(["adam", "driver"], "driver")).toBe("driver");
  });
});

describe("flagFlashDurationSeconds (issue #490)", () => {
  it("defaults to 15 when not specified", () => {
    const parsed = GlobalSettingsSchema.parse({}) as Record<string, unknown>;
    expect(parsed.flagFlashDurationSeconds).toBe(15);
  });

  it("accepts the lower bound (0 = flash forever)", () => {
    const parsed = GlobalSettingsSchema.parse({ flagFlashDurationSeconds: 0 }) as Record<string, unknown>;
    expect(parsed.flagFlashDurationSeconds).toBe(0);
  });

  it("accepts the upper bound (30 seconds)", () => {
    const parsed = GlobalSettingsSchema.parse({ flagFlashDurationSeconds: 30 }) as Record<string, unknown>;
    expect(parsed.flagFlashDurationSeconds).toBe(30);
  });

  it("coerces a numeric string from the Property Inspector slider", () => {
    const parsed = GlobalSettingsSchema.parse({ flagFlashDurationSeconds: "12" }) as Record<string, unknown>;
    expect(parsed.flagFlashDurationSeconds).toBe(12);
  });

  it("falls back to the default on malformed or out-of-range values instead of aborting the parse (issue #896)", () => {
    for (const value of [-1, 31, "abc"]) {
      const parsed = GlobalSettingsSchema.parse({ flagFlashDurationSeconds: value }) as Record<string, unknown>;
      expect(parsed.flagFlashDurationSeconds).toBe(15);
    }
  });
});

describe("setup-warning patterns (issue #625)", () => {
  const QUALI_DEFAULT = "(^|[ ._-])(race|r)([ ._-]|$)";
  const RACE_DEFAULT = "(^|[ ._-])(qualifying|quali|qual|q)([ ._-]|$)";

  it("defaults to the canonical patterns when not specified", () => {
    const parsed = GlobalSettingsSchema.parse({}) as Record<string, unknown>;
    expect(parsed.setupWarningQualifyingPattern).toBe(QUALI_DEFAULT);
    expect(parsed.setupWarningRacePattern).toBe(RACE_DEFAULT);
  });

  it("preserves a non-empty custom pattern", () => {
    const parsed = GlobalSettingsSchema.parse({ setupWarningRacePattern: "custom" }) as Record<string, unknown>;
    expect(parsed.setupWarningRacePattern).toBe("custom");
  });

  it("falls back to the default on an empty string", () => {
    const parsed = GlobalSettingsSchema.parse({ setupWarningRacePattern: "" }) as Record<string, unknown>;
    expect(parsed.setupWarningRacePattern).toBe(RACE_DEFAULT);
  });

  it("falls back to the default on a non-string (e.g. corrupted null) without throwing", () => {
    // A bad persisted value must not break the whole GlobalSettingsSchema.parse().
    expect(() => GlobalSettingsSchema.parse({ setupWarningRacePattern: null })).not.toThrow();
    const parsed = GlobalSettingsSchema.parse({ setupWarningRacePattern: null }) as Record<string, unknown>;
    expect(parsed.setupWarningRacePattern).toBe(RACE_DEFAULT);
  });
});

describe("fuelCalloutMarginLaps (issue #838)", () => {
  it("defaults to 0.3 when not specified", () => {
    const parsed = GlobalSettingsSchema.parse({}) as Record<string, unknown>;
    expect(parsed.fuelCalloutMarginLaps).toBe(0.3);
  });

  it("accepts the bounds and coerces a numeric string from the Property Inspector slider", () => {
    expect(
      (GlobalSettingsSchema.parse({ fuelCalloutMarginLaps: 0 }) as Record<string, unknown>).fuelCalloutMarginLaps,
    ).toBe(0);
    expect(
      (GlobalSettingsSchema.parse({ fuelCalloutMarginLaps: 3 }) as Record<string, unknown>).fuelCalloutMarginLaps,
    ).toBe(3);
    expect(
      (GlobalSettingsSchema.parse({ fuelCalloutMarginLaps: "0.7" }) as Record<string, unknown>).fuelCalloutMarginLaps,
    ).toBe(0.7);
  });

  it("normalizes empty-ish persisted values to the default instead of coercing them to 0", () => {
    // z.coerce.number() alone would turn null / "" / whitespace into 0 and
    // silently disable the safety margin.
    for (const value of [null, "", "  ", "\t\n"]) {
      const parsed = GlobalSettingsSchema.parse({ fuelCalloutMarginLaps: value }) as Record<string, unknown>;
      expect(parsed.fuelCalloutMarginLaps).toBe(0.3);
    }
  });

  it("falls back to the default on malformed or out-of-range values without throwing", () => {
    for (const value of ["abc", -1, 99, NaN]) {
      expect(() => GlobalSettingsSchema.parse({ fuelCalloutMarginLaps: value })).not.toThrow();
      const parsed = GlobalSettingsSchema.parse({ fuelCalloutMarginLaps: value }) as Record<string, unknown>;
      expect(parsed.fuelCalloutMarginLaps).toBe(0.3);
    }
  });
});

describe("dualPressThresholdMs (issue #540)", () => {
  it("defaults to 500 when not specified", () => {
    const parsed = GlobalSettingsSchema.parse({}) as Record<string, unknown>;
    expect(parsed.dualPressThresholdMs).toBe(500);
  });

  it("accepts the lower bound (200 ms)", () => {
    const parsed = GlobalSettingsSchema.parse({ dualPressThresholdMs: 200 }) as Record<string, unknown>;
    expect(parsed.dualPressThresholdMs).toBe(200);
  });

  it("accepts the upper bound (2000 ms)", () => {
    const parsed = GlobalSettingsSchema.parse({ dualPressThresholdMs: 2000 }) as Record<string, unknown>;
    expect(parsed.dualPressThresholdMs).toBe(2000);
  });

  it("coerces a numeric string from the Property Inspector slider", () => {
    const parsed = GlobalSettingsSchema.parse({ dualPressThresholdMs: "750" }) as Record<string, unknown>;
    expect(parsed.dualPressThresholdMs).toBe(750);
  });

  it("falls back to the default on malformed or out-of-range values instead of aborting the parse (issue #896)", () => {
    for (const value of [199, 2001, "abc"]) {
      const parsed = GlobalSettingsSchema.parse({ dualPressThresholdMs: value }) as Record<string, unknown>;
      expect(parsed.dualPressThresholdMs).toBe(500);
    }
  });
});

describe("dualPressDirections (issue #540)", () => {
  it("defaults to tap-increases when not specified", () => {
    const parsed = GlobalSettingsSchema.parse({}) as Record<string, unknown>;
    expect(parsed.dualPressDirections).toBe("tap-increases");
  });

  it("accepts tap-decreases", () => {
    const parsed = GlobalSettingsSchema.parse({ dualPressDirections: "tap-decreases" }) as Record<string, unknown>;
    expect(parsed.dualPressDirections).toBe("tap-decreases");
  });

  it("falls back to the default on unknown enum values instead of aborting the parse (issue #896)", () => {
    const parsed = GlobalSettingsSchema.parse({ dualPressDirections: "tap-toggles" }) as Record<string, unknown>;
    expect(parsed.dualPressDirections).toBe("tap-increases");
  });
});

describe("changelogNotification (issue #742)", () => {
  it("defaults to features when not specified (issue #901)", () => {
    const parsed = GlobalSettingsSchema.parse({}) as Record<string, unknown>;
    expect(parsed.changelogNotification).toBe("features");
  });

  it.each(CHANGELOG_NOTIFICATION_POLICIES)("accepts %s", (value) => {
    const parsed = GlobalSettingsSchema.parse({ changelogNotification: value }) as Record<string, unknown>;
    expect(parsed.changelogNotification).toBe(value);
  });

  it("falls back to features on a malformed persisted value", () => {
    const parsed = GlobalSettingsSchema.parse({ changelogNotification: "sometimes" }) as Record<string, unknown>;
    expect(parsed.changelogNotification).toBe("features");
  });
});

describe("fastestLapSearchDelayMs (issue #577)", () => {
  it("defaults to 400 when not specified", () => {
    const parsed = GlobalSettingsSchema.parse({}) as Record<string, unknown>;
    expect(parsed.fastestLapSearchDelayMs).toBe(400);
  });

  it("accepts the lower bound (50 ms)", () => {
    const parsed = GlobalSettingsSchema.parse({ fastestLapSearchDelayMs: 50 }) as Record<string, unknown>;
    expect(parsed.fastestLapSearchDelayMs).toBe(50);
  });

  it("accepts the upper bound (1000 ms)", () => {
    const parsed = GlobalSettingsSchema.parse({ fastestLapSearchDelayMs: 1000 }) as Record<string, unknown>;
    expect(parsed.fastestLapSearchDelayMs).toBe(1000);
  });

  it("coerces a numeric string from the Property Inspector slider", () => {
    const parsed = GlobalSettingsSchema.parse({ fastestLapSearchDelayMs: "650" }) as Record<string, unknown>;
    expect(parsed.fastestLapSearchDelayMs).toBe(650);
  });

  it("falls back to the default on malformed or out-of-range values instead of aborting the parse (issue #896)", () => {
    for (const value of [49, 1001, "abc"]) {
      const parsed = GlobalSettingsSchema.parse({ fastestLapSearchDelayMs: value }) as Record<string, unknown>;
      expect(parsed.fastestLapSearchDelayMs).toBe(400);
    }
  });
});

describe("chatEnterToCloseDelayMs (issue #589)", () => {
  it("defaults to 200 when not specified", () => {
    const parsed = GlobalSettingsSchema.parse({}) as Record<string, unknown>;
    expect(parsed.chatEnterToCloseDelayMs).toBe(200);
  });

  it("accepts the lower bound (0 ms)", () => {
    const parsed = GlobalSettingsSchema.parse({ chatEnterToCloseDelayMs: 0 }) as Record<string, unknown>;
    expect(parsed.chatEnterToCloseDelayMs).toBe(0);
  });

  it("accepts the upper bound (2000 ms)", () => {
    const parsed = GlobalSettingsSchema.parse({ chatEnterToCloseDelayMs: 2000 }) as Record<string, unknown>;
    expect(parsed.chatEnterToCloseDelayMs).toBe(2000);
  });

  it("coerces a numeric string from the Property Inspector slider", () => {
    const parsed = GlobalSettingsSchema.parse({ chatEnterToCloseDelayMs: "300" }) as Record<string, unknown>;
    expect(parsed.chatEnterToCloseDelayMs).toBe(300);
  });

  it("falls back to the default on malformed or out-of-range values instead of aborting the parse (issue #896)", () => {
    for (const value of [-1, 2001, "abc"]) {
      const parsed = GlobalSettingsSchema.parse({ chatEnterToCloseDelayMs: value }) as Record<string, unknown>;
      expect(parsed.chatEnterToCloseDelayMs).toBe(200);
    }
  });
});

describe("debugLogging (issue #609)", () => {
  it("defaults to false (debug logging is opt-in)", () => {
    const parsed = GlobalSettingsSchema.parse({}) as Record<string, unknown>;

    expect(parsed.debugLogging).toBe(false);
  });

  it("coerces the string 'true' from the Property Inspector checkbox", () => {
    const parsed = GlobalSettingsSchema.parse({ debugLogging: "true" }) as Record<string, unknown>;

    expect(parsed.debugLogging).toBe(true);
  });

  it("coerces the string 'false' to false", () => {
    const parsed = GlobalSettingsSchema.parse({ debugLogging: "false" }) as Record<string, unknown>;

    expect(parsed.debugLogging).toBe(false);
  });

  it("accepts a real boolean true", () => {
    const parsed = GlobalSettingsSchema.parse({ debugLogging: true }) as Record<string, unknown>;

    expect(parsed.debugLogging).toBe(true);
  });
});

describe("first-arrival write gate (issue #896)", () => {
  let mock: MockAdapter;

  beforeEach(() => {
    _resetGlobalSettings();
    mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger());
  });

  it("queues a write that happens before the first host settings arrival instead of persisting defaults", () => {
    updateGlobalSettings({ radarVolume: 80 });

    // Nothing persisted — a write here would overwrite host storage with a
    // defaults-based object, wiping every key binding (the #896 wipe).
    expect(mock.setGlobalSettings).not.toHaveBeenCalled();
    // Read-your-writes: the cache still reflects the new value immediately.
    expect((getGlobalSettings() as Record<string, unknown>).radarVolume).toBe(80);
  });

  it("flushes the queued write merged over the real settings once they arrive", () => {
    const binding = '{"type":"keyboard","key":"f1","modifiers":[]}';
    updateGlobalSettings({ radarVolume: 80 });

    mock.echo!({ blackBoxLapTiming: binding, radarVolume: 50 });

    expect(mock.setGlobalSettings).toHaveBeenCalledTimes(1);
    const sent = mock.setGlobalSettings.mock.calls[0][0] as Record<string, unknown>;
    // The host's stored binding survives, and the queued local write wins
    // over the (older) stored value.
    expect(sent.blackBoxLapTiming).toBe(binding);
    expect(sent.radarVolume).toBe(80);
  });

  it("does not write back on the first arrival when nothing was queued", () => {
    mock.echo!({ radarVolume: 60 });

    expect(mock.setGlobalSettings).not.toHaveBeenCalled();
    expect((getGlobalSettings() as Record<string, unknown>).radarVolume).toBe(60);
  });
});

describe("pending-write overlay on host echoes (issue #896)", () => {
  let mock: MockAdapter;

  beforeEach(() => {
    _resetGlobalSettings();
    mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger());
    // Open the first-arrival gate so writes persist immediately.
    mock.echo!({});
    mock.setGlobalSettings.mockClear();
  });

  it("re-applies a pending local write when a stale echo omits the key", () => {
    updateGlobalSettings({ pitCrewRadarEnabled: true });

    mock.echo!({});

    expect((getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled).toBe(true);
  });

  it("re-applies a pending local write when a stale echo carries the pre-write value", () => {
    updateGlobalSettings({ radarVolume: 80 });

    mock.echo!({ radarVolume: 50 });

    expect((getGlobalSettings() as Record<string, unknown>).radarVolume).toBe(80);
  });

  it("accepts a genuinely newer foreign value for the same key", () => {
    updateGlobalSettings({ radarVolume: 80 });

    // Neither our written value (80) nor the pre-write value (50): a newer
    // write from another party — the echo wins.
    mock.echo!({ radarVolume: 65 });

    expect((getGlobalSettings() as Record<string, unknown>).radarVolume).toBe(65);
  });

  it("drops the pending write once an echo confirms it", () => {
    updateGlobalSettings({ radarVolume: 80 });

    mock.echo!({ radarVolume: 80 });
    // With the pending write confirmed and dropped, a later echo wins.
    mock.echo!({ radarVolume: 30 });

    expect((getGlobalSettings() as Record<string, unknown>).radarVolume).toBe(30);
  });

  it("keeps the latest of two coalesced local writes when a stale echo carries the original host value", () => {
    // Real host baseline, then two local writes before any echo.
    mock.echo!({ radarVolume: 50 });
    updateGlobalSettings({ radarVolume: 60 });
    updateGlobalSettings({ radarVolume: 70 });

    // Stale echo from before the write episode — must not read as a
    // foreign write just because the second write moved the baseline.
    mock.echo!({ radarVolume: 50 });

    expect((getGlobalSettings() as Record<string, unknown>).radarVolume).toBe(70);
  });

  it("keeps the latest of two coalesced local writes when the echo of the first write arrives", () => {
    updateGlobalSettings({ radarVolume: 60 });
    updateGlobalSettings({ radarVolume: 70 });

    // The first write's own echo carries an intermediate episode value —
    // stale, not foreign.
    mock.echo!({ radarVolume: 60 });

    expect((getGlobalSettings() as Record<string, unknown>).radarVolume).toBe(70);
  });

  it("treats string-typed echo values as equal to their parsed counterparts", () => {
    // The PI persists numbers as strings ("50") while plugin writes persist
    // parsed numbers — a stale echo carrying the string form of the
    // pre-write value must still be recognized as stale, not as a newer
    // foreign write.
    updateGlobalSettings({ radarVolume: 80 });

    mock.echo!({ radarVolume: "50" });

    expect((getGlobalSettings() as Record<string, unknown>).radarVolume).toBe(80);
  });

  it("confirms a pending write from its string-typed echo form", () => {
    updateGlobalSettings({ radarVolume: 80 });

    mock.echo!({ radarVolume: "80" });
    mock.echo!({ radarVolume: "30" });

    expect((getGlobalSettings() as Record<string, unknown>).radarVolume).toBe(30);
  });
});

describe("pending-delete reconciliation on host echoes (issue #896)", () => {
  let mock: MockAdapter;

  beforeEach(() => {
    _resetGlobalSettings();
    mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger());
  });

  it("re-drops a deleted key from a stale echo, then confirms once an echo omits it", () => {
    mock.echo!({ legacyA: 1 });
    deleteGlobalSettings(["legacyA"]);

    // Stale echo still carrying the deleted key — the delete is re-applied.
    mock.echo!({ legacyA: 1 });
    expect("legacyA" in (getGlobalSettings() as Record<string, unknown>)).toBe(false);

    // An echo without the key confirms the delete and clears the pending
    // record — a later (foreign) re-add of the key is then accepted.
    mock.echo!({});
    mock.echo!({ legacyA: 5 });
    expect((getGlobalSettings() as Record<string, unknown>).legacyA).toBe(5);
  });
});

describe("host payload salvage (issue #896)", () => {
  let mock: MockAdapter;

  beforeEach(() => {
    _resetGlobalSettings();
    mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger());
  });

  it("keeps the good keys when one persisted value is unparseable", () => {
    // debugLogging: 42 fails its union (no per-field catch) — the salvage
    // path must drop that key rather than abort the whole parse and leave
    // the cache at defaults (failure path 3 in #896).
    mock.echo!({ blackBoxLapTiming: "b1", debugLogging: 42, radarVolume: 80 });

    const settings = getGlobalSettings() as Record<string, unknown>;
    expect(settings.blackBoxLapTiming).toBe("b1");
    expect(settings.radarVolume).toBe(80);
    expect(settings.debugLogging).toBe(false);
  });

  it("a malformed hardened field degrades to its default without touching bindings in the same payload", () => {
    mock.echo!({ simHubPort: "not-a-port", lookDirectionLeft: "b2" });

    const settings = getGlobalSettings() as Record<string, unknown>;
    expect(settings.lookDirectionLeft).toBe("b2");
    expect(settings.simHubPort).toBe(8888);
  });
});

describe("shrink guard on outgoing writes (issue #896)", () => {
  let mock: MockAdapter;

  beforeEach(() => {
    _resetGlobalSettings();
    mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger());
  });

  it("keeps bindings in outgoing writes when the same payload carried an unparseable value", () => {
    mock.echo!({ blackBoxLapTiming: "b1", debugLogging: 42 });
    mock.setGlobalSettings.mockClear();

    updateGlobalSettings({ radarVolume: 80 });

    const sent = mock.setGlobalSettings.mock.calls[0][0] as Record<string, unknown>;
    // The binding (a passthrough key — salvage can never drop those) rides
    // along untouched.
    expect(sent.blackBoxLapTiming).toBe("b1");
    // The unparseable schema field heals to its default in storage — the
    // salvage dropped the corrupt value and the schema materialized the
    // default, so the next session parses cleanly.
    expect(sent.debugLogging).toBe(false);
    expect(sent.radarVolume).toBe(80);
  });

  it("does not resurrect explicitly deleted keys", () => {
    mock.echo!({ legacyA: 1, keepMe: 2 });
    deleteGlobalSettings(["legacyA"]);
    mock.setGlobalSettings.mockClear();

    updateGlobalSettings({ radarVolume: 80 });

    const sent = mock.setGlobalSettings.mock.calls[0][0] as Record<string, unknown>;
    expect("legacyA" in sent).toBe(false);
    expect(sent.keepMe).toBe(2);
  });
});

describe("schema hardening (issue #896)", () => {
  it("simHubPort falls back to the default on malformed or out-of-range values", () => {
    for (const value of ["99999", "abc", 0, -5]) {
      const parsed = GlobalSettingsSchema.parse({ simHubPort: value }) as Record<string, unknown>;
      expect(parsed.simHubPort).toBe(8888);
    }
  });

  it("volume fields fall back to their defaults on malformed or out-of-range values", () => {
    const parsed = GlobalSettingsSchema.parse({
      radarVolume: 101,
      raceEngineerVolume: -1,
      backgroundVolume: "loud",
    }) as Record<string, unknown>;
    expect(parsed.radarVolume).toBe(50);
    expect(parsed.raceEngineerVolume).toBe(50);
    expect(parsed.backgroundVolume).toBe(25);
  });

  it("chat delay fields fall back to their defaults on out-of-range values", () => {
    const parsed = GlobalSettingsSchema.parse({
      chatOpenToPasteDelayMs: 9999,
      chatPasteToEnterDelayMs: -1,
    }) as Record<string, unknown>;
    expect(parsed.chatOpenToPasteDelayMs).toBe(200);
    expect(parsed.chatPasteToEnterDelayMs).toBe(200);
  });

  it("disableWhenDisconnected coerces PI string values like the other booleans", () => {
    const parsedFalse = GlobalSettingsSchema.parse({ disableWhenDisconnected: "false" }) as Record<string, unknown>;
    expect(parsedFalse.disableWhenDisconnected).toBe(false);
    const parsedTrue = GlobalSettingsSchema.parse({ disableWhenDisconnected: "true" }) as Record<string, unknown>;
    expect(parsedTrue.disableWhenDisconnected).toBe(true);
  });

  it("simHubHost falls back to the default on a non-string value", () => {
    const parsed = GlobalSettingsSchema.parse({ simHubHost: 42 }) as Record<string, unknown>;
    expect(parsed.simHubHost).toBe("127.0.0.1");
  });
});
