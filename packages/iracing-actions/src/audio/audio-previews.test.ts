import { type ILogger, silentLogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AUDIO_PREVIEW_KINDS, isAudioPreviewKind, runAudioPreview } from "./audio-previews.js";

const mocks = vi.hoisted(() => ({
  playRadarTest: vi.fn(),
  playBackgroundTest: vi.fn(),
  playRaceEngineerVoiceTest: vi.fn(() => true),
  setBusVolume: vi.fn(),
  applyRaceEngineerAudio: vi.fn(),
  setRaceEngineerTestInFlight: vi.fn(),
  readRaceEngineerVolume: vi.fn(() => 80),
  readBackgroundVolume: vi.fn(() => 40),
}));

vi.mock("@iracedeck/audio-scenarios/pit-crew", () => ({
  playRadarTest: mocks.playRadarTest,
  playBackgroundTest: mocks.playBackgroundTest,
}));
vi.mock("@iracedeck/audio-service", () => ({
  AudioBus: { Voice: "voice", Background: "background" },
  getAudio: () => ({ setBusVolume: mocks.setBusVolume }),
}));
vi.mock("./audio-volume.js", () => ({
  applyRaceEngineerAudio: mocks.applyRaceEngineerAudio,
  setRaceEngineerTestInFlight: mocks.setRaceEngineerTestInFlight,
  readRaceEngineerVolume: mocks.readRaceEngineerVolume,
  readBackgroundVolume: mocks.readBackgroundVolume,
}));
vi.mock("./voice-test.js", () => ({
  playRaceEngineerVoiceTest: mocks.playRaceEngineerVoiceTest,
}));

const logger: ILogger = { ...silentLogger, warn: vi.fn(), info: vi.fn() };

describe("runAudioPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.playRaceEngineerVoiceTest.mockReturnValue(true);
  });

  it("radar: plays the radar test", () => {
    runAudioPreview("radar", logger);

    expect(mocks.playRadarTest).toHaveBeenCalledTimes(1);
  });

  it("voice: forces the Voice bus to the slider value, marks the test in flight, restores on completion", () => {
    let onComplete: (() => void) | undefined;
    mocks.playRaceEngineerVoiceTest.mockImplementation((cb?: () => void) => {
      onComplete = cb;

      return true;
    });

    runAudioPreview("voice", logger);

    expect(mocks.setRaceEngineerTestInFlight).toHaveBeenCalledWith(true);
    expect(mocks.setBusVolume).toHaveBeenCalledWith("voice", 0.8);
    onComplete?.();
    expect(mocks.setRaceEngineerTestInFlight).toHaveBeenLastCalledWith(false);
    expect(mocks.applyRaceEngineerAudio).toHaveBeenCalled();
  });

  it("voice: when no voice is available, clears the in-flight flag and warns", () => {
    mocks.playRaceEngineerVoiceTest.mockReturnValue(false);

    runAudioPreview("voice", logger);

    expect(mocks.setRaceEngineerTestInFlight).toHaveBeenLastCalledWith(false);
    expect(mocks.applyRaceEngineerAudio).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("background: forces the Background bus to the slider value and restores on completion", () => {
    runAudioPreview("background", logger);

    expect(mocks.setBusVolume).toHaveBeenCalledWith("background", 0.4);
    expect(mocks.playBackgroundTest).toHaveBeenCalledWith(expect.any(Function));
  });

  it("exposes the kinds and a type guard so a page-supplied string can be validated", () => {
    expect(AUDIO_PREVIEW_KINDS).toEqual(["radar", "voice", "background"]);
    expect(isAudioPreviewKind("voice")).toBe(true);
    expect(isAudioPreviewKind("nope")).toBe(false);
    expect(isAudioPreviewKind(42)).toBe(false);
  });
});
