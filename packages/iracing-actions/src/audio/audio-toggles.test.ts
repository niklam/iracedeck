import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isCornerNamesEnabled,
  isCornerNamesToggleAckEnabled,
  isToggleAckEnabled,
  readJsonStringArray,
  toggleCornerNamesFeature,
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

  describe("toggleCornerNamesFeature (issue #897)", () => {
    it("disables from the default-on state, persists, and plays the off ack when the master is on", () => {
      hoisted.setGlobalSettings({
        pitCrewRaceEngineerEnabled: true,
        _raceEngineerVoices: JSON.stringify(["default"]),
      });

      expect(toggleCornerNamesFeature(logger)).toBe(false);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ calloutEnabledCornerNames: false });
      expect(hoisted.playOnChannel).toHaveBeenCalledWith(0, "voice/default/toggle/corner-names-off-01.mp3");
    });

    it("re-enables from off and plays the on ack", () => {
      hoisted.setGlobalSettings({
        calloutEnabledCornerNames: false,
        pitCrewRaceEngineerEnabled: true,
        _raceEngineerVoices: JSON.stringify(["default"]),
      });

      expect(toggleCornerNamesFeature(logger)).toBe(true);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ calloutEnabledCornerNames: true });
      expect(hoisted.playOnChannel).toHaveBeenCalledWith(0, "voice/default/toggle/corner-names-on-01.mp3");
    });

    it("toggles silently when the Race Engineer master gate is off", () => {
      hoisted.setGlobalSettings({ _raceEngineerVoices: JSON.stringify(["default"]) });

      expect(toggleCornerNamesFeature(logger)).toBe(false);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ calloutEnabledCornerNames: false });
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("toggles silently when the ack opt-in is off", () => {
      hoisted.setGlobalSettings({
        pitCrewRaceEngineerEnabled: true,
        calloutEnabledToggleCornerNames: false,
        _raceEngineerVoices: JSON.stringify(["default"]),
      });

      toggleCornerNamesFeature(logger);
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("still toggles when no voice is available (ack skipped silently)", () => {
      hoisted.resolveActiveRaceEngineerVoice.mockReturnValue(null as never);
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true });

      expect(toggleCornerNamesFeature(logger)).toBe(false);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ calloutEnabledCornerNames: false });
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });
  });

  describe("isCornerNamesEnabled / isCornerNamesToggleAckEnabled", () => {
    it("default to enabled and only an explicit false opts out", () => {
      expect(isCornerNamesEnabled()).toBe(true);
      expect(isCornerNamesToggleAckEnabled()).toBe(true);

      hoisted.setGlobalSettings({ calloutEnabledCornerNames: false, calloutEnabledToggleCornerNames: false });
      expect(isCornerNamesEnabled()).toBe(false);
      expect(isCornerNamesToggleAckEnabled()).toBe(false);
    });
  });
});
