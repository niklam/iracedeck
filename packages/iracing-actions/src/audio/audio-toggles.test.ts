import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isToggleAckEnabled,
  readJsonStringArray,
  toggleRaceEngineerFeature,
  toggleRadarFeature,
} from "./audio-toggles.js";

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

describe("audio-toggles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.setGlobalSettings({});
    hoisted.resolveActiveRaceEngineerVoice.mockReturnValue("default");
  });

  describe("isToggleAckEnabled", () => {
    it("defaults to enabled and only an explicit false opts out", () => {
      expect(isToggleAckEnabled()).toBe(true);

      hoisted.setGlobalSettings({ calloutEnabledToggleRaceEngineer: false });
      expect(isToggleAckEnabled()).toBe(false);
    });
  });

  describe("readJsonStringArray", () => {
    it("parses a JSON string array and filters non-strings", () => {
      hoisted.setGlobalSettings({ _list: JSON.stringify(["a", "", 1, "b"]) });
      expect(readJsonStringArray("_list")).toEqual(["a", "b"]);
    });

    it("returns empty on missing or malformed values", () => {
      expect(readJsonStringArray("_missing")).toEqual([]);

      hoisted.setGlobalSettings({ _bad: "{not json" });
      expect(readJsonStringArray("_bad")).toEqual([]);
    });
  });

  describe("toggleRaceEngineerFeature", () => {
    it("enables the gate, persists, applies audio, and returns true", () => {
      hoisted.setGlobalSettings({ _raceEngineerVoices: JSON.stringify(["default"]) });

      expect(toggleRaceEngineerFeature(logger)).toBe(true);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ pitCrewRaceEngineerEnabled: true });
      expect(hoisted.stopRaceEngineerScenarios).not.toHaveBeenCalled();
      // Ack plays (opt-in defaults on): Voice bus forced audible + clip started.
      expect(hoisted.playOnChannel).toHaveBeenCalledWith(0, "voice/default/toggle/resuming-01.mp3");
    });

    it("disables the gate, stops in-flight scenarios, and returns false", () => {
      hoisted.setGlobalSettings({
        pitCrewRaceEngineerEnabled: true,
        _raceEngineerVoices: JSON.stringify(["default"]),
      });

      expect(toggleRaceEngineerFeature(logger)).toBe(false);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ pitCrewRaceEngineerEnabled: false });
      expect(hoisted.stopRaceEngineerScenarios).toHaveBeenCalledTimes(1);
      expect(hoisted.playOnChannel).toHaveBeenCalledWith(0, "voice/default/toggle/going-silent-01.mp3");
    });

    it("skips the ack when the per-callout opt-in is off", () => {
      hoisted.setGlobalSettings({ calloutEnabledToggleRaceEngineer: false });

      toggleRaceEngineerFeature(logger);
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("still toggles when no voice is available (ack skipped silently)", () => {
      hoisted.resolveActiveRaceEngineerVoice.mockReturnValue(null as never);

      expect(toggleRaceEngineerFeature(logger)).toBe(true);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ pitCrewRaceEngineerEnabled: true });
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });
  });

  describe("toggleRadarFeature", () => {
    it("flips the engine synchronously and persists the gate", () => {
      expect(toggleRadarFeature(logger)).toBe(true);
      expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(true);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ pitCrewRadarEnabled: true });

      hoisted.setGlobalSettings({ pitCrewRadarEnabled: true });
      expect(toggleRadarFeature(logger)).toBe(false);
      expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(false);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ pitCrewRadarEnabled: false });
    });
  });
});
