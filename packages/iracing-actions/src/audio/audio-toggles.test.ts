import { type PlayClipsOptions, WEIGHT } from "@iracedeck/audio-scenarios";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isCornerNamesEnabled,
  isCornerNamesToggleAckEnabled,
  isSectorStartsEnabled,
  isToggleAckEnabled,
  playKeyAck,
  playToggleAck,
  playTrackCallsAck,
  playVoiceLine,
  readJsonStringArray,
  toggleCornerNamesFeature,
  toggleTrackCallouts,
} from "./audio-toggles.js";
import { setRaceEngineerToggleInFlight } from "./audio-volume.js";

// The scenario engine every plugin-played Voice line goes through (#1698).
// Uninitialised by default, so a test that does not opt in plays straight onto
// the Voice channel, the fallback; `WEIGHT` and the rest stay real.
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

/**
 * Make the fake engine behave as `"interrupt"` does on a running clip fire: a
 * new `playClips` call cuts the line still playing, which settles — runs its
 * `onComplete` — inside the new call, before the new line takes the bus.
 */
function cutThePreviousLineOnEachPlay(): void {
  let running: (() => void) | undefined;
  scenarios.playClips.mockImplementation((_id, _paths, options) => {
    const cut = running;
    running = options.onComplete;
    cut?.();

    return "playing";
  });
}

/** The Voice bus (id 0 in the AudioBus mock) volumes written since the last clear. */
function voiceWrites(): unknown[] {
  return hoisted.setBusVolume.mock.calls.filter(([bus]) => bus === 0).map(([, value]) => value);
}

const hoisted = vi.hoisted(() => {
  const setBusVolume = vi.fn();
  const playOnChannel = vi.fn<(...args: unknown[]) => boolean>().mockReturnValue(true);
  const onChannelComplete = vi.fn();
  const getAudio = vi.fn(() => ({ setBusVolume, playOnChannel, onChannelComplete }));

  // audio-volume (imported transitively) reads this; the master-gate toggles
  // that used the rest of this module moved to feature-gates.ts (#1007).
  const isBackgroundTestInFlight = vi.fn(() => false);

  let globalSettings: Record<string, unknown> = {};
  const updateGlobalSettings = vi.fn((partial: Record<string, unknown>) => {
    globalSettings = { ...globalSettings, ...partial };
  });
  const getGlobalSettings = vi.fn(() => globalSettings);
  // The real write goes through updateGlobalSettings; so does this one, so the flip is read back.
  const setCalloutEnabled = vi.fn((key: string, enabled: boolean) => updateGlobalSettings({ [key]: enabled }));
  // Like the real helper: every key in ONE updateGlobalSettings call.
  const setCalloutsEnabled = vi.fn((keys: readonly string[], enabled: boolean) =>
    updateGlobalSettings(Object.fromEntries(keys.map((key) => [key, enabled]))),
  );
  // The real lookup reads the parsed cache; here it reads the same mocked settings object.
  const isCalloutEnabled = vi.fn((key: string) => getGlobalSettings()[key] !== false);
  const resolveActiveRaceEngineerVoice = vi.fn(() => "default");

  return {
    setBusVolume,
    playOnChannel,
    onChannelComplete,
    getAudio,
    isBackgroundTestInFlight,
    updateGlobalSettings,
    setCalloutEnabled,
    setCalloutsEnabled,
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
  setCalloutEnabled: hoisted.setCalloutEnabled,
  setCalloutsEnabled: hoisted.setCalloutsEnabled,
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
    hoisted.playOnChannel.mockReturnValue(true);
    scenarios.setInitialized(false);
    scenarios.playClips.mockImplementation(() => "playing");
    setRaceEngineerToggleInFlight(false);
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

  describe("toggleTrackCallouts (issues #897, #1699)", () => {
    const VOICES = JSON.stringify(["default"]);

    /** Settings with the master on and a voice available, so the ack plays. */
    function withAck(extra: Record<string, unknown> = {}): void {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, _raceEngineerVoices: VOICES, ...extra });
    }

    function state(): { corners: boolean; sectors: boolean } {
      return {
        corners: hoisted.getGlobalSettings().calloutEnabledCornerNames !== false,
        sectors: hoisted.getGlobalSettings().calloutEnabledSectorStarts !== false,
      };
    }

    describe("corners", () => {
      it("flips only the corner-name opt-in, both ways", () => {
        withAck();

        expect(toggleTrackCallouts("corners", logger)).toEqual({ corners: false });
        expect(state()).toEqual({ corners: false, sectors: true });

        expect(toggleTrackCallouts("corners", logger)).toEqual({ corners: true });
        expect(state()).toEqual({ corners: true, sectors: true });

        expect(hoisted.updateGlobalSettings.mock.calls.map(([partial]) => partial)).toEqual([
          { calloutEnabledCornerNames: false },
          { calloutEnabledCornerNames: true },
        ]);
      });

      it("plays the corner-names ack for the resulting state", () => {
        withAck();

        toggleTrackCallouts("corners", logger);
        expect(hoisted.playOnChannel).toHaveBeenLastCalledWith(0, "voice/default/toggle/corner-names-off-01.mp3");

        toggleTrackCallouts("corners", logger);
        expect(hoisted.playOnChannel).toHaveBeenLastCalledWith(0, "voice/default/toggle/corner-names-on-01.mp3");
      });

      it("logs one info line naming the target and the result", () => {
        withAck();

        toggleTrackCallouts("corners", logger);
        toggleTrackCallouts("corners", logger);

        expect(vi.mocked(logger.info).mock.calls).toEqual([
          ["Corner name callouts disabled"],
          ["Corner name callouts enabled"],
        ]);
      });
    });

    describe("sectors", () => {
      it("flips only the sector-start opt-in, both ways", () => {
        withAck();

        expect(toggleTrackCallouts("sectors", logger)).toEqual({ sectors: false });
        expect(state()).toEqual({ corners: true, sectors: false });

        expect(toggleTrackCallouts("sectors", logger)).toEqual({ sectors: true });
        expect(state()).toEqual({ corners: true, sectors: true });

        expect(hoisted.updateGlobalSettings.mock.calls.map(([partial]) => partial)).toEqual([
          { calloutEnabledSectorStarts: false },
          { calloutEnabledSectorStarts: true },
        ]);
      });

      it("plays the sector-starts ack for the resulting state", () => {
        withAck();

        toggleTrackCallouts("sectors", logger);
        expect(hoisted.playOnChannel).toHaveBeenLastCalledWith(0, "voice/default/toggle/sector-starts-off-01.mp3");

        toggleTrackCallouts("sectors", logger);
        expect(hoisted.playOnChannel).toHaveBeenLastCalledWith(0, "voice/default/toggle/sector-starts-on-01.mp3");
      });

      it("logs one info line naming the target and the result", () => {
        withAck();

        toggleTrackCallouts("sectors", logger);
        toggleTrackCallouts("sectors", logger);

        expect(vi.mocked(logger.info).mock.calls).toEqual([["Sector callouts disabled"], ["Sector callouts enabled"]]);
      });
    });

    describe("both", () => {
      it.each([
        { from: { corners: true, sectors: true }, to: false },
        { from: { corners: false, sectors: false }, to: true },
        { from: { corners: true, sectors: false }, to: false },
        { from: { corners: false, sectors: true }, to: false },
      ])("from corners $from.corners / sectors $from.sectors sets both to $to in one write", ({ from, to }) => {
        withAck({ calloutEnabledCornerNames: from.corners, calloutEnabledSectorStarts: from.sectors });

        expect(toggleTrackCallouts("both", logger)).toEqual({ corners: to, sectors: to });
        expect(state()).toEqual({ corners: to, sectors: to });

        expect(hoisted.setCalloutsEnabled).toHaveBeenCalledTimes(1);
        expect(hoisted.setCalloutsEnabled).toHaveBeenCalledWith(
          ["calloutEnabledCornerNames", "calloutEnabledSectorStarts"],
          to,
        );
        expect(hoisted.setCalloutEnabled).not.toHaveBeenCalled();
        expect(hoisted.updateGlobalSettings).toHaveBeenCalledTimes(1);
        expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({
          calloutEnabledCornerNames: to,
          calloutEnabledSectorStarts: to,
        });

        expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
        expect(hoisted.playOnChannel).toHaveBeenCalledWith(
          0,
          `voice/default/toggle/track-calls-${to ? "on" : "off"}-01.mp3`,
        );
        expect(vi.mocked(logger.info).mock.calls).toEqual([
          [`Corner and sector callouts ${to ? "enabled" : "disabled"}`],
        ]);
      });
    });

    describe("the acknowledgment's gates", () => {
      const TARGETS = ["corners", "sectors", "both"] as const;

      it.each(TARGETS)("%s toggles silently when the Race Engineer master gate is off", (target) => {
        hoisted.setGlobalSettings({ _raceEngineerVoices: VOICES });

        toggleTrackCallouts(target, logger);

        expect(hoisted.updateGlobalSettings).toHaveBeenCalledTimes(1);
        expect(hoisted.playOnChannel).not.toHaveBeenCalled();
      });

      it.each(TARGETS)("%s toggles silently when the ack opt-in is off", (target) => {
        withAck({ calloutEnabledToggleCornerNames: false });

        toggleTrackCallouts(target, logger);

        expect(hoisted.updateGlobalSettings).toHaveBeenCalledTimes(1);
        expect(hoisted.playOnChannel).not.toHaveBeenCalled();
      });

      it.each(TARGETS)("%s still toggles when no voice is available, with a debug line", (target) => {
        hoisted.resolveActiveRaceEngineerVoice.mockReturnValue(null as never);
        hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true });

        toggleTrackCallouts(target, logger);

        expect(hoisted.updateGlobalSettings).toHaveBeenCalledTimes(1);
        // From the default on/on, each target turns off what it names.
        expect(state()).toEqual({ corners: target === "sectors", sectors: target === "corners" });
        expect(hoisted.playOnChannel).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("no voice available"));
      });
    });
  });

  describe("playTrackCallsAck (#1699)", () => {
    it("plays the clip by path from the active voice's toggle group", () => {
      hoisted.resolveActiveRaceEngineerVoice.mockReturnValue("pack::voice" as never);

      playTrackCallsAck("track-calls-on-01", logger);

      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
      expect(hoisted.playOnChannel).toHaveBeenCalledWith(0, "voice/pack::voice/toggle/track-calls-on-01.mp3");
    });

    it("plays nothing and logs at debug when no voice is available", () => {
      hoisted.resolveActiveRaceEngineerVoice.mockReturnValue(null as never);

      playTrackCallsAck("sector-starts-off-01", logger);

      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith("Key ack sector-starts-off-01 skipped — no voice available");
    });
  });

  describe("toggleCornerNamesFeature (deprecated, removed by #1699 T2)", () => {
    it("delegates to the corners target and returns its new state", () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, _raceEngineerVoices: JSON.stringify(["default"]) });

      expect(toggleCornerNamesFeature(logger)).toBe(false);
      expect(hoisted.setCalloutEnabled).toHaveBeenCalledWith("calloutEnabledCornerNames", false);
      expect(hoisted.playOnChannel).toHaveBeenCalledWith(0, "voice/default/toggle/corner-names-off-01.mp3");

      expect(toggleCornerNamesFeature(logger)).toBe(true);
    });
  });

  describe("toggleTrackCallouts through the scheduler (#1698, #1699)", () => {
    beforeEach(() => {
      scenarios.setInitialized(true);
    });

    it.each([
      ["corners", "corner-names-off-01"],
      ["sectors", "sector-starts-off-01"],
      ["both", "track-calls-off-01"],
    ] as const)("%s plays %s as a key ack that cuts in, never straight onto Voice", (target, clip) => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, _raceEngineerVoices: JSON.stringify(["default"]) });

      toggleTrackCallouts(target, logger);

      expect(scenarios.playClips.mock.calls).toEqual([
        [`toggle.${clip}`, [`voice/default/toggle/${clip}.mp3`], { weight: WEIGHT.NORMAL, whenBusy: "interrupt" }],
      ]);
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("toggles silently when the master gate or the ack opt-in is off", () => {
      hoisted.setGlobalSettings({ _raceEngineerVoices: JSON.stringify(["default"]) });
      expect(toggleTrackCallouts("corners", logger)).toEqual({ corners: false });

      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, calloutEnabledToggleCornerNames: false });
      expect(toggleTrackCallouts("both", logger)).toEqual({ corners: false, sectors: false });

      expect(scenarios.playClips).not.toHaveBeenCalled();
    });

    it("still toggles when a heavier call holds the radio, saying so at debug", () => {
      scenarios.playClips.mockImplementation(() => "bus-busy");
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true });

      expect(toggleTrackCallouts("sectors", logger)).toEqual({ sectors: false });

      expect(hoisted.setCalloutEnabled).toHaveBeenCalledWith("calloutEnabledSectorStarts", false);
      expect(logger.debug).toHaveBeenCalledWith(
        "Key ack sector-starts-off-01 skipped — the engineer holds the radio for a heavier call",
      );
    });
  });

  describe("playVoiceLine (#1698)", () => {
    const PATHS = ["voice/default/a.mp3", "voice/default/b.mp3"];

    it("hands the line to the scheduler at NORMAL weight while the engine is up, and answers with it", () => {
      scenarios.setInitialized(true);
      const onComplete = vi.fn();

      expect(playVoiceLine("toggle.x", PATHS, { whenBusy: "skip", onComplete })).toBe("playing");
      scenarios.playClips.mockImplementation(() => "bus-busy");
      expect(playVoiceLine("toggle.y", PATHS, { whenBusy: "interrupt" })).toBe("bus-busy");

      expect(scenarios.playClips.mock.calls).toEqual([
        ["toggle.x", PATHS, { weight: WEIGHT.NORMAL, whenBusy: "skip", onComplete }],
        ["toggle.y", PATHS, { weight: WEIGHT.NORMAL, whenBusy: "interrupt" }],
      ]);
      expect(scenarios.playClips.mock.calls[0]?.[2].onComplete).toBe(onComplete);
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("plays straight onto the Voice channel while the engine is not initialised, completing at the chain's end", () => {
      const onComplete = vi.fn();

      expect(playVoiceLine("toggle.x", PATHS, { whenBusy: "interrupt", onComplete })).toBe("playing");

      expect(scenarios.getScenarioEngine).not.toHaveBeenCalled();
      expect(hoisted.playOnChannel).toHaveBeenCalledWith(0, PATHS[0]);

      // The native layer ends each clip; the chain plays the next, then completes.
      (hoisted.onChannelComplete.mock.calls.at(-1)?.[1] as () => void)();
      expect(hoisted.playOnChannel).toHaveBeenLastCalledWith(0, PATHS[1]);
      expect(onComplete).not.toHaveBeenCalled();
      (hoisted.onChannelComplete.mock.calls.at(-1)?.[1] as () => void)();
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("throws on an empty line in both modes", () => {
      expect(() => playVoiceLine("toggle.x", [], { whenBusy: "skip" })).toThrow("no clips");

      scenarios.setInitialized(true);
      expect(() => playVoiceLine("toggle.x", [], { whenBusy: "skip" })).toThrow("no clips");
      expect(scenarios.playClips).not.toHaveBeenCalled();
    });
  });

  describe("playKeyAck (#1698)", () => {
    it("plays the active voice's toggle clip through the scheduler, cutting in, under toggle.<clip>", () => {
      scenarios.setInitialized(true);

      playKeyAck("corner-names-on-01", logger);

      expect(scenarios.playClips.mock.calls).toEqual([
        [
          "toggle.corner-names-on-01",
          ["voice/default/toggle/corner-names-on-01.mp3"],
          { weight: WEIGHT.NORMAL, whenBusy: "interrupt" },
        ],
      ]);
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("plays straight onto the Voice channel while the engine is not initialised", () => {
      playKeyAck("corner-names-on-01", logger);

      expect(scenarios.getScenarioEngine).not.toHaveBeenCalled();
      expect(hoisted.playOnChannel.mock.calls).toEqual([[0, "voice/default/toggle/corner-names-on-01.mp3"]]);
    });

    it("plays nothing and says so at debug when no voice is available", () => {
      scenarios.setInitialized(true);
      hoisted.resolveActiveRaceEngineerVoice.mockReturnValue(null as never);

      playKeyAck("corner-names-on-01", logger);

      expect(scenarios.playClips).not.toHaveBeenCalled();
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith("Key ack corner-names-on-01 skipped — no voice available");
    });

    it("leaves the ack out at debug, without throwing, when a heavier call holds the radio", () => {
      scenarios.setInitialized(true);
      scenarios.playClips.mockImplementation(() => "bus-busy");

      expect(() => playKeyAck("corner-names-on-01", logger)).not.toThrow();

      expect(logger.debug).toHaveBeenCalledWith(
        "Key ack corner-names-on-01 skipped — the engineer holds the radio for a heavier call",
      );
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });
  });

  describe("playToggleAck (#1698)", () => {
    beforeEach(() => {
      // The Race Engineer is off, so Voice is muted unless the toggle bypass holds it.
      hoisted.setGlobalSettings({ raceEngineerVolume: 80 });
    });

    /** The `onComplete` the n-th `playClips` call was handed. */
    function completionOf(call: number): () => void {
      const onComplete = scenarios.playClips.mock.calls[call]?.[2].onComplete;

      if (!onComplete) throw new Error(`playClips call ${call} carried no onComplete`);

      return onComplete;
    }

    it("raises the bypass, forces Voice to the slider and plays through the scheduler, cutting in", () => {
      scenarios.setInitialized(true);

      playToggleAck("going-silent-01", logger);

      expect(voiceWrites()).toEqual([0.8]);
      expect(scenarios.playClips.mock.calls).toEqual([
        [
          "toggle.going-silent-01",
          ["voice/default/toggle/going-silent-01.mp3"],
          { weight: WEIGHT.NORMAL, whenBusy: "interrupt", onComplete: expect.any(Function) },
        ],
      ]);
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("lowers the bypass and re-applies the gate when the line is over", () => {
      scenarios.setInitialized(true);
      playToggleAck("going-silent-01", logger);
      hoisted.setBusVolume.mockClear();

      completionOf(0)();

      // Race Engineer off and no bypass: Voice mutes.
      expect(voiceWrites()).toEqual([0]);
    });

    it("lowers the bypass and re-applies the gate itself on bus-busy, where the line never started", () => {
      scenarios.setInitialized(true);
      scenarios.playClips.mockImplementation(() => "bus-busy");

      playToggleAck("resuming-01", logger);

      expect(voiceWrites()).toEqual([0.8, 0]);
      expect(logger.debug).toHaveBeenCalledWith(
        "Toggle ack resuming-01 skipped — the engineer holds the radio for a heavier call",
      );
    });

    it("lowers the bypass and re-applies the gate when the play throws, then rethrows", () => {
      scenarios.setInitialized(true);
      scenarios.playClips.mockImplementation(() => {
        throw new Error("boom");
      });

      expect(() => playToggleAck("resuming-01", logger)).toThrow("boom");

      // Raised to the slider for the ack, then back to the gate: Race Engineer off, no bypass.
      expect(voiceWrites()).toEqual([0.8, 0]);
    });

    it("an earlier ack's completion, run inside the newer ack's play because it cut it, leaves the newer bypass alone", () => {
      // Off, on, off quickly: each ack cuts the one before inside its own
      // playClips, after its own claim raised the bypass.
      scenarios.setInitialized(true);
      cutThePreviousLineOnEachPlay();

      playToggleAck("going-silent-01", logger);
      playToggleAck("resuming-01", logger);
      playToggleAck("going-silent-01", logger);

      // Each ack forced Voice up once; no cut ack's completion muted it.
      expect(voiceWrites()).toEqual([0.8, 0.8, 0.8]);

      // Called late, the cut acks' completions do nothing either.
      completionOf(0)();
      completionOf(1)();
      expect(voiceWrites()).toEqual([0.8, 0.8, 0.8]);

      // The last ack's completion is the one that puts the bus back.
      completionOf(2)();
      expect(voiceWrites()).toEqual([0.8, 0.8, 0.8, 0]);
    });

    it("plays straight onto the Voice channel while the engine is not initialised, lowering the bypass at the clip's end", () => {
      playToggleAck("resuming-01", logger);

      expect(scenarios.getScenarioEngine).not.toHaveBeenCalled();
      expect(hoisted.playOnChannel.mock.calls).toEqual([[0, "voice/default/toggle/resuming-01.mp3"]]);
      expect(voiceWrites()).toEqual([0.8]);

      (hoisted.onChannelComplete.mock.calls.at(-1)?.[1] as () => void)();

      expect(voiceWrites()).toEqual([0.8, 0]);
    });

    it("plays nothing and raises no bypass when no voice is available", () => {
      scenarios.setInitialized(true);
      hoisted.resolveActiveRaceEngineerVoice.mockReturnValue(null as never);

      playToggleAck("resuming-01", logger);

      expect(scenarios.playClips).not.toHaveBeenCalled();
      expect(voiceWrites()).toEqual([]);
      expect(logger.debug).toHaveBeenCalledWith("Toggle ack resuming-01 skipped — no voice available");
    });
  });

  describe("isCornerNamesEnabled / isSectorStartsEnabled / isCornerNamesToggleAckEnabled", () => {
    it("default to enabled and only an explicit false opts out", () => {
      expect(isCornerNamesEnabled()).toBe(true);
      expect(isSectorStartsEnabled()).toBe(true);
      expect(isCornerNamesToggleAckEnabled()).toBe(true);

      hoisted.setGlobalSettings({
        calloutEnabledCornerNames: false,
        calloutEnabledSectorStarts: false,
        calloutEnabledToggleCornerNames: false,
      });
      expect(isCornerNamesEnabled()).toBe(false);
      expect(isSectorStartsEnabled()).toBe(false);
      expect(isCornerNamesToggleAckEnabled()).toBe(false);
    });

    it("read each opt-in on its own", () => {
      hoisted.setGlobalSettings({ calloutEnabledSectorStarts: false });

      expect(isCornerNamesEnabled()).toBe(true);
      expect(isSectorStartsEnabled()).toBe(false);
    });
  });
});
