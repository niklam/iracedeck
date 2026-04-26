import type { ILogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetGlobalSettings,
  getGlobalSettings,
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
    updateGlobalSettings({ radarEnabled: false });

    expect((getGlobalSettings() as Record<string, unknown>).radarEnabled).toBe(false);
  });

  it("alternates radarEnabled across consecutive local writes without any host echo", () => {
    updateGlobalSettings({ radarEnabled: false });
    expect((getGlobalSettings() as Record<string, unknown>).radarEnabled).toBe(false);

    updateGlobalSettings({ radarEnabled: true });
    expect((getGlobalSettings() as Record<string, unknown>).radarEnabled).toBe(true);

    updateGlobalSettings({ radarEnabled: false });
    expect((getGlobalSettings() as Record<string, unknown>).radarEnabled).toBe(false);

    // No echo has fired yet — the adapter's echo callback was captured
    // but never invoked.
    expect(mock.echo).not.toBeNull();
  });

  it("matches the toggle pattern used by Pit Crew (read → flip → write → read)", () => {
    // Simulates toggleRadar: reads isRadarEnabled(), flips, writes. The
    // production helper uses `=== true` (default-off semantic, #378), so
    // the first read on an unset cache returns false → flip → write true.
    const readFlipWrite = () => {
      const current = (getGlobalSettings() as Record<string, unknown>).radarEnabled === true;
      updateGlobalSettings({ radarEnabled: !current });
    };

    readFlipWrite();
    expect((getGlobalSettings() as Record<string, unknown>).radarEnabled).toBe(true);

    readFlipWrite();
    expect((getGlobalSettings() as Record<string, unknown>).radarEnabled).toBe(false);

    readFlipWrite();
    expect((getGlobalSettings() as Record<string, unknown>).radarEnabled).toBe(true);
  });

  it("applies the same behaviour to raceEngineerEnabled (same toggle code path)", () => {
    updateGlobalSettings({ raceEngineerEnabled: false });
    expect((getGlobalSettings() as Record<string, unknown>).raceEngineerEnabled).toBe(false);

    updateGlobalSettings({ raceEngineerEnabled: true });
    expect((getGlobalSettings() as Record<string, unknown>).raceEngineerEnabled).toBe(true);
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
    updateGlobalSettings({ radarEnabled: false });

    expect(mock.setGlobalSettings).toHaveBeenCalledTimes(1);
    const sent = mock.setGlobalSettings.mock.calls[0][0] as Record<string, unknown>;
    // Assert both the partial override and the Zod-produced defaults are
    // all present — this proves the adapter receives the parsed result,
    // not just the caller's bare partial.
    expect(sent).toMatchObject({
      radarEnabled: false,
      raceEngineerEnabled: false,
      radarVolume: 100,
      disableWhenDisconnected: true,
      focusIRacingWindow: false,
      enableFuelingOnChange: true,
      simHubHost: "127.0.0.1",
      simHubPort: 8888,
    });
  });

  it("reconciles on host echo without losing later local writes' semantics", () => {
    updateGlobalSettings({ radarEnabled: false });
    expect((getGlobalSettings() as Record<string, unknown>).radarEnabled).toBe(false);

    // initGlobalSettings must register an echo callback; fail loudly if
    // not, otherwise the reconciliation step below silently skips.
    expect(mock.echo).not.toBeNull();

    // Host finally echoes the earlier write — cache stays false.
    mock.echo!({ radarEnabled: false });
    expect((getGlobalSettings() as Record<string, unknown>).radarEnabled).toBe(false);

    // New local write still flips immediately.
    updateGlobalSettings({ radarEnabled: true });
    expect((getGlobalSettings() as Record<string, unknown>).radarEnabled).toBe(true);
  });

  it("no-ops when the adapter is not initialized", () => {
    _resetGlobalSettings();
    // Not calling initGlobalSettings — adapterRef stays null.

    updateGlobalSettings({ radarEnabled: true });

    // No throw; cache stays at the schema default (false per #378).
    expect((getGlobalSettings() as Record<string, unknown>).radarEnabled).toBe(false);
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
