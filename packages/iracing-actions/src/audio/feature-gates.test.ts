import { type PlayClipsOptions, WEIGHT } from "@iracedeck/audio-scenarios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  // The real lookup reads the parsed cache; here it reads the same mocked settings object.
  const isCalloutEnabled = vi.fn((key: string) => getGlobalSettings()[key] !== false);
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
    isCalloutEnabled,
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

// The scenario engine the acknowledgments play through (#1698). Uninitialised
// by default, so the tests above play straight onto the Voice channel, the
// fallback; `WEIGHT` and the rest stay real.
const scenarios = vi.hoisted(() => {
  let initialized = false;
  const playClips = vi.fn<(id: string, paths: readonly string[], options: PlayClipsOptions) => "playing" | "bus-busy">(
    () => "playing",
  );

  return {
    playClips,
    isAudioScenariosInitialized: vi.fn(() => initialized),
    getScenarioEngine: vi.fn(() => ({ playClips })),
    setInitialized: (value: boolean): void => {
      initialized = value;
    },
  };
});

vi.mock("@iracedeck/audio-scenarios", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/audio-scenarios")>()),
  getScenarioEngine: scenarios.getScenarioEngine,
  isAudioScenariosInitialized: scenarios.isAudioScenariosInitialized,
}));

vi.mock("@iracedeck/audio-service", () => ({
  AudioBus: { Voice: 0, Background: 1, Alerts: 2 },
  AudioChannel: { Voice: 0 },
  getAudio: hoisted.getAudio,
}));

vi.mock("@iracedeck/settings", () => ({
  getGlobalSettings: hoisted.getGlobalSettings,
  isCalloutEnabled: hoisted.isCalloutEnabled,
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

  describe("toggleRaceEngineerFeature through the scheduler (#1698)", () => {
    /** The line on the bus: an ack cuts it, and the engine's stopAll settles it. */
    let running: (() => void) | undefined;

    beforeEach(() => {
      running = undefined;
      scenarios.setInitialized(true);
      scenarios.playClips.mockImplementation((_id, _paths, options) => {
        const cut = running;
        running = options.onComplete;
        cut?.();

        return "playing";
      });
      hoisted.stopRaceEngineerScenarios.mockImplementation(() => {
        const stopped = running;
        running = undefined;
        stopped?.();
      });
      hoisted.setGlobalSettings(withVoices({ raceEngineerVolume: 80 }));
    });

    afterEach(() => {
      // End the ack still playing, so its bypass does not outlive the test.
      running?.();
      scenarios.setInitialized(false);
      scenarios.playClips.mockReset();
      hoisted.stopRaceEngineerScenarios.mockReset();
    });

    /** The Voice bus (id 0) volumes written since the last clear. */
    function voiceWrites(): unknown[] {
      return hoisted.setBusVolume.mock.calls.filter(([bus]) => bus === 0).map(([, value]) => value);
    }

    it("plays each acknowledgment as a NORMAL clip fire that cuts in, never straight onto Voice", () => {
      toggleRaceEngineerFeature(logger);
      toggleRaceEngineerFeature(logger);

      expect(
        scenarios.playClips.mock.calls.map(([id, paths, options]) => [id, paths, options.weight, options.whenBusy]),
      ).toEqual([
        ["toggle.resuming-01", ["voice/default/toggle/resuming-01.mp3"], WEIGHT.NORMAL, "interrupt"],
        ["toggle.going-silent-01", ["voice/default/toggle/going-silent-01.mp3"], WEIGHT.NORMAL, "interrupt"],
      ]);
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("off, on and off quickly: no earlier ack's completion mutes the final going silent", () => {
      hoisted.setGlobalSettings(withVoices({ raceEngineerVolume: 80, pitCrewRaceEngineerEnabled: true }));

      toggleRaceEngineerFeature(logger); // off: going silent
      toggleRaceEngineerFeature(logger); // on: resuming cuts it
      hoisted.setBusVolume.mockClear();
      toggleRaceEngineerFeature(logger); // off: stopAll settles resuming, then going silent

      // Whatever the earlier acks' completions did, the last Voice write
      // leaves the bus audible for the ack now playing.
      expect(voiceWrites().at(-1)).toBe(0.8);

      // That ack's completion is the one that mutes Voice.
      hoisted.setBusVolume.mockClear();
      running?.();
      expect(voiceWrites()).toEqual([0]);
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

    it("retries a gate change whose side effects failed", () => {
      // The tracker is recorded only after the effects succeed, so a swallowed
      // fault leaves the change pending instead of marking it done forever.
      hoisted.setGlobalSettings(withVoices({ pitCrewRaceEngineerEnabled: true }));
      armFeatureGateSync();
      hoisted.stopRaceEngineerScenarios.mockImplementationOnce(() => {
        throw new Error("audio engine unavailable");
      });
      hoisted.setGlobalSettings(withVoices({ pitCrewRaceEngineerEnabled: false }));

      syncFeatureGates(logger);
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();

      // Same (unchanged) gate value on the next settings arrival: the failed
      // work runs again and completes this time.
      syncFeatureGates(logger);

      expect(hoisted.stopRaceEngineerScenarios).toHaveBeenCalledTimes(2);
      expect(hoisted.playOnChannel).toHaveBeenCalledWith(VOICE, "voice/default/toggle/going-silent-01.mp3");
    });
  });
});
