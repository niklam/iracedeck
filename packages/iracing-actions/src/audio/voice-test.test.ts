import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VoiceLineOptions } from "./audio-toggles.js";
import { playRaceEngineerVoiceTest, VOICE_TEST_FIRE_ID } from "./voice-test.js";

const hoisted = vi.hoisted(() => ({
  driverNameClipPath: vi.fn((voice: string, name: string) => `voice/${voice}/names/${name}.mp3`),
  resolveActiveRaceEngineerVoice: vi.fn<(voices: readonly string[]) => string | null>(() => "default"),
  resolveActiveDriverName: vi.fn<(names: readonly string[], def?: string) => string | null>(() => "niklas"),
  playVoiceLine: vi.fn<(id: string, paths: readonly string[], options: VoiceLineOptions) => "playing" | "bus-busy">(
    () => "playing",
  ),
  readJsonStringArray: vi.fn<(key: string) => string[]>(() => []),
}));

vi.mock("@iracedeck/audio-scenarios/pit-crew", () => ({ driverNameClipPath: hoisted.driverNameClipPath }));

vi.mock("@iracedeck/settings", () => ({
  resolveActiveDriverName: hoisted.resolveActiveDriverName,
  resolveActiveRaceEngineerVoice: hoisted.resolveActiveRaceEngineerVoice,
}));

vi.mock("./audio-toggles.js", () => ({
  playVoiceLine: hoisted.playVoiceLine,
  readJsonStringArray: hoisted.readJsonStringArray,
}));

describe("playRaceEngineerVoiceTest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.resolveActiveRaceEngineerVoice.mockReturnValue("default");
    hoisted.resolveActiveDriverName.mockReturnValue("niklas");
    hoisted.playVoiceLine.mockReturnValue("playing");
  });

  it("plays the driver's name, then the greeting, cutting in on a busy radio (#1698)", () => {
    expect(playRaceEngineerVoiceTest()).toBe("playing");

    expect(hoisted.playVoiceLine).toHaveBeenCalledWith(
      VOICE_TEST_FIRE_ID,
      ["voice/default/names/niklas.mp3", "voice/default/welcome/greeting-01.mp3"],
      { whenBusy: "interrupt" },
    );
  });

  it("plays under a fire id outside every contract namespace", () => {
    expect(VOICE_TEST_FIRE_ID).toBe("preview.voice-test");
  });

  it("opens with the name clip the voice actually has, a take included (#1173)", () => {
    // A pack that records names only as takes has no `names/niklas.mp3`;
    // `driverNameClipPath` finds `names/niklas-01.mp3` in its place.
    hoisted.resolveActiveRaceEngineerVoice.mockReturnValue("snoop");
    hoisted.driverNameClipPath.mockReturnValueOnce("voice/snoop/names/niklas-01.mp3");

    playRaceEngineerVoiceTest();

    expect(hoisted.driverNameClipPath).toHaveBeenCalledWith("snoop", "niklas");
    expect(hoisted.playVoiceLine.mock.calls[0][1]).toEqual([
      "voice/snoop/names/niklas-01.mp3",
      "voice/snoop/welcome/greeting-01.mp3",
    ]);
  });

  it("plays the greeting alone when no name is available", () => {
    hoisted.resolveActiveDriverName.mockReturnValue(null);

    playRaceEngineerVoiceTest();

    expect(hoisted.driverNameClipPath).not.toHaveBeenCalled();
    expect(hoisted.playVoiceLine.mock.calls[0][1]).toEqual(["voice/default/welcome/greeting-01.mp3"]);
  });

  it("answers no-voice and plays nothing when no voice is available", () => {
    hoisted.resolveActiveRaceEngineerVoice.mockReturnValue(null);

    expect(playRaceEngineerVoiceTest()).toBe("no-voice");
    expect(hoisted.playVoiceLine).not.toHaveBeenCalled();
  });

  it("answers bus-busy when a heavier call holds the radio (#1698)", () => {
    hoisted.playVoiceLine.mockReturnValue("bus-busy");

    expect(playRaceEngineerVoiceTest()).toBe("bus-busy");
  });

  it("hands the completion callback through", () => {
    const onComplete = vi.fn();

    playRaceEngineerVoiceTest(onComplete);

    expect(hoisted.playVoiceLine.mock.calls[0][2]).toEqual({ whenBusy: "interrupt", onComplete });
    expect(hoisted.playVoiceLine.mock.calls[0][2].onComplete).toBe(onComplete);
  });
});
