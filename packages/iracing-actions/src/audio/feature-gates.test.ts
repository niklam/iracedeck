import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetFeatureGateSync,
  armFeatureGateSync,
  syncFeatureGates,
  toggleRaceEngineerFeature,
  toggleRadarFeature,
} from "./feature-gates.js";

const hoisted = vi.hoisted(() => {
  const setBusVolume = vi.fn();
  const playOnChannel = vi.fn<(...args: unknown[]) => boolean>().mockReturnValue(true);
  const onChannelComplete = vi.fn();
  const getAudio = vi.fn(() => ({ setBusVolume, playOnChannel, onChannelComplete }));

  const setRadarEnabled = vi.fn();
  const stopRaceEngineerScenarios = vi.fn();
  const isBackgroundTestInFlight = vi.fn(() => false);

  let globalSettings: Record<string, unknown> = {};
  const updateGlobalSettings = vi.fn((partial: Record<string, unknown>) => {
    globalSettings = { ...globalSettings, ...partial };
  });
  const getGlobalSettings = vi.fn(() => globalSettings);
  const resolveActiveRaceEngineerVoice = vi.fn(() => "default");

  return {
    setBusVolume,
    playOnChannel,
    onChannelComplete,
    getAudio,
    setRadarEnabled,
    stopRaceEngineerScenarios,
    isBackgroundTestInFlight,
    updateGlobalSettings,
    getGlobalSettings,
    resolveActiveRaceEngineerVoice,
    setGlobalSettings: (next: Record<string, unknown>) => {
      globalSettings = next;
    },
  };
});

vi.mock("@iracedeck/audio-scenarios/pit-crew", () => ({
  isBackgroundTestInFlight: hoisted.isBackgroundTestInFlight,
  setRadarEnabled: hoisted.setRadarEnabled,
  stopRaceEngineerScenarios: hoisted.stopRaceEngineerScenarios,
}));

vi.mock("@iracedeck/audio-service", () => ({
  AudioBus: { Voice: 0, Background: 1, Alerts: 2 },
  AudioChannel: { Voice: 0 },
  getAudio: hoisted.getAudio,
}));

vi.mock("@iracedeck/deck-core", () => ({
  getGlobalSettings: hoisted.getGlobalSettings,
  updateGlobalSettings: hoisted.updateGlobalSettings,
  resolveActiveRaceEngineerVoice: hoisted.resolveActiveRaceEngineerVoice,
}));

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withLevel: vi.fn(),
  createScope: vi.fn(),
} as unknown as import("@iracedeck/logger").ILogger;

/** The Voice channel id from the AudioChannel mock above. */
const VOICE = 0;

/** A settings cache with a voice available, so acknowledgments can play. */
const withVoices = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  _raceEngineerVoices: '["default"]',
  ...extra,
});

describe("feature gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.setGlobalSettings(withVoices());
    _resetFeatureGateSync();
  });

  describe("toggleRaceEngineerFeature", () => {
    it("turns the gate on, persists it and plays the resuming acknowledgment", () => {
      expect(toggleRaceEngineerFeature(logger)).toBe(true);

      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ pitCrewRaceEngineerEnabled: true });
      expect(hoisted.playOnChannel).toHaveBeenCalledWith(VOICE, "voice/default/toggle/resuming-01.mp3");
    });

    it("stops in-flight scenarios and plays going-silent when turning off", () => {
      hoisted.setGlobalSettings(withVoices({ pitCrewRaceEngineerEnabled: true }));

      expect(toggleRaceEngineerFeature(logger)).toBe(false);

      expect(hoisted.stopRaceEngineerScenarios).toHaveBeenCalledTimes(1);
      expect(hoisted.playOnChannel).toHaveBeenCalledWith(VOICE, "voice/default/toggle/going-silent-01.mp3");
    });

    it("skips the acknowledgment when the per-callout opt-in is off", () => {
      hoisted.setGlobalSettings(withVoices({ calloutEnabledToggleRaceEngineer: false }));

      toggleRaceEngineerFeature(logger);

      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("still flips the gate when no voice is available (acknowledgment skipped silently)", () => {
      // `Once`, not `mockReturnValue` — vi.clearAllMocks() does not restore an
      // overridden return value, so it would leak into the next test.
      hoisted.resolveActiveRaceEngineerVoice.mockReturnValueOnce(null as never);

      expect(toggleRaceEngineerFeature(logger)).toBe(true);

      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ pitCrewRaceEngineerEnabled: true });
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("does not double-apply when an armed listener already handled the write", () => {
      armFeatureGateSync();
      // Reproduce the plugin wiring: updateGlobalSettings fires
      // onGlobalSettingsChange synchronously, which calls syncFeatureGates.
      // `Once`, not `mockImplementation` — vi.clearAllMocks() does not restore
      // an overridden implementation, so it would leak into the next test.
      hoisted.updateGlobalSettings.mockImplementationOnce((partial: Record<string, unknown>) => {
        hoisted.setGlobalSettings({ ...hoisted.getGlobalSettings(), ...partial });
        syncFeatureGates(logger);
      });

      toggleRaceEngineerFeature(logger);

      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    });
  });

  describe("toggleRadarFeature", () => {
    it("turns the radar engine on and persists the gate", () => {
      expect(toggleRadarFeature(logger)).toBe(true);

      expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(true);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ pitCrewRadarEnabled: true });
    });

    it("turns the radar engine off again", () => {
      hoisted.setGlobalSettings(withVoices({ pitCrewRadarEnabled: true }));

      expect(toggleRadarFeature(logger)).toBe(false);

      expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(false);
    });
  });

  describe("syncFeatureGates", () => {
    it("applies nothing while dormant, so the startup write is silent", () => {
      hoisted.setGlobalSettings(withVoices({ pitCrewRaceEngineerEnabled: true }));

      syncFeatureGates(logger);

      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
      expect(hoisted.setRadarEnabled).not.toHaveBeenCalled();
    });

    it("seeds silently when armed", () => {
      hoisted.setGlobalSettings(withVoices({ pitCrewRaceEngineerEnabled: true }));

      armFeatureGateSync();
      syncFeatureGates(logger);

      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("applies an externally written gate change (the settings window checkbox)", () => {
      armFeatureGateSync();
      hoisted.setGlobalSettings(withVoices({ pitCrewRaceEngineerEnabled: true }));

      syncFeatureGates(logger);

      expect(hoisted.playOnChannel).toHaveBeenCalledWith(VOICE, "voice/default/toggle/resuming-01.mp3");
    });

    it("stops scenarios when an external write turns the engineer off", () => {
      hoisted.setGlobalSettings(withVoices({ pitCrewRaceEngineerEnabled: true }));
      armFeatureGateSync();
      hoisted.setGlobalSettings(withVoices({ pitCrewRaceEngineerEnabled: false }));

      syncFeatureGates(logger);

      expect(hoisted.stopRaceEngineerScenarios).toHaveBeenCalledTimes(1);
    });

    it("applies an externally written radar change", () => {
      armFeatureGateSync();
      hoisted.setGlobalSettings(withVoices({ pitCrewRadarEnabled: true }));

      syncFeatureGates(logger);

      expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(true);
    });

    it("applies nothing when the gates are unchanged", () => {
      armFeatureGateSync();

      syncFeatureGates(logger);
      syncFeatureGates(logger);

      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
      expect(hoisted.setRadarEnabled).not.toHaveBeenCalled();
    });

    it("swallows an audio fault and still syncs the other gate", () => {
      // This runs inside updateGlobalSettings' listener fan-out, which has no
      // try/catch and saves the cache only after it returns — a throw escaping
      // here would abort the remaining listeners and lose the gate write.
      hoisted.setGlobalSettings(withVoices({ pitCrewRaceEngineerEnabled: true }));
      armFeatureGateSync();
      hoisted.stopRaceEngineerScenarios.mockImplementationOnce(() => {
        throw new Error("audio engine unavailable");
      });
      hoisted.setGlobalSettings(withVoices({ pitCrewRaceEngineerEnabled: false, pitCrewRadarEnabled: true }));

      expect(() => syncFeatureGates(logger)).not.toThrow();

      expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(true);
    });
  });
});
