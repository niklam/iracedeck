import { type ILogger, silentLogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AUDIO_PREVIEW_KINDS, isAudioPreviewKind, runAudioPreview } from "./audio-previews.js";
import { applyRaceEngineerAudio, setRaceEngineerTestInFlight } from "./audio-volume.js";

const mocks = vi.hoisted(() => {
  let globalSettings: Record<string, unknown> = {};

  return {
    playRadarTest: vi.fn(),
    playBackgroundTest: vi.fn((): string => "voice-frame"),
    playRaceEngineerVoiceTest: vi.fn<(onComplete?: () => void) => "playing" | "bus-busy" | "no-voice">(() => "playing"),
    setBusVolume: vi.fn(),
    readFrameOptions: vi.fn(() => ({ beeps: true, ambience: true })),
    playPressSound: vi.fn(),
    getGlobalSettings: vi.fn(() => globalSettings),
    setGlobalSettings: (next: Record<string, unknown>): void => {
      globalSettings = next;
    },
  };
});

vi.mock("@iracedeck/audio-scenarios/pit-crew", () => ({
  playRadarTest: mocks.playRadarTest,
  playBackgroundTest: mocks.playBackgroundTest,
  isBackgroundTestInFlight: () => false,
  stopRaceEngineerScenarios: vi.fn(),
}));
vi.mock("@iracedeck/audio-service", () => ({
  AudioBus: { Voice: "voice", Background: "background", Alerts: "alerts" },
  AudioChannel: { Voice: "voice" },
  getAudio: () => ({ setBusVolume: mocks.setBusVolume }),
}));
vi.mock("@iracedeck/settings", () => ({
  frameOptionsFromSettings: vi.fn(),
  getGlobalSettings: mocks.getGlobalSettings,
  updateGlobalSettings: vi.fn(),
}));
// The real bypass flags and gate (#1698): the Voice Test's in-flight handling
// is checked by what `applyRaceEngineerAudio` then does to the Voice bus. Only
// the frame switches are stubbed, so each test can hand in its own.
vi.mock("./audio-volume.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./audio-volume.js")>()),
  readFrameOptions: mocks.readFrameOptions,
}));
vi.mock("./volume-tick.js", () => ({ playVolumeTick: vi.fn() }));
vi.mock("./press-sounds.js", () => ({
  playPressSound: mocks.playPressSound,
}));
vi.mock("./voice-test.js", () => ({
  playRaceEngineerVoiceTest: mocks.playRaceEngineerVoiceTest,
}));

const logger: ILogger = { ...silentLogger, warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

/** The Voice bus volumes written since the last clear, in order. */
function voiceWrites(): unknown[] {
  return mocks.setBusVolume.mock.calls.filter(([bus]) => bus === "voice").map(([, value]) => value);
}

/**
 * Whether the Test bypass is still raised: with the Race Engineer off, the
 * gate leaves Voice at the slider value only while a bypass holds it.
 */
function testBypassRaised(): boolean {
  mocks.setBusVolume.mockClear();
  applyRaceEngineerAudio();

  return voiceWrites().at(-1) === 0.8;
}

/** Start a voice Test and return the completion it handed the player. */
function startVoiceTest(): () => void {
  let onComplete: (() => void) | undefined;
  mocks.playRaceEngineerVoiceTest.mockImplementationOnce((cb?: () => void) => {
    onComplete = cb;

    return "playing";
  });

  runAudioPreview("voice", logger);

  if (!onComplete) throw new Error("the voice Test handed no completion");

  return onComplete;
}

describe("runAudioPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The Race Engineer is off, so Voice is muted unless a bypass holds it.
    mocks.setGlobalSettings({ raceEngineerVolume: 80, backgroundVolume: 40 });
    mocks.playRaceEngineerVoiceTest.mockReturnValue("playing");
    setRaceEngineerTestInFlight(false);
  });

  it("radar: plays the radar test", () => {
    runAudioPreview("radar", logger);

    expect(mocks.playRadarTest).toHaveBeenCalledTimes(1);
  });

  it("voice: forces the Voice bus to the slider value, holds the bypass, and restores on completion", () => {
    const onComplete = startVoiceTest();

    expect(voiceWrites()).toEqual([0.8]);
    expect(testBypassRaised()).toBe(true);

    mocks.setBusVolume.mockClear();
    onComplete();

    // The completion lowered the bypass and re-applied the gate: Race Engineer
    // off, so Voice mutes.
    expect(voiceWrites()).toEqual([0]);
    expect(testBypassRaised()).toBe(false);
  });

  it("voice: when no voice is available, lowers the bypass and warns", () => {
    mocks.playRaceEngineerVoiceTest.mockReturnValue("no-voice");

    runAudioPreview("voice", logger);

    expect(voiceWrites().at(-1)).toBe(0);
    expect(testBypassRaised()).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith("Race engineer voice test skipped — no voice available");
  });

  it("voice: when a heavier call holds the radio, lowers the bypass and says so at debug (#1698)", () => {
    // `"bus-busy"`: nothing started, so the completion never runs — the
    // runner lowers the bypass itself.
    mocks.playRaceEngineerVoiceTest.mockReturnValue("bus-busy");

    runAudioPreview("voice", logger);

    expect(voiceWrites().at(-1)).toBe(0);
    expect(testBypassRaised()).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(
      "Race engineer voice test skipped — the engineer holds the radio for a heavier call",
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("voice: an earlier Test's completion, arriving after a second press, leaves the newer Test's bypass alone (#1698)", () => {
    // Test pressed twice: the second cuts the first through the scheduler, and
    // the first's completion runs after the second has raised the bypass.
    const first = startVoiceTest();
    const second = startVoiceTest();

    mocks.setBusVolume.mockClear();
    first();

    expect(voiceWrites()).toEqual([]);
    expect(testBypassRaised()).toBe(true);

    second();

    expect(testBypassRaised()).toBe(false);
  });

  it("voice: a completion that runs twice re-applies the gate once", () => {
    const onComplete = startVoiceTest();

    onComplete();
    mocks.setBusVolume.mockClear();
    onComplete();

    expect(voiceWrites()).toEqual([]);
  });
  it("background: forces the Background bus to the slider value and restores on completion", () => {
    runAudioPreview("background", logger);

    expect(mocks.setBusVolume).toHaveBeenCalledWith("background", 0.4);
    expect(mocks.playBackgroundTest).toHaveBeenCalledWith(expect.any(Function), { beeps: true, ambience: true });
  });

  it("background: hands the preview the frame switches as they stand at the press (issue #1064)", () => {
    mocks.readFrameOptions.mockReturnValueOnce({ beeps: false, ambience: true });
    runAudioPreview("background", logger);
    expect(mocks.playBackgroundTest).toHaveBeenLastCalledWith(expect.any(Function), { beeps: false, ambience: true });

    mocks.readFrameOptions.mockReturnValueOnce({ beeps: false, ambience: false });
    runAudioPreview("background", logger);
    expect(mocks.playBackgroundTest).toHaveBeenLastCalledWith(expect.any(Function), { beeps: false, ambience: false });
  });

  it("background: says at debug when the built-in frame stood in for the voice's (issue #1124)", () => {
    mocks.playBackgroundTest.mockReturnValueOnce("voice-frame");
    runAudioPreview("background", logger);
    expect(logger.debug).not.toHaveBeenCalled();

    mocks.playBackgroundTest.mockReturnValueOnce("built-in");
    runAudioPreview("background", logger);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("built-in radio frame"));

    mocks.playBackgroundTest.mockReturnValueOnce("busy");
    runAudioPreview("background", logger);
    expect(logger.debug).toHaveBeenLastCalledWith(expect.stringContaining("on the radio"));
  });

  it.each([
    ["press-tap", "tap"],
    ["press-long", "long"],
  ] as const)("%s: plays the %s press sound through the player (#269)", (kind, sound) => {
    runAudioPreview(kind, logger);

    expect(mocks.playPressSound.mock.calls).toEqual([[sound]]);
    // No bus is forced and no other test sequence starts: the player plays on
    // the Feedback channel, which belongs to no bus.
    expect(mocks.setBusVolume).not.toHaveBeenCalled();
    expect(mocks.playRadarTest).not.toHaveBeenCalled();
    expect(mocks.playBackgroundTest).not.toHaveBeenCalled();
    expect(mocks.playRaceEngineerVoiceTest).not.toHaveBeenCalled();
  });

  it("exposes the kinds and a type guard so a page-supplied string can be validated", () => {
    expect(AUDIO_PREVIEW_KINDS).toEqual(["radar", "voice", "background", "press-tap", "press-long"]);

    for (const kind of AUDIO_PREVIEW_KINDS) expect(isAudioPreviewKind(kind)).toBe(true);

    for (const value of [
      "nope",
      "press",
      "tap",
      "long",
      "press-",
      "Press-Tap",
      " press-tap",
      "",
      42,
      null,
      undefined,
    ]) {
      expect(isAudioPreviewKind(value)).toBe(false);
    }
  });
});
