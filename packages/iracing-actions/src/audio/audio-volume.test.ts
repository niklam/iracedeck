import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyRaceEngineerAudio,
  applyRadarVolume,
  isRaceEngineerEnabled,
  isRadarEnabled,
  readBackgroundVolume,
  readRaceEngineerVolume,
  readRadarVolume,
  setRaceEngineerTestInFlight,
  setRaceEngineerToggleInFlight,
  stepRaceEngineerVolume,
  stepRaceEngineerVolumeBy,
  stepRadarVolume,
  stepRadarVolumeBy,
  stopRaceEngineerPlayback,
  VOLUME_MAX,
} from "./audio-volume.js";

const hoisted = vi.hoisted(() => {
  const setBusVolume = vi.fn();
  const stopChannel = vi.fn();
  const getAudio = vi.fn(() => ({ setBusVolume, stopChannel }));
  const stopRaceEngineerScenarios = vi.fn();
  const isBackgroundTestInFlight = vi.fn(() => false);

  let globalSettings: Record<string, unknown> = {};
  const updateGlobalSettings = vi.fn((partial: Record<string, unknown>) => {
    globalSettings = { ...globalSettings, ...partial };
  });
  const getGlobalSettings = vi.fn(() => globalSettings);

  return {
    setBusVolume,
    stopChannel,
    stopRaceEngineerScenarios,
    getAudio,
    isBackgroundTestInFlight,
    updateGlobalSettings,
    getGlobalSettings,
    setGlobalSettings: (next: Record<string, unknown>) => {
      globalSettings = next;
    },
  };
});

vi.mock("@iracedeck/audio-scenarios/pit-crew", () => ({
  isBackgroundTestInFlight: hoisted.isBackgroundTestInFlight,
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
}));

describe("audio-volume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.setGlobalSettings({});
    setRaceEngineerTestInFlight(false);
    setRaceEngineerToggleInFlight(false);
  });

  afterEach(() => {
    setRaceEngineerTestInFlight(false);
    setRaceEngineerToggleInFlight(false);
  });

  describe("volume readers", () => {
    it("defaults to VOLUME_MAX when the global is missing", () => {
      expect(readRadarVolume()).toBe(VOLUME_MAX);
      expect(readRaceEngineerVolume()).toBe(VOLUME_MAX);
      expect(readBackgroundVolume()).toBe(VOLUME_MAX);
    });

    it("reads numeric values straight through", () => {
      hoisted.setGlobalSettings({ radarVolume: 40, raceEngineerVolume: 60, backgroundVolume: 25 });

      expect(readRadarVolume()).toBe(40);
      expect(readRaceEngineerVolume()).toBe(60);
      expect(readBackgroundVolume()).toBe(25);
    });

    it("coerces string values and rounds", () => {
      hoisted.setGlobalSettings({ radarVolume: "42.6" });

      expect(readRadarVolume()).toBe(43);
    });

    it("clamps out-of-range values", () => {
      hoisted.setGlobalSettings({ radarVolume: 250 });
      expect(readRadarVolume()).toBe(100);

      hoisted.setGlobalSettings({ radarVolume: -10 });
      expect(readRadarVolume()).toBe(0);
    });

    it("falls back to VOLUME_MAX on NaN", () => {
      hoisted.setGlobalSettings({ radarVolume: "not-a-number" });
      expect(readRadarVolume()).toBe(VOLUME_MAX);
    });
  });

  describe("feature gates", () => {
    it("isRaceEngineerEnabled is true only for an explicit true", () => {
      expect(isRaceEngineerEnabled()).toBe(false);

      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: "true" });
      expect(isRaceEngineerEnabled()).toBe(false);

      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true });
      expect(isRaceEngineerEnabled()).toBe(true);
    });

    it("isRadarEnabled is true only for an explicit true", () => {
      expect(isRadarEnabled()).toBe(false);

      hoisted.setGlobalSettings({ pitCrewRadarEnabled: true });
      expect(isRadarEnabled()).toBe(true);
    });
  });

  describe("applyRadarVolume", () => {
    it("copies radarVolume onto AudioBus.Alerts", () => {
      hoisted.setGlobalSettings({ radarVolume: 50 });
      applyRadarVolume();

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.5);
    });
  });

  describe("applyRaceEngineerAudio", () => {
    it("tracks raceEngineerVolume on Voice and backgroundVolume on Background when enabled", () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, raceEngineerVolume: 60, backgroundVolume: 40 });
      applyRaceEngineerAudio();

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0.6);
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(1, 0.4);
    });

    it("zeroes Voice and Background when disabled", () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, raceEngineerVolume: 90, backgroundVolume: 90 });
      applyRaceEngineerAudio();

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0);
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(1, 0);
    });

    it("never touches AudioBus.Alerts", () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, raceEngineerVolume: 75 });
      applyRaceEngineerAudio();

      const alertsCalls = hoisted.setBusVolume.mock.calls.filter(([bus]) => bus === 2);
      expect(alertsCalls).toHaveLength(0);
    });

    it("keeps Voice audible while a Voice Test is in flight even with RE off", () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, raceEngineerVolume: 70 });
      setRaceEngineerTestInFlight(true);
      applyRaceEngineerAudio();

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0.7);
    });

    it("keeps Voice audible while a toggle ack is in flight even with RE off", () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, raceEngineerVolume: 70 });
      setRaceEngineerToggleInFlight(true);
      applyRaceEngineerAudio();

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0.7);
    });

    it("keeps Background audible while a Background Test is in flight even with RE off", () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, backgroundVolume: 80 });
      hoisted.isBackgroundTestInFlight.mockReturnValueOnce(true);
      applyRaceEngineerAudio();

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(1, 0.8);
    });
  });

  describe("stepRadarVolume", () => {
    it("steps up by 5, persists, and applies to Alerts", () => {
      hoisted.setGlobalSettings({ radarVolume: 70 });

      expect(stepRadarVolume("up")).toBe(75);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ radarVolume: 75 });
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.75);
    });

    it("steps down by 5", () => {
      hoisted.setGlobalSettings({ radarVolume: 70 });

      expect(stepRadarVolume("down")).toBe(65);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ radarVolume: 65 });
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.65);
    });

    it("is a no-op at the upper boundary", () => {
      hoisted.setGlobalSettings({ radarVolume: 100 });

      expect(stepRadarVolume("up")).toBe(100);
      expect(hoisted.updateGlobalSettings).not.toHaveBeenCalled();
      expect(hoisted.setBusVolume).not.toHaveBeenCalled();
    });

    it("is a no-op at the lower boundary", () => {
      hoisted.setGlobalSettings({ radarVolume: 0 });

      expect(stepRadarVolume("down")).toBe(0);
      expect(hoisted.updateGlobalSettings).not.toHaveBeenCalled();
      expect(hoisted.setBusVolume).not.toHaveBeenCalled();
    });
  });

  describe("stepRadarVolumeBy", () => {
    it("steps by ticks × 5 and clamps at both boundaries", () => {
      hoisted.setGlobalSettings({ radarVolume: 50 });
      expect(stepRadarVolumeBy(3)).toBe(65);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ radarVolume: 65 });
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.65);

      hoisted.setGlobalSettings({ radarVolume: 95 });
      expect(stepRadarVolumeBy(4)).toBe(100);

      hoisted.setGlobalSettings({ radarVolume: 5 });
      expect(stepRadarVolumeBy(-2)).toBe(0);
    });

    it("is a no-op (no persist, no bus write) when already clamped at the boundary", () => {
      hoisted.setGlobalSettings({ radarVolume: 100 });

      expect(stepRadarVolumeBy(2)).toBe(100);
      expect(hoisted.updateGlobalSettings).not.toHaveBeenCalled();
      expect(hoisted.setBusVolume).not.toHaveBeenCalled();
    });
  });

  describe("stepRaceEngineerVolumeBy", () => {
    it("steps by ticks × 5 and re-applies the gate", () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, raceEngineerVolume: 50 });

      expect(stepRaceEngineerVolumeBy(-3)).toBe(35);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ raceEngineerVolume: 35 });
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0.35);
    });

    it("persists the value but keeps Voice muted while Race Engineer is off", () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, raceEngineerVolume: 50 });

      expect(stepRaceEngineerVolumeBy(2)).toBe(60);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ raceEngineerVolume: 60 });
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0);
    });
  });

  describe("stepRaceEngineerVolume", () => {
    it("steps up by 5, persists, and re-applies the gate (audible when enabled)", () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, raceEngineerVolume: 50, backgroundVolume: 25 });

      expect(stepRaceEngineerVolume("up")).toBe(55);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ raceEngineerVolume: 55 });
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0.55);
    });

    it("persists the new value but keeps Voice muted when Race Engineer is disabled", () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, raceEngineerVolume: 50 });

      expect(stepRaceEngineerVolume("up")).toBe(55);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ raceEngineerVolume: 55 });
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0);
    });

    it("is a no-op at the upper boundary", () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, raceEngineerVolume: 100 });

      expect(stepRaceEngineerVolume("up")).toBe(100);
      expect(hoisted.updateGlobalSettings).not.toHaveBeenCalled();
      expect(hoisted.setBusVolume).not.toHaveBeenCalled();
    });

    it("is a no-op at the lower boundary", () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, raceEngineerVolume: 0 });

      expect(stepRaceEngineerVolume("down")).toBe(0);
      expect(hoisted.updateGlobalSettings).not.toHaveBeenCalled();
      expect(hoisted.setBusVolume).not.toHaveBeenCalled();
    });
  });
});

describe("stopRaceEngineerPlayback (#1100)", () => {
  // Its own reset: this block sits outside the `audio-volume` describe whose
  // beforeEach clears the mocks, so without this the call counts accumulate
  // across cases and a "called once" assertion reads whatever ran before it.
  beforeEach(() => {
    vi.clearAllMocks();
    setRaceEngineerTestInFlight(false);
    setRaceEngineerToggleInFlight(false);
  });

  // Both bypass flags are released by the same mechanism `stopChannel` severs —
  // the voice-sequence completion chain — and the scenario engine owns neither,
  // so stopping playback has to clear both itself. Missing one leaves it true
  // for the process lifetime, holding the Voice bus open while the master gate
  // says off. The first version of this function cleared the Test flag and
  // missed the toggle flag, which is why the test drives both.
  it.each([
    ["the Test bypass", () => setRaceEngineerTestInFlight(true)],
    ["the toggle bypass", () => setRaceEngineerToggleInFlight(true)],
    [
      "both at once",
      () => {
        setRaceEngineerTestInFlight(true);
        setRaceEngineerToggleInFlight(true);
      },
    ],
  ])("silences the Voice bus after interrupting %s", (_label, raise) => {
    hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, raceEngineerVolume: 60 });
    raise();

    stopRaceEngineerPlayback();

    // Asserted on the effect the flags exist to produce: with the engineer off,
    // a stranded bypass IS a non-zero Voice bus.
    expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0);
  });

  it("stops the engine and the channel", () => {
    stopRaceEngineerPlayback();

    expect(hoisted.stopRaceEngineerScenarios).toHaveBeenCalledTimes(1);
    expect(hoisted.stopChannel).toHaveBeenCalledTimes(1);
  });

  // The installer wraps this call and swallows a throw, so an exception here
  // would silently leave the bypass raised and the bus open.
  it("still clears the bypass when stopping the engine throws", () => {
    hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, raceEngineerVolume: 60 });
    setRaceEngineerTestInFlight(true);
    hoisted.stopRaceEngineerScenarios.mockImplementationOnce(() => {
      throw new Error("engine is wedged");
    });

    expect(() => stopRaceEngineerPlayback()).toThrow("engine is wedged");
    expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0);
  });
});
