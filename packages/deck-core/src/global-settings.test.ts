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

  it("rejects values below 0", () => {
    expect(() => GlobalSettingsSchema.parse({ flagFlashDurationSeconds: -1 })).toThrow();
  });

  it("rejects values above 30", () => {
    expect(() => GlobalSettingsSchema.parse({ flagFlashDurationSeconds: 31 })).toThrow();
  });
});
