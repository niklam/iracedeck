import { beforeEach, describe, expect, it, vi } from "vitest";

import { playRaceEngineerVoiceTest } from "./voice-test.js";

const hoisted = vi.hoisted(() => ({
  driverNameClipPath: vi.fn((voice: string, name: string) => `voice/${voice}/names/${name}.mp3`),
  resolveActiveRaceEngineerVoice: vi.fn<(voices: readonly string[]) => string | null>(() => "default"),
  resolveActiveDriverName: vi.fn<(names: readonly string[], def?: string) => string | null>(() => "niklas"),
  playVoiceSequence: vi.fn<(paths: readonly string[], onComplete?: () => void) => boolean>(() => true),
  readJsonStringArray: vi.fn<(key: string) => string[]>(() => []),
}));

vi.mock("@iracedeck/audio-scenarios/pit-crew", () => ({ driverNameClipPath: hoisted.driverNameClipPath }));

vi.mock("@iracedeck/deck-core", () => ({
  resolveActiveDriverName: hoisted.resolveActiveDriverName,
  resolveActiveRaceEngineerVoice: hoisted.resolveActiveRaceEngineerVoice,
}));

vi.mock("./audio-toggles.js", () => ({
  playVoiceSequence: hoisted.playVoiceSequence,
  readJsonStringArray: hoisted.readJsonStringArray,
}));

describe("playRaceEngineerVoiceTest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.resolveActiveRaceEngineerVoice.mockReturnValue("default");
    hoisted.resolveActiveDriverName.mockReturnValue("niklas");
  });

  it("plays the driver's name, then the greeting", () => {
    expect(playRaceEngineerVoiceTest()).toBe(true);

    expect(hoisted.playVoiceSequence).toHaveBeenCalledWith(
      ["voice/default/names/niklas.mp3", "voice/default/welcome/greeting-01.mp3"],
      undefined,
    );
  });

  it("opens with the name clip the voice actually has, a take included (#1173)", () => {
    // A pack that records names only as takes has no `names/niklas.mp3`;
    // `driverNameClipPath` finds `names/niklas-01.mp3` in its place.
    hoisted.resolveActiveRaceEngineerVoice.mockReturnValue("snoop");
    hoisted.driverNameClipPath.mockReturnValueOnce("voice/snoop/names/niklas-01.mp3");

    playRaceEngineerVoiceTest();

    expect(hoisted.driverNameClipPath).toHaveBeenCalledWith("snoop", "niklas");
    expect(hoisted.playVoiceSequence.mock.calls[0][0]).toEqual([
      "voice/snoop/names/niklas-01.mp3",
      "voice/snoop/welcome/greeting-01.mp3",
    ]);
  });

  it("plays the greeting alone when no name is available", () => {
    hoisted.resolveActiveDriverName.mockReturnValue(null);

    playRaceEngineerVoiceTest();

    expect(hoisted.driverNameClipPath).not.toHaveBeenCalled();
    expect(hoisted.playVoiceSequence.mock.calls[0][0]).toEqual(["voice/default/welcome/greeting-01.mp3"]);
  });

  it("returns false and plays nothing when no voice is available", () => {
    hoisted.resolveActiveRaceEngineerVoice.mockReturnValue(null);

    expect(playRaceEngineerVoiceTest()).toBe(false);
    expect(hoisted.playVoiceSequence).not.toHaveBeenCalled();
  });

  it("hands the completion callback through", () => {
    const onComplete = vi.fn();

    playRaceEngineerVoiceTest(onComplete);

    expect(hoisted.playVoiceSequence.mock.calls[0][1]).toBe(onComplete);
  });
});
