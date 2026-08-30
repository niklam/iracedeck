import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetGlobalSettings,
  deleteGlobalSettings,
  getGlobalSettings,
  getSettingsStoreSource,
  GlobalSettingsSchema,
  hostMirrorPayload,
  initGlobalSettings,
  type InitGlobalSettingsOptions,
  isSettingsStoreReady,
  LOAD_ATTEMPTS,
  LOAD_RETRY_DELAY_MS,
  MIGRATION_ABANDONED_KEY,
  MIGRATION_PENDING_KEY,
  MIGRATION_RETRY_STARTS,
  MIGRATION_TIMEOUT_MS,
  onGlobalSettingsChange,
  resolveActiveDriverName,
  resolveActiveRaceEngineerVoice,
  updateGlobalSettings,
} from "./global-settings.js";
import { PI_WARNINGS_KEY, setWarning } from "./pi-warnings.js";
import { createMemorySettingsStore } from "./settings-store.js";
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

type MemoryStore = ReturnType<typeof createMemorySettingsStore>;

/** Let the async load/migration inside initGlobalSettings settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * `tick`, but safe under fake timers — where a real `setTimeout(0)` never
 * fires, so awaiting one deadlocks the test. The multi-start tests are exactly
 * the ones that need both this and a controllable clock.
 */
const settle = async (): Promise<void> => {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await tick();
};

/** One simulated plugin start: the adapter it ran against and the store it wrote to. */
interface Start {
  mock: MockAdapter;
  store: MemoryStore;
}

/**
 * Simulate a plugin start against a settings file whose contents are `stored`
 * (omit it for "no file yet"), and wait for the store to settle.
 *
 * Pairs with {@link restartFrom}. Use these rather than hand-authoring the file
 * for a second start — see that function for why it matters.
 */
async function startWith(stored?: Record<string, unknown>, opts: InitGlobalSettingsOptions = {}): Promise<Start> {
  _resetGlobalSettings();

  const mock = createMockAdapter();
  const store = createMemorySettingsStore(stored === undefined ? undefined : { ...stored });

  initGlobalSettings(mock.adapter, createMockLogger(), store, opts);
  await settle();

  return { mock, store };
}

/**
 * Restart on the bytes a previous start ACTUALLY persisted, rather than on a
 * hand-written object hoping to match them.
 *
 * This is the shape #1041's post-mortem asked for. Every marker test there
 * authored both files itself, so nothing compared what one start wrote against
 * what the next start read — and a recovery path that production could never
 * reach shipped green, because its fixture carried a marker combination the
 * code never writes. Anything asserting across a restart boundary should chain
 * through here.
 *
 * Throws when the previous start persisted nothing: restarting from `undefined`
 * is the "no file yet" scenario, which would quietly pass for entirely the
 * wrong reason.
 */
async function restartFrom(previous: Start, opts: InitGlobalSettingsOptions = {}): Promise<Start> {
  const persisted = previous.store.saved.at(-1);

  if (persisted === undefined) {
    throw new Error("restartFrom: the previous start persisted nothing, so there is no file to restart from");
  }

  return startWith(persisted, opts);
}

/**
 * Initialize against a memory store seeded with `initial` (the "settings file
 * already exists" path) and wait for it to become ready — the store, not the
 * deck host, is what loads settings now (#993).
 */
async function initWithStore(initial: Record<string, unknown> = {}): Promise<{
  mock: MockAdapter;
  store: MemoryStore;
}> {
  const mock = createMockAdapter();
  const store = createMemorySettingsStore(initial);

  initGlobalSettings(mock.adapter, createMockLogger(), store);
  await tick();

  return { mock, store };
}

/**
 * Memory store whose first `failures` `load()` calls reject: a settings file
 * that exists but cannot be READ (locked by a scanner, permission denied).
 * `saved` stays observable so a test can prove nothing was written over it.
 */
function createUnreadableStore(failures: number, initial?: Record<string, unknown>) {
  const inner = createMemorySettingsStore(initial);
  let attempts = 0;

  return {
    ...inner,
    get attempts() {
      return attempts;
    },
    load: async () => {
      attempts += 1;

      if (attempts <= failures) throw new Error("EBUSY: the settings file is locked");

      return inner.load();
    },
  };
}

// Every init leaves module state behind (including a pending migration
// timer on the no-file path) — clear it so nothing bleeds into the next test.
afterEach(() => {
  _resetGlobalSettings();
});

describe("global-settings cache (synchronous update on local writes)", () => {
  let mock: MockAdapter;
  let store: MemoryStore;

  beforeEach(async () => {
    _resetGlobalSettings();
    ({ mock, store } = await initWithStore());
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

  it("notifies listeners on every local write", () => {
    const listener = vi.fn();
    onGlobalSettingsChange(listener);

    updateGlobalSettings({ radarVolume: 80 });
    updateGlobalSettings({ radarVolume: 75 });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0][0].radarVolume).toBe(80);
    expect(listener.mock.calls[1][0].radarVolume).toBe(75);
  });

  it("saves the full merged+parsed settings payload to the store", () => {
    updateGlobalSettings({ pitCrewRadarEnabled: false });

    const sent = store.saved.at(-1) as Record<string, unknown>;
    // Assert both the partial override and the Zod-produced defaults are
    // all present — this proves the store receives the parsed result,
    // not just the caller's bare partial.
    expect(sent).toMatchObject({
      pitCrewRadarEnabled: false,
      pitCrewRaceEngineerEnabled: false,
      raceEngineerVolume: 50,
      radarVolume: 50,
      backgroundVolume: 25,
      disableWhenDisconnected: true,
      focusIRacingWindow: true,
      enableFuelingOnChange: true,
      simHubHost: "127.0.0.1",
      simHubPort: 8888,
    });
  });

  it("keeps local write semantics when a host payload arrives (the host is not truth)", () => {
    updateGlobalSettings({ pitCrewRadarEnabled: false });
    expect((getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled).toBe(false);

    // initGlobalSettings must still register a host callback (it is the
    // migration source); fail loudly if not, otherwise the step below
    // silently skips.
    expect(mock.echo).not.toBeNull();

    // A host payload lands after the store is ready — ignored for the cache.
    mock.echo!({ pitCrewRadarEnabled: true });
    expect((getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled).toBe(false);

    // New local write still flips immediately.
    updateGlobalSettings({ pitCrewRadarEnabled: true });
    expect((getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled).toBe(true);
  });

  it("does not throw when called before initialization, and persists nothing", () => {
    _resetGlobalSettings();
    // Not calling initGlobalSettings — there is no store to save to.

    expect(() => updateGlobalSettings({ pitCrewRadarEnabled: true })).not.toThrow();

    // Read-your-writes still holds; the write is kept as an early write and
    // would be applied over whatever a later store load brings in.
    expect((getGlobalSettings() as Record<string, unknown>).pitCrewRadarEnabled).toBe(true);
    expect(store.saved).toHaveLength(1); // only the load-time save
  });
});

describe("deleteGlobalSettings (issue #515 migration helper)", () => {
  it("removes the listed keys from the cache", async () => {
    // Seed the store so the keys exist as passthrough values (the schema
    // doesn't define them) — the file is what loads settings now.
    await initWithStore({ legacyA: 1, legacyB: 2, keepMe: 3 });
    expect((getGlobalSettings() as Record<string, unknown>).legacyA).toBe(1);

    deleteGlobalSettings(["legacyA", "legacyB"]);

    const settings = getGlobalSettings() as Record<string, unknown>;
    expect(settings.legacyA).toBeUndefined();
    expect(settings.legacyB).toBeUndefined();
    expect(settings.keepMe).toBe(3);
  });

  it("saves the trimmed cache to the store exactly once per call", async () => {
    const { store } = await initWithStore({ legacyA: 1 });
    const savesBefore = store.saved.length;

    deleteGlobalSettings(["legacyA"]);

    expect(store.saved).toHaveLength(savesBefore + 1);
    expect(store.saved.at(-1)).not.toHaveProperty("legacyA");
  });

  it("is a no-op when none of the listed keys are present", async () => {
    const { store } = await initWithStore({ keepMe: 3 });
    const savesBefore = store.saved.length;
    const listener = vi.fn();
    onGlobalSettingsChange(listener);

    deleteGlobalSettings(["legacyA", "legacyB"]);

    // No save, no listener fire — the cache is unchanged.
    expect(store.saved).toHaveLength(savesBefore);
    expect(listener).not.toHaveBeenCalled();
    expect((getGlobalSettings() as Record<string, unknown>).keepMe).toBe(3);
  });

  it("removes only the listed keys when same-prefix keys also exist", async () => {
    // Specifically exercises the issue #515 migration shape: the renamed
    // pitCrew* keys can coexist with their legacy counterparts during
    // the transition; deleting the legacy names must not touch the new
    // ones.
    await initWithStore({
      pitCrewRaceEngineerEnabled: false,
      pitCrewRadarEnabled: false,
      raceEngineerEnabled: true,
      radarEnabled: true,
    });

    deleteGlobalSettings(["raceEngineerEnabled", "radarEnabled"]);

    const settings = getGlobalSettings() as Record<string, unknown>;
    expect(settings.raceEngineerEnabled).toBeUndefined();
    expect(settings.radarEnabled).toBeUndefined();
    expect(settings.pitCrewRaceEngineerEnabled).toBe(false);
    expect(settings.pitCrewRadarEnabled).toBe(false);
  });

  it("subsequent call with the same key list is a no-op (idempotent)", async () => {
    const { store } = await initWithStore({ legacyA: 1 });
    deleteGlobalSettings(["legacyA"]);
    const savesBefore = store.saved.length;

    deleteGlobalSettings(["legacyA"]);

    expect(store.saved).toHaveLength(savesBefore);
  });

  it("notifies listeners with the trimmed payload", async () => {
    await initWithStore({ legacyA: 1, keepMe: 3 });
    const listener = vi.fn();
    onGlobalSettingsChange(listener);

    deleteGlobalSettings(["legacyA"]);

    expect(listener).toHaveBeenCalledTimes(1);
    const payload = listener.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.legacyA).toBeUndefined();
    expect(payload.keepMe).toBe(3);
  });

  it("does not throw when called before initialization", () => {
    _resetGlobalSettings();
    // No initGlobalSettings call — there is no store to save to.

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
    expect(parsed.gapCalloutMinChangeSeconds).toBe(1.5);
  });

  it("coerces numeric strings and falls back on malformed values", () => {
    const parsed = GlobalSettingsSchema.parse({
      gapAlertThresholdSeconds: "2.5",
      gapCalloutCooldownSeconds: "junk",
      gapCalloutMinChangeSeconds: "0",
    }) as Record<string, unknown>;

    expect(parsed.gapAlertThresholdSeconds).toBe(2.5);
    expect(parsed.gapCalloutCooldownSeconds).toBe(30);
    expect(parsed.gapCalloutMinChangeSeconds).toBe(0);
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

  it("returns the persisted voice when it's in the available list", async () => {
    await initWithStore({ raceEngineerVoice: "titan" });

    expect(resolveActiveRaceEngineerVoice(["luca", "titan"])).toBe("titan");
  });

  it("falls back to the first available voice when the persisted one is gone", async () => {
    await initWithStore({ raceEngineerVoice: "removed-voice" });

    expect(resolveActiveRaceEngineerVoice(["luca", "titan"])).toBe("luca");
  });

  it("treats empty string as 'no preference' and falls back to first", async () => {
    await initWithStore({ raceEngineerVoice: "" });

    expect(resolveActiveRaceEngineerVoice(["luca", "titan"])).toBe("luca");
  });

  // Migration regression: when audio-assets renamed `voice/luca/` to
  // `voice/default/`, the persisted `raceEngineerVoice: "luca"` value no
  // longer matches any scanned voice. The existing "falls back to the
  // first available voice" path covers this without code changes — this
  // test pins the behaviour explicitly so a future refactor that breaks
  // the fallback fails loudly.
  it("falls back to 'default' when persisted value is the legacy 'luca' (post-rename)", async () => {
    await initWithStore({ raceEngineerVoice: "luca" });

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

  it("returns the persisted name when it's in the available list", async () => {
    await initWithStore({ driverName: "niklas" });

    expect(resolveActiveDriverName(["adam", "niklas"])).toBe("niklas");
  });

  it("prefers the supplied default over the alphabetically-first name when nothing is persisted", () => {
    expect(resolveActiveDriverName(["adam", "driver", "niklas"], "driver")).toBe("driver");
  });

  it("ignores the supplied default when it's missing from the available list", () => {
    expect(resolveActiveDriverName(["adam", "niklas"], "driver")).toBe("adam");
  });

  it("prefers the persisted name over the supplied default", async () => {
    await initWithStore({ driverName: "niklas" });

    expect(resolveActiveDriverName(["adam", "driver", "niklas"], "driver")).toBe("niklas");
  });

  it("falls back to the supplied default when the persisted name is gone", async () => {
    await initWithStore({ driverName: "removed" });

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

describe("updateCheck (issue #1016)", () => {
  it("defaults to on", () => {
    const parsed = GlobalSettingsSchema.parse({}) as Record<string, unknown>;
    expect(parsed.updateCheck).toBe(true);
  });

  it("accepts the string form the Property Inspector saves", () => {
    expect((GlobalSettingsSchema.parse({ updateCheck: "false" }) as Record<string, unknown>).updateCheck).toBe(false);
    expect((GlobalSettingsSchema.parse({ updateCheck: "true" }) as Record<string, unknown>).updateCheck).toBe(true);
  });

  it("accepts a real boolean", () => {
    expect((GlobalSettingsSchema.parse({ updateCheck: false }) as Record<string, unknown>).updateCheck).toBe(false);
  });

  it("falls back to the default on a malformed value rather than aborting the parse", () => {
    const parsed = GlobalSettingsSchema.parse({ updateCheck: { bogus: true }, driverName: "nick" }) as Record<
      string,
      unknown
    >;

    expect(parsed.updateCheck).toBe(true);
    expect(parsed.driverName).toBe("nick");
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

describe("stored-settings salvage (issue #896 protection, now over the file)", () => {
  it("keeps the good keys when one stored value is unparseable", async () => {
    // debugLogging: 42 fails its union (no per-field catch) — the salvage
    // path must drop that key rather than abort the whole parse and leave
    // the cache at defaults (failure path 3 in #896).
    await initWithStore({ blackBoxLapTiming: "b1", debugLogging: 42, radarVolume: 80 });

    const settings = getGlobalSettings() as Record<string, unknown>;
    expect(settings.blackBoxLapTiming).toBe("b1");
    expect(settings.radarVolume).toBe(80);
    expect(settings.debugLogging).toBe(false);
  });

  it("a malformed hardened field degrades to its default without touching bindings in the same file", async () => {
    await initWithStore({ simHubPort: "not-a-port", lookDirectionLeft: "b2" });

    const settings = getGlobalSettings() as Record<string, unknown>;
    expect(settings.lookDirectionLeft).toBe("b2");
    expect(settings.simHubPort).toBe(8888);
  });

  it("heals the file: the salvaged result is what gets saved back", async () => {
    const { store } = await initWithStore({ blackBoxLapTiming: "b1", debugLogging: 42 });

    // The corrupt value is gone from storage and the schema default took
    // its place, so the next start parses cleanly. The binding (a
    // passthrough key — salvage can never drop those) rides along untouched.
    expect(store.saved.at(-1)).toMatchObject({ blackBoxLapTiming: "b1", debugLogging: false });
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

describe("focus iRacing window default (issue #930)", () => {
  it("defaults focusIRacingWindow to true", () => {
    const parsed = GlobalSettingsSchema.parse({}) as Record<string, unknown>;
    expect(parsed.focusIRacingWindow).toBe(true);
  });

  it("keeps an explicitly persisted false, so upgrades don't flip existing installs", () => {
    const parsedBoolean = GlobalSettingsSchema.parse({ focusIRacingWindow: false }) as Record<string, unknown>;
    expect(parsedBoolean.focusIRacingWindow).toBe(false);
    const parsedString = GlobalSettingsSchema.parse({ focusIRacingWindow: "false" }) as Record<string, unknown>;
    expect(parsedString.focusIRacingWindow).toBe(false);
  });

  it("falls back to true on an unparseable value rather than aborting the parse", () => {
    const parsed = GlobalSettingsSchema.parse({ focusIRacingWindow: 42 }) as Record<string, unknown>;
    expect(parsed.focusIRacingWindow).toBe(true);
  });

  // `.catch(<default>)` is the repo-wide rule (#896), so an unreadable value
  // resolves to the field default regardless of how it looks. Pinned because a
  // falsy non-boolean is the case where that reads counter-intuitively: nothing
  // in the stack persists numbers for this flag, but if something ever did, `0`
  // would resolve to ON rather than OFF.
  it("resolves a falsy non-boolean to the default too, not to off", () => {
    const parsed = GlobalSettingsSchema.parse({ focusIRacingWindow: 0 }) as Record<string, unknown>;
    expect(parsed.focusIRacingWindow).toBe(true);
  });
});

describe("debugLogging hardening (issue #896 convention)", () => {
  it("falls back to false on an unparseable value rather than aborting the parse", () => {
    const parsed = GlobalSettingsSchema.parse({ debugLogging: 42 }) as Record<string, unknown>;
    expect(parsed.debugLogging).toBe(false);
  });
});

describe("single-writer store (issue #993)", () => {
  beforeEach(() => _resetGlobalSettings());

  it("loads the cache from the store and marks the store ready; the host is NOT asked", async () => {
    const mock = createMockAdapter();
    const store = createMemorySettingsStore({ driverName: "nick", debugLogging: "true" });

    initGlobalSettings(mock.adapter, createMockLogger(), store);
    await tick();

    expect(isSettingsStoreReady()).toBe(true);
    expect(getGlobalSettings().driverName).toBe("nick");
    expect(getGlobalSettings().debugLogging).toBe(true); // parsed
    expect(mock.getGlobalSettings).not.toHaveBeenCalled();
  });

  it("fires onGlobalSettingsChange listeners exactly once when the store is ready", async () => {
    const mock = createMockAdapter();
    const listener = vi.fn();

    initGlobalSettings(mock.adapter, createMockLogger(), createMemorySettingsStore({ driverName: "nick" }));
    onGlobalSettingsChange(listener);
    await tick();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ driverName: "nick" });
  });

  it("with no file, migrates ONCE from the host: asks, writes the host payload to the store, then is ready", async () => {
    // This also pins the #1053 decision, and is the reason no separate test
    // for it exists: acceptance is by ARRIVAL, not by provenance. `echo` here
    // stands for the first payload to reach the listener while the window is
    // open — a genuine reply, or a fallback-path PI's save echo, which deck-core
    // cannot tell apart. Nothing bounds what it does on this path: `base` is
    // {}, so the payload becomes the whole cache and is persisted as the whole
    // file. Accepted deliberately; see
    // docs/superpowers/specs/2026-08-30-issue-1053-migration-read-payload-correlation.md.
    const mock = createMockAdapter();
    const store = createMemorySettingsStore(); // no file
    const binding = JSON.stringify({ type: "keyboard", key: "f1", modifiers: [] });

    initGlobalSettings(mock.adapter, createMockLogger(), store);
    await tick();

    expect(isSettingsStoreReady()).toBe(false);
    expect(mock.getGlobalSettings).toHaveBeenCalledTimes(1);

    mock.echo?.({ driverName: "host-nick", blackBoxLapTiming: binding });
    await store.flush();

    expect(isSettingsStoreReady()).toBe(true);
    expect(getGlobalSettings().driverName).toBe("host-nick");
    expect(store.saved.at(-1)).toMatchObject({ driverName: "host-nick", blackBoxLapTiming: binding });
  });

  it("migrates only once — a later host payload no longer re-asks or re-migrates", async () => {
    const mock = createMockAdapter();
    const store = createMemorySettingsStore();

    initGlobalSettings(mock.adapter, createMockLogger(), store);
    await tick();
    mock.echo?.({ driverName: "host-nick" });
    const savesAfterMigration = store.saved.length;

    mock.echo?.({ driverName: "second-payload" });

    expect(getGlobalSettings().driverName).toBe("host-nick");
    expect(store.saved).toHaveLength(savesAfterMigration);
    expect(mock.getGlobalSettings).toHaveBeenCalledTimes(1);
  });

  it("migration leaves the host copy alone — no host write happens during or after migration", async () => {
    const mock = createMockAdapter();

    initGlobalSettings(mock.adapter, createMockLogger(), createMemorySettingsStore());
    await tick();
    mock.echo?.({ driverName: "host-nick" });
    await tick();
    updateGlobalSettings({ driverName: "later" });

    expect(mock.setGlobalSettings).not.toHaveBeenCalled();
  });

  it("with no file and a silent host, becomes ready with schema defaults after the migration timeout", async () => {
    vi.useFakeTimers();

    try {
      const mock = createMockAdapter();
      const store = createMemorySettingsStore();

      initGlobalSettings(mock.adapter, createMockLogger(), store, { migrationTimeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(10);
      expect(isSettingsStoreReady()).toBe(false);
      await vi.advanceTimersByTimeAsync(60);

      expect(isSettingsStoreReady()).toBe(true);
      expect(store.saved).toHaveLength(1); // the fresh file was written
      // ...carrying the marker that makes the next start ask the host again.
      expect(store.saved[0]).toMatchObject({ [MIGRATION_PENDING_KEY]: 1 });
      expect(hostMirrorPayload({ port: 1, token: "t" })).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fresh-born file (pending-migration marker) asks the host again next start: the host fills in, the file's own edits win, the marker clears, and the mirror is allowed", async () => {
    const mock = createMockAdapter();
    const binding = JSON.stringify({ type: "keyboard", key: "f1", modifiers: [] });
    // What a fresh start persisted: schema defaults + the marker, plus one value the user changed meanwhile.
    const freshBorn = {
      ...(GlobalSettingsSchema.parse({}) as Record<string, unknown>),
      [MIGRATION_PENDING_KEY]: 1,
      driverName: "typed-in-the-fresh-session",
      _settingsStorePath: "C:/x/global-settings.json",
    };
    const store = createMemorySettingsStore(freshBorn);

    initGlobalSettings(mock.adapter, createMockLogger(), store);
    await tick();

    expect(isSettingsStoreReady()).toBe(false); // waiting for the host again
    expect(mock.getGlobalSettings).toHaveBeenCalledTimes(1);

    mock.echo?.({ driverName: "host-nick", blackBoxLapTiming: binding, focusIRacingWindow: false });
    await store.flush();

    expect(isSettingsStoreReady()).toBe(true);
    const settings = getGlobalSettings() as unknown as Record<string, unknown>;
    expect(settings.driverName).toBe("typed-in-the-fresh-session"); // the file's non-default value wins
    expect(settings.blackBoxLapTiming).toBe(binding); // a binding the file never had comes from the host
    expect(settings.focusIRacingWindow).toBe(false); // a key still at its default in the file takes the host's value
    expect(settings._settingsStorePath).toBe("C:/x/global-settings.json"); // passthrough keys the file added survive
    expect(settings[MIGRATION_PENDING_KEY]).toBeUndefined();
    expect(store.saved.at(-1)).not.toHaveProperty(MIGRATION_PENDING_KEY);
    expect(hostMirrorPayload({ port: 1, token: "t" })).toMatchObject({ blackBoxLapTiming: binding });
  });

  it("a fresh-born file whose host is STILL silent keeps the marker and still skips the mirror — defaults are never mirrored over an unread host copy", async () => {
    vi.useFakeTimers();

    try {
      const mock = createMockAdapter();
      const store = createMemorySettingsStore({
        ...(GlobalSettingsSchema.parse({}) as Record<string, unknown>),
        [MIGRATION_PENDING_KEY]: 1,
      });

      initGlobalSettings(mock.adapter, createMockLogger(), store, { migrationTimeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(60);

      expect(isSettingsStoreReady()).toBe(true);
      expect(getSettingsStoreSource()).toBe("fresh");
      expect(store.saved.at(-1)).toMatchObject({ [MIGRATION_PENDING_KEY]: 2 }); // one more unanswered start
      expect(hostMirrorPayload({ port: 1, token: "t" })).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("after MIGRATION_RETRY_STARTS unanswered starts the file is accepted as-is: no more waiting, countdown retired, mirror STAYS shut (#1041)", async () => {
    // The ceiling used to clear the marker and resume the mirror, which is how
    // an unanswerable read destroyed data: the mirror is a whole-object write,
    // so resuming it replaces a host copy the plugin has never once read. The
    // countdown gives way to a durable marker instead.
    const mock = createMockAdapter();
    const store = createMemorySettingsStore({
      ...(GlobalSettingsSchema.parse({}) as Record<string, unknown>),
      [MIGRATION_PENDING_KEY]: MIGRATION_RETRY_STARTS,
      driverName: "kept",
    });

    initGlobalSettings(mock.adapter, createMockLogger(), store);
    await tick();

    expect(isSettingsStoreReady()).toBe(true);
    expect(getSettingsStoreSource()).toBe("file");
    expect(mock.getGlobalSettings).not.toHaveBeenCalled();
    expect(store.saved.at(-1)).not.toHaveProperty(MIGRATION_PENDING_KEY);
    expect(store.saved.at(-1)).toMatchObject({ [MIGRATION_ABANDONED_KEY]: true });
    expect(hostMirrorPayload({ port: 1, token: "t" })).toBeUndefined();
    // "Accepted as-is" means the user's own file content survives — the check
    // the mirror assertion used to carry before it started asserting undefined.
    expect((getGlobalSettings() as unknown as Record<string, unknown>).driverName).toBe("kept");
    expect(MIGRATION_RETRY_STARTS).toBe(3);
  });

  it("a file carrying the give-up marker keeps the mirror shut on every later start (#1041)", async () => {
    // The durable half. The countdown is gone by now, so nothing else would
    // stop the next start mirroring defaults over the copy this protects.
    const mock = createMockAdapter();
    const store = createMemorySettingsStore({
      ...(GlobalSettingsSchema.parse({}) as Record<string, unknown>),
      [MIGRATION_ABANDONED_KEY]: true,
      driverName: "kept",
    });

    initGlobalSettings(mock.adapter, createMockLogger(), store);
    await tick();

    expect(getSettingsStoreSource()).toBe("file");
    expect(mock.getGlobalSettings).not.toHaveBeenCalled();
    expect(hostMirrorPayload({ port: 1, token: "t" })).toBeUndefined();
    expect(store.saved.at(-1)).toMatchObject({ [MIGRATION_ABANDONED_KEY]: true, driverName: "kept" });
  });

  it("the file the ceiling ACTUALLY writes still shuts the mirror on the next start (#1041)", async () => {
    // Chains one start's persisted output into the next start's input rather
    // than hand-authoring the second file — see restartFrom for why that
    // distinction is the whole point.
    const ceiling = await startWith({
      ...(GlobalSettingsSchema.parse({}) as Record<string, unknown>),
      [MIGRATION_PENDING_KEY]: MIGRATION_RETRY_STARTS,
      driverName: "kept",
    });

    const next = await restartFrom(ceiling);

    expect(next.mock.getGlobalSettings).not.toHaveBeenCalled();
    expect(hostMirrorPayload({ port: 1, token: "t" })).toBeUndefined();
    expect((getGlobalSettings() as unknown as Record<string, unknown>).driverName).toBe("kept");
  });

  it("the give-up marker fails CLOSED on a hand-edited value (#1041)", async () => {
    // Passthrough keys are never validated or coerced, and settings files do
    // get hand-edited and hand-copied between ecosystem folders here. A strict
    // `=== true` would read `"true"` as absent and mirror defaults over the
    // host copy this guard exists to protect.
    const mock = createMockAdapter();
    const store = createMemorySettingsStore({
      ...(GlobalSettingsSchema.parse({}) as Record<string, unknown>),
      [MIGRATION_ABANDONED_KEY]: "true",
    });

    initGlobalSettings(mock.adapter, createMockLogger(), store);
    await tick();

    expect(hostMirrorPayload({ port: 1, token: "t" })).toBeUndefined();
  });

  it("an explicit false in the give-up marker leaves the mirror allowed (#1041)", async () => {
    // Failing closed must not make the marker unclearable: an explicit false,
    // 0, or absence is still "not set".
    const mock = createMockAdapter();
    const store = createMemorySettingsStore({
      ...(GlobalSettingsSchema.parse({}) as Record<string, unknown>),
      [MIGRATION_ABANDONED_KEY]: false,
      driverName: "kept",
    });

    initGlobalSettings(mock.adapter, createMockLogger(), store);
    await tick();

    expect(hostMirrorPayload({ port: 1, token: "t" })).toMatchObject({ driverName: "kept" });
  });

  it("MIGRATION_TIMEOUT_MS is ten seconds", () => {
    expect(MIGRATION_TIMEOUT_MS).toBe(10_000);
  });

  describe("re-asking after a give-up (#1047)", () => {
    /** A file that a build gave up on, in the durable-marker shape. */
    const abandoned = (version: unknown, extra: Record<string, unknown> = {}) => ({
      ...(GlobalSettingsSchema.parse({}) as Record<string, unknown>),
      [MIGRATION_ABANDONED_KEY]: version,
      ...extra,
    });

    /**
     * A file that a build gave up on in the shape every FIELD install actually
     * has: the countdown at its ceiling and no marker at all, because #1041
     * ships in the same unreleased version as this change and no released
     * build has ever written one.
     */
    const ceilingReached = (extra: Record<string, unknown> = {}) => ({
      ...(GlobalSettingsSchema.parse({}) as Record<string, unknown>),
      [MIGRATION_PENDING_KEY]: MIGRATION_RETRY_STARTS,
      ...extra,
    });

    it("asks a countdown-at-ceiling file with NO marker — the cohort that exists in the field", async () => {
      // The whole point. Keying the retry on the durable marker alone would
      // have recovered nobody: #1041 is unreleased, so every install that gave
      // up did so under a build whose ceiling wrote only the countdown.
      const start = await startWith(ceilingReached(), { pluginVersion: "3.1.0", migrationTimeoutMs: 50 });

      expect(start.mock.getGlobalSettings).toHaveBeenCalledTimes(1);
    });

    it("does NOT ask again on the same version", async () => {
      const start = await startWith(abandoned("3.1.0"), { pluginVersion: "3.1.0" });

      expect(start.mock.getGlobalSettings).not.toHaveBeenCalled();
      expect(hostMirrorPayload({ port: 1, token: "t" })).toBeUndefined();
    });

    it("does NOT ask on a downgrade, and the pair converges", async () => {
      // A rollback cannot fix a read an older build already failed at, and a
      // bare `!==` would have both versions re-asking on every transition.
      const start = await startWith(abandoned("3.2.0"), { pluginVersion: "3.1.1" });

      expect(start.mock.getGlobalSettings).not.toHaveBeenCalled();
    });

    it("asks on an upgrade, and a host answer retires the marker and restores the mirror", async () => {
      const start = await startWith(abandoned("3.1.0", { driverName: "kept" }), { pluginVersion: "3.2.0" });

      expect(start.mock.getGlobalSettings).toHaveBeenCalledTimes(1);

      start.mock.echo?.({ blackBoxLapTiming: "from-host" });
      await start.store.flush();

      expect(getSettingsStoreSource()).toBe("host");
      expect(start.store.saved.at(-1)).not.toHaveProperty(MIGRATION_ABANDONED_KEY);
      expect(hostMirrorPayload({ port: 1, token: "t" })).toMatchObject({ blackBoxLapTiming: "from-host" });
      expect((getGlobalSettings() as unknown as Record<string, unknown>).driverName).toBe("kept");
    });

    it("asks for a #1041 file whose marker is a bare `true`", async () => {
      const start = await startWith(abandoned(true), { pluginVersion: "3.2.0" });

      expect(start.mock.getGlobalSettings).toHaveBeenCalledTimes(1);
    });

    it("leaves a given-up store alone when the running version is unknown", async () => {
      const start = await startWith(abandoned("3.1.0"), {});

      expect(start.mock.getGlobalSettings).not.toHaveBeenCalled();
    });

    it("the file wins outright over the host on the retry, INCLUDING keys at a schema default", async () => {
      // mergeMigration's "still at its default implies never touched" premise
      // holds for a defaults-born file a few starts old. The store here has
      // been authoritative for months, so a deliberate choice that happens to
      // equal the default must not lose to a copy from before the give-up —
      // and the merged result is mirrored back, so losing it destroys the
      // setting in both stores at once.
      //
      // This is also the ONLY bound on an accepted payload anywhere in the
      // migration, which is what #1053 leans on when it accepts an
      // uncorrelated read: on this path `{ ...raw, ...migrationBase }` means a
      // stray can add a key the file never held but cannot move one the user
      // has. No such bound exists on the fresh or `_migrationPending` paths,
      // which go through mergeMigration — do not generalise it to them.
      const start = await startWith(abandoned("3.1.0", { focusIRacingWindow: true }), {
        pluginVersion: "3.2.0",
      });

      start.mock.echo?.({ focusIRacingWindow: false, blackBoxLapTiming: "only-on-host" });
      await start.store.flush();

      expect(getGlobalSettings().focusIRacingWindow).toBe(true);
      // The host still fills a key the file has never held.
      expect((getGlobalSettings() as unknown as Record<string, unknown>).blackBoxLapTiming).toBe("only-on-host");
    });

    it("an EMPTY host answer does not retire the guard", async () => {
      // `raw` coerces null and non-objects to {}, and on a host that cannot
      // tell "no bucket" from "empty bucket" an empty reply is no evidence the
      // copy is gone. Retiring on one would re-open a whole-object write over
      // a copy nothing was read from.
      const start = await startWith(abandoned("3.1.0"), { pluginVersion: "3.2.0" });

      start.mock.echo?.({});
      await start.store.flush();

      expect(hostMirrorPayload({ port: 1, token: "t" })).toBeUndefined();
      expect(start.store.saved.at(-1)).toMatchObject({ [MIGRATION_ABANDONED_KEY]: "3.2.0" });
    });

    it("a NULL host answer does not retire the guard either", async () => {
      const start = await startWith(abandoned("3.1.0"), { pluginVersion: "3.2.0" });

      start.mock.echo?.(null);
      await start.store.flush();

      expect(hostMirrorPayload({ port: 1, token: "t" })).toBeUndefined();
    });

    it("a silent host records THIS build's give-up and does not restart the countdown", async () => {
      // One extra attempt per version, not three: restarting the countdown
      // would cost three degraded startups per release, which is neither what
      // the ceiling exists to prevent nor what any doc promises.
      vi.useFakeTimers();

      try {
        const start = await startWith(abandoned("3.1.0", { driverName: "kept" }), {
          pluginVersion: "3.2.0",
          migrationTimeoutMs: 50,
        });

        expect(start.mock.getGlobalSettings).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(60);

        expect(start.store.saved.at(-1)).toMatchObject({ [MIGRATION_ABANDONED_KEY]: "3.2.0" });
        expect(start.store.saved.at(-1)).not.toHaveProperty(MIGRATION_PENDING_KEY);
        expect(hostMirrorPayload({ port: 1, token: "t" })).toBeUndefined();
        // The user's file survives the unanswered retry intact.
        expect((getGlobalSettings() as unknown as Record<string, unknown>).driverName).toBe("kept");
      } finally {
        vi.useRealTimers();
      }
    });

    it("goes quiet after one unanswered retry, chained start to start", async () => {
      vi.useFakeTimers();

      try {
        const first = await startWith(ceilingReached({ driverName: "kept" }), {
          pluginVersion: "3.2.0",
          migrationTimeoutMs: 50,
        });

        await vi.advanceTimersByTimeAsync(60);

        // On the bytes that start actually wrote.
        const next = await restartFrom(first, { pluginVersion: "3.2.0", migrationTimeoutMs: 50 });

        expect(next.mock.getGlobalSettings).not.toHaveBeenCalled();
        expect(hostMirrorPayload({ port: 1, token: "t" })).toBeUndefined();
        expect((getGlobalSettings() as unknown as Record<string, unknown>).driverName).toBe("kept");

        // ...and the NEXT version asks once more.
        const upgraded = await restartFrom(next, { pluginVersion: "3.3.0", migrationTimeoutMs: 50 });

        expect(upgraded.mock.getGlobalSettings).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a blank or whitespace running version cannot stamp a marker that reads as unset", async () => {
      // `?? true` would store "" verbatim, which isMigrationAbandoned reads
      // back as NOT set — the guard failing open on the start that raises it.
      vi.useFakeTimers();

      try {
        const start = await startWith(ceilingReached(), { pluginVersion: "   ", migrationTimeoutMs: 50 });

        await vi.advanceTimersByTimeAsync(60);

        expect(start.store.saved.at(-1)).toMatchObject({ [MIGRATION_ABANDONED_KEY]: true });
        expect(hostMirrorPayload({ port: 1, token: "t" })).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a blank running version does not retry a marked store, so it cannot loop", async () => {
      // Blank is unknown, not "differs". Retrying on it would stamp `true` (the
      // writer discards a blank), which the next start reads back as an unknown
      // recorded version and retries again — a migration timeout on every
      // launch, forever, which is what the ceiling exists to prevent.
      const start = await startWith(abandoned(true), { pluginVersion: "   " });

      expect(start.mock.getGlobalSettings).not.toHaveBeenCalled();
    });

    it("a whitespace-padded stored version still compares equal to itself", async () => {
      // The writer trims because the reader does; an untrimmed store would
      // never match and would re-ask forever.
      const start = await startWith(abandoned(" 3.1.0 "), { pluginVersion: "3.1.0" });

      expect(start.mock.getGlobalSettings).not.toHaveBeenCalled();
    });

    it("a hand-copied numeric marker still shuts the mirror and is retried by a named version", async () => {
      const start = await startWith(abandoned(1), { pluginVersion: "3.2.0" });

      expect(start.mock.getGlobalSettings).toHaveBeenCalledTimes(1);
    });

    it("a file carrying BOTH markers on the same version does not ask", async () => {
      // The countdown is mid-flight while the marker says this build already
      // gave up; the marker wins, so the store stays quiet.
      const start = await startWith(abandoned("3.1.0", { [MIGRATION_PENDING_KEY]: 1 }), {
        pluginVersion: "3.1.0",
      });

      expect(start.mock.getGlobalSettings).not.toHaveBeenCalled();
      expect(hostMirrorPayload({ port: 1, token: "t" })).toBeUndefined();
    });
  });

  it("updateGlobalSettings merges, parses, notifies, and saves the WHOLE cache to the store", async () => {
    const mock = createMockAdapter();
    const store = createMemorySettingsStore({ driverName: "nick" });

    initGlobalSettings(mock.adapter, createMockLogger(), store);
    await tick();
    const listener = vi.fn();
    onGlobalSettingsChange(listener);

    updateGlobalSettings({ debugLogging: "true" });

    expect(getGlobalSettings().debugLogging).toBe(true);
    expect(getGlobalSettings().driverName).toBe("nick");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.saved.at(-1)).toMatchObject({ driverName: "nick", debugLogging: true });
  });

  it("deleteGlobalSettings removes passthrough keys from the cache and saves", async () => {
    const mock = createMockAdapter();
    const store = createMemorySettingsStore({ _legacyKey: 1, driverName: "nick" });

    initGlobalSettings(mock.adapter, createMockLogger(), store);
    await tick();

    deleteGlobalSettings(["_legacyKey"]);

    expect((getGlobalSettings() as Record<string, unknown>)._legacyKey).toBeUndefined();
    expect(store.saved.at(-1)).not.toHaveProperty("_legacyKey");
  });

  it("writes made BEFORE the store is ready are applied over the loaded/migrated settings, not lost", async () => {
    const mock = createMockAdapter();
    const store = createMemorySettingsStore(); // migration path

    initGlobalSettings(mock.adapter, createMockLogger(), store);
    updateGlobalSettings({ _audioDeviceList: "[]" }); // the plugin does this at startup (#610 probe etc.)
    await tick();
    mock.echo?.({ driverName: "host-nick" });
    await store.flush();

    expect(getGlobalSettings().driverName).toBe("host-nick");
    expect((getGlobalSettings() as Record<string, unknown>)._audioDeviceList).toBe("[]");
    expect(store.saved.at(-1)).toMatchObject({ driverName: "host-nick", _audioDeviceList: "[]" });
  });

  it("a pre-ready write the schema rejects is not replayed over the loaded settings — the stored value stays", async () => {
    const mock = createMockAdapter();
    const store = createMemorySettingsStore({ raceEngineerVoice: "stored-voice" });

    initGlobalSettings(mock.adapter, createMockLogger(), store);
    // raceEngineerVoice has no .catch(): a non-string is DROPPED by salvage, not defaulted.
    updateGlobalSettings({ raceEngineerVoice: 42 as unknown as string, driverName: "early" });
    await tick();

    expect(getGlobalSettings().raceEngineerVoice).toBe("stored-voice");
    expect(getGlobalSettings().driverName).toBe("early");
    expect(store.saved.at(-1)).toMatchObject({ raceEngineerVoice: "stored-voice", driverName: "early" });
  });

  it("deletes made BEFORE the store is ready are applied over the loaded settings too", async () => {
    const mock = createMockAdapter();
    const store = createMemorySettingsStore({ _legacyKey: 1, driverName: "nick" });

    initGlobalSettings(mock.adapter, createMockLogger(), store);
    deleteGlobalSettings(["_legacyKey"]);
    await tick();

    expect((getGlobalSettings() as Record<string, unknown>)._legacyKey).toBeUndefined();
    expect(getGlobalSettings().driverName).toBe("nick");
    expect(store.saved.at(-1)).not.toHaveProperty("_legacyKey");
  });

  it("host payloads arriving after the store is ready are ignored for the cache (the host is not truth)", async () => {
    const mock = createMockAdapter();

    initGlobalSettings(mock.adapter, createMockLogger(), createMemorySettingsStore({ driverName: "nick" }));
    await tick();

    mock.echo?.({ driverName: "stale-host" });

    expect(getGlobalSettings().driverName).toBe("nick");
  });

  it("per-key salvage still applies to a partially-bad file: one bad value drops to its default, the rest load", async () => {
    const mock = createMockAdapter();

    initGlobalSettings(
      mock.adapter,
      createMockLogger(),
      createMemorySettingsStore({ driverName: "nick", changelogNotification: { bogus: true } }),
    );
    await tick();

    expect(getGlobalSettings().driverName).toBe("nick");
    expect(getGlobalSettings().changelogNotification).toBe("features");
  });

  it("a second initGlobalSettings is a no-op — the first store stays authoritative", async () => {
    const mock = createMockAdapter();
    const first = createMemorySettingsStore({ driverName: "nick" });
    const second = createMemorySettingsStore({ driverName: "other" });

    initGlobalSettings(mock.adapter, createMockLogger(), first);
    initGlobalSettings(mock.adapter, createMockLogger(), second);
    await tick();

    expect(getGlobalSettings().driverName).toBe("nick");
    expect(second.saved).toHaveLength(0);
  });

  it("a host payload racing the file load never overrides the file", async () => {
    const mock = createMockAdapter();
    const store = createMemorySettingsStore({ driverName: "file-nick" });

    initGlobalSettings(mock.adapter, createMockLogger(), store);
    // A Property Inspector save echoes before the file load resolves. It was
    // never asked for, so it is not a migration source — the file wins.
    mock.echo?.({ driverName: "host-nick" });
    await tick();

    expect(getGlobalSettings().driverName).toBe("file-nick");
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]).toMatchObject({ driverName: "file-nick" });
  });

  it("migrates from a host that answers getGlobalSettings synchronously, arming no deadline", async () => {
    vi.useFakeTimers();

    try {
      const holder: { echo: EchoCallback | null } = { echo: null };
      const adapter = {
        onDidReceiveGlobalSettings: (cb: EchoCallback) => {
          holder.echo = cb;
        },
        setGlobalSettings: vi.fn<(settings: Record<string, unknown>) => void>(),
        getGlobalSettings: vi.fn<() => void>(() => holder.echo?.({ driverName: "harness-nick" })),
      } as unknown as IDeckPlatformAdapter;

      initGlobalSettings(adapter, createMockLogger(), createMemorySettingsStore());
      await vi.advanceTimersByTimeAsync(0);

      expect(isSettingsStoreReady()).toBe(true);
      expect(getGlobalSettings().driverName).toBe("harness-nick");
      expect(vi.getTimerCount()).toBe(0); // no migration deadline left ticking
    } finally {
      vi.useRealTimers();
    }
  });

  it("an UNREADABLE file is retried with a doubling back-off, then the session runs on defaults WITHOUT saving over it", async () => {
    vi.useFakeTimers();

    try {
      const mock = createMockAdapter();
      const store = createUnreadableStore(LOAD_ATTEMPTS, { driverName: "nick" });

      initGlobalSettings(mock.adapter, createMockLogger(), store, { loadRetryDelayMs: 10 });
      // Retries at 10, 20, 40, 80, 160 ms after their predecessors: the second
      // attempt has run by 15 ms, the last one only after ~310 ms.
      await vi.advanceTimersByTimeAsync(15);
      expect(store.attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(400);

      expect(store.attempts).toBe(LOAD_ATTEMPTS);
      expect(isSettingsStoreReady()).toBe(false);
      expect(getGlobalSettings().driverName).toBe(""); // schema default
      // The whole point: a file we could not READ is never replaced with defaults.
      expect(store.saved).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);

      updateGlobalSettings({ driverName: "typed-this-session" });

      expect(getGlobalSettings().driverName).toBe("typed-this-session"); // read-your-writes
      expect(store.saved).toHaveLength(0); // still nothing may reach the file
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers when a transient read failure clears before the attempts run out", async () => {
    vi.useFakeTimers();

    try {
      const mock = createMockAdapter();
      const store = createUnreadableStore(1, { driverName: "nick" });

      initGlobalSettings(mock.adapter, createMockLogger(), store, { loadRetryDelayMs: 10 });
      await vi.advanceTimersByTimeAsync(5);
      expect(isSettingsStoreReady()).toBe(false);
      await vi.advanceTimersByTimeAsync(20);

      expect(store.attempts).toBe(2);
      expect(isSettingsStoreReady()).toBe(true);
      expect(getGlobalSettings().driverName).toBe("nick");
      expect(mock.getGlobalSettings).not.toHaveBeenCalled(); // the file was found, no migration
    } finally {
      vi.useRealTimers();
    }
  });

  it("LOAD_RETRY_DELAY_MS is one second and there are six attempts (~31 s of patience)", () => {
    expect(LOAD_ATTEMPTS).toBe(6);
    expect(LOAD_RETRY_DELAY_MS).toBe(1_000);
  });

  it("getSettingsStoreSource is null before ready, then names how the cache was filled", async () => {
    const mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger(), createMemorySettingsStore({ driverName: "nick" }));

    expect(getSettingsStoreSource()).toBeNull();
    await tick();
    expect(getSettingsStoreSource()).toBe("file");
  });

  it("hostMirrorPayload is the WHOLE cache plus _settingsChannel once ready from the file or the host", async () => {
    const mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger(), createMemorySettingsStore({ driverName: "nick" }));
    await tick();

    const mirror = hostMirrorPayload({ port: 4242, token: "t".repeat(48) });

    expect(mirror).toMatchObject({ driverName: "nick", _settingsChannel: { port: 4242, token: "t".repeat(48) } });
    expect(Object.keys(mirror ?? {}).length).toBeGreaterThan(50); // schema defaults are part of the mirror
  });

  it("hostMirrorPayload is undefined before the store is ready", () => {
    const mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger(), createMemorySettingsStore({ driverName: "nick" }));

    expect(hostMirrorPayload({ port: 1, token: "t".repeat(48) })).toBeUndefined();
  });

  it("hostMirrorPayload is undefined when the store started FRESH (migration timeout) — never write defaults over a host copy we could not read", async () => {
    vi.useFakeTimers();

    try {
      const mock = createMockAdapter();
      initGlobalSettings(mock.adapter, createMockLogger(), createMemorySettingsStore(), { migrationTimeoutMs: 20 });
      await vi.advanceTimersByTimeAsync(30);

      expect(getSettingsStoreSource()).toBe("fresh");
      expect(hostMirrorPayload({ port: 1, token: "t".repeat(48) })).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hostMirrorPayload after a host migration carries the migrated keys", async () => {
    const mock = createMockAdapter();
    initGlobalSettings(mock.adapter, createMockLogger(), createMemorySettingsStore());
    await tick();
    mock.echo?.({ driverName: "host-nick" });
    await tick();

    expect(getSettingsStoreSource()).toBe("host");
    expect(hostMirrorPayload({ port: 1, token: "t".repeat(48) })).toMatchObject({ driverName: "host-nick" });
  });
});

describe("run-scoped keys never reach the settings file (issue #1014)", () => {
  beforeEach(() => _resetGlobalSettings());

  const stored = (id: string) => JSON.stringify([{ id, level: "error", message: "from an earlier run" }]);

  it("drops a stored warning array instead of loading it into the cache", async () => {
    await initWithStore({ [PI_WARNINGS_KEY]: stored("settings-window-server"), driverName: "nick" });

    expect((getGlobalSettings() as Record<string, unknown>)[PI_WARNINGS_KEY]).toBeUndefined();
    expect(getGlobalSettings().driverName).toBe("nick");
  });

  it("cleans the stored warning array out of the file on the load-time re-save", async () => {
    const { store } = await initWithStore({ [PI_WARNINGS_KEY]: stored("settings-window-server"), driverName: "nick" });

    expect(store.saved.at(-1)).not.toHaveProperty(PI_WARNINGS_KEY);
    expect(store.saved.at(-1)).toMatchObject({ driverName: "nick" });
  });

  it("drops a warning array migrated from the deck host", async () => {
    const mock = createMockAdapter();
    const store = createMemorySettingsStore(); // no file: the host is asked once

    initGlobalSettings(mock.adapter, createMockLogger(), store);
    await tick();
    mock.echo?.({ driverName: "host-nick", [PI_WARNINGS_KEY]: stored("elevation-mismatch") });
    await tick();

    expect((getGlobalSettings() as Record<string, unknown>)[PI_WARNINGS_KEY]).toBeUndefined();
    expect(getGlobalSettings().driverName).toBe("host-nick");
    expect(store.saved.at(-1)).not.toHaveProperty(PI_WARNINGS_KEY);
  });

  it("keeps a warning raised this run in the cache and in the deck-host mirror", async () => {
    await initWithStore({ driverName: "nick" });

    setWarning("settings-window-server", "error", "raised this run");

    expect((getGlobalSettings() as Record<string, unknown>)[PI_WARNINGS_KEY]).toContain("raised this run");
    expect(hostMirrorPayload({ port: 1, token: "t".repeat(48) })?.[PI_WARNINGS_KEY]).toContain("raised this run");
  });

  it("never hands a warning raised this run to the store", async () => {
    const { store } = await initWithStore({ driverName: "nick" });

    setWarning("settings-window-server", "error", "raised this run");

    expect(store.saved.at(-1)).not.toHaveProperty(PI_WARNINGS_KEY);
    expect(store.saved.at(-1)).toMatchObject({ driverName: "nick" });
  });

  it("does not touch the store at all for a run-scoped-only write — the file cannot change", async () => {
    const { store } = await initWithStore({ driverName: "nick" });
    const before = store.saved.length;

    setWarning("settings-window-server", "error", "raised this run");

    expect(store.saved).toHaveLength(before);

    // A durable key in the same write still saves, warning and all.
    updateGlobalSettings({ driverName: "niklas" });

    expect(store.saved).toHaveLength(before + 1);
    expect(store.saved.at(-1)).not.toHaveProperty(PI_WARNINGS_KEY);
  });

  it("does not touch the store when a delete removes only run-scoped keys", async () => {
    const { store } = await initWithStore({ driverName: "nick" });

    setWarning("settings-window-server", "error", "raised this run");

    const before = store.saved.length;

    deleteGlobalSettings([PI_WARNINGS_KEY]);

    expect((getGlobalSettings() as Record<string, unknown>)[PI_WARNINGS_KEY]).toBeUndefined();
    expect(store.saved).toHaveLength(before);
  });

  it("still saves when a delete removes a durable key alongside a run-scoped one", async () => {
    // A passthrough key, not a schema field: deleting a schema field only puts
    // its default back, so the save would be indistinguishable from a no-op.
    const { store } = await initWithStore({ _lastSeenVersion: "3.0.0" });

    setWarning("settings-window-server", "error", "raised this run");

    const before = store.saved.length;

    deleteGlobalSettings([PI_WARNINGS_KEY, "_lastSeenVersion"]);

    expect(store.saved).toHaveLength(before + 1);
    expect(store.saved.at(-1)).not.toHaveProperty("_lastSeenVersion");
  });

  it("keeps a warning raised before the store loaded, while still dropping the stored one", async () => {
    const mock = createMockAdapter();
    const store = createMemorySettingsStore({ [PI_WARNINGS_KEY]: stored("stale"), driverName: "nick" });

    initGlobalSettings(mock.adapter, createMockLogger(), store);
    setWarning("live", "warning", "raised before the file loaded");
    await tick();

    const live = (getGlobalSettings() as Record<string, unknown>)[PI_WARNINGS_KEY];

    expect(live).toContain("raised before the file loaded");
    expect(live).not.toContain("from an earlier run");
    expect(store.saved.at(-1)).not.toHaveProperty(PI_WARNINGS_KEY);
  });
});

describe("Mouse to Sim pointer target (#1029)", () => {
  it("defaults to the placement #926 shipped", () => {
    const parsed = GlobalSettingsSchema.parse({});

    expect(parsed.mouseToSimAnchorX).toBe("center");
    expect(parsed.mouseToSimAnchorY).toBe("top");
    expect(parsed.mouseToSimOffsetX).toBe(0);
    expect(parsed.mouseToSimOffsetY).toBe(12.5);
  });

  it("keeps a configured target", () => {
    const parsed = GlobalSettingsSchema.parse({
      mouseToSimAnchorX: "right",
      mouseToSimAnchorY: "bottom",
      mouseToSimOffsetX: -5,
      mouseToSimOffsetY: -12.5,
    });

    expect(parsed.mouseToSimAnchorX).toBe("right");
    expect(parsed.mouseToSimAnchorY).toBe("bottom");
    expect(parsed.mouseToSimOffsetX).toBe(-5);
    expect(parsed.mouseToSimOffsetY).toBe(-12.5);
  });

  it("coerces the numeric strings the range input stores", () => {
    const parsed = GlobalSettingsSchema.parse({ mouseToSimOffsetX: "-25", mouseToSimOffsetY: "7.5" });

    expect(parsed.mouseToSimOffsetX).toBe(-25);
    expect(parsed.mouseToSimOffsetY).toBe(7.5);
  });

  it("treats the empty string an untouched range input stores as absent", () => {
    const parsed = GlobalSettingsSchema.parse({ mouseToSimOffsetX: "", mouseToSimOffsetY: "" });

    expect(parsed.mouseToSimOffsetX).toBe(0);
    expect(parsed.mouseToSimOffsetY).toBe(12.5);
  });

  it.each([
    ["an unknown anchor", { mouseToSimAnchorX: "sideways", mouseToSimAnchorY: "diagonal" }],
    ["an out-of-range offset", { mouseToSimOffsetX: 5000, mouseToSimOffsetY: -5000 }],
    ["a non-numeric offset", { mouseToSimOffsetX: "left-ish", mouseToSimOffsetY: {} }],
  ])("falls back to the defaults for %s without failing the parse", (_case, patch) => {
    const parsed = GlobalSettingsSchema.parse({ focusIRacingWindow: false, ...patch });

    expect(parsed.mouseToSimAnchorX).toBe("center");
    expect(parsed.mouseToSimAnchorY).toBe("top");
    expect(parsed.mouseToSimOffsetX).toBe(0);
    expect(parsed.mouseToSimOffsetY).toBe(12.5);
    // The parse as a whole must survive — one throwing field stalls every setting (#896).
    expect(parsed.focusIRacingWindow).toBe(false);
  });
});
