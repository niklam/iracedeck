import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetBackgroundTest, isBackgroundTestInFlight, playBackgroundTest } from "./background-test.js";

const hoisted = vi.hoisted(() => {
  const playOnChannel = vi.fn<(...args: unknown[]) => boolean>().mockReturnValue(true);
  const stopChannel = vi.fn();
  const audio = { playOnChannel, stopChannel };
  const getAudio = vi.fn(() => audio);

  return { playOnChannel, stopChannel, getAudio };
});

vi.mock("@iracedeck/audio-service", () => ({
  AudioChannel: { Ambient: 0, SFX: 1, Voice: 2, Radar: 3 },
  getAudio: hoisted.getAudio,
}));

const AMBIENT = 0;
const SFX = 1;
const TICK_OPEN = "sfx/IRD-tick-open.mp3";
const TICK_CLOSE = "sfx/IRD-tick-close.mp3";
const AMBIENT_LOOP = "sfx/IRD-ambient-pit.mp3";
const TEST_DURATION_MS = 2500;

beforeEach(() => {
  vi.useFakeTimers();
  hoisted.playOnChannel.mockClear();
  hoisted.stopChannel.mockClear();
});

afterEach(() => {
  _resetBackgroundTest();
  vi.useRealTimers();
});

describe("playBackgroundTest", () => {
  it("plays tick-open + ambient loop immediately, then stops ambient + plays tick-close after the test window", () => {
    playBackgroundTest();

    expect(hoisted.playOnChannel).toHaveBeenCalledWith(SFX, TICK_OPEN);
    expect(hoisted.playOnChannel).toHaveBeenCalledWith(AMBIENT, AMBIENT_LOOP, true);
    expect(hoisted.stopChannel).not.toHaveBeenCalled();

    vi.advanceTimersByTime(TEST_DURATION_MS);

    expect(hoisted.stopChannel).toHaveBeenCalledWith(AMBIENT);
    expect(hoisted.playOnChannel).toHaveBeenCalledWith(SFX, TICK_CLOSE);
  });

  it("invokes onComplete after the close-tick fires (lets caller restore bus volumes)", () => {
    const onComplete = vi.fn();
    playBackgroundTest(onComplete);

    expect(onComplete).not.toHaveBeenCalled();

    vi.advanceTimersByTime(TEST_DURATION_MS);

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("is idempotent against double-press while a sequence is in flight", () => {
    playBackgroundTest();
    hoisted.playOnChannel.mockClear();

    playBackgroundTest();

    expect(hoisted.playOnChannel).not.toHaveBeenCalled();

    vi.advanceTimersByTime(TEST_DURATION_MS);
    hoisted.playOnChannel.mockClear();

    // After the in-flight test finishes, a fresh press starts a new sequence.
    playBackgroundTest();
    expect(hoisted.playOnChannel).toHaveBeenCalledWith(SFX, TICK_OPEN);
  });

  it("beeps off: plays the ambient loop alone and never a tick (issue #1064)", () => {
    const onComplete = vi.fn();
    playBackgroundTest(onComplete, { beeps: false, ambience: true });

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    expect(hoisted.playOnChannel).toHaveBeenCalledWith(AMBIENT, AMBIENT_LOOP, true);

    vi.advanceTimersByTime(TEST_DURATION_MS);

    expect(hoisted.stopChannel).toHaveBeenCalledWith(AMBIENT);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("ambience off: plays the two ticks and never touches the Ambient channel (issue #1064)", () => {
    const onComplete = vi.fn();
    playBackgroundTest(onComplete, { beeps: true, ambience: false });

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    expect(hoisted.playOnChannel).toHaveBeenCalledWith(SFX, TICK_OPEN);

    vi.advanceTimersByTime(TEST_DURATION_MS);

    expect(hoisted.stopChannel).not.toHaveBeenCalled();
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(2);
    expect(hoisted.playOnChannel).toHaveBeenLastCalledWith(SFX, TICK_CLOSE);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("both off: plays nothing, completes on the spot, and holds no in-flight flag (issue #1064)", () => {
    const onComplete = vi.fn();
    playBackgroundTest(onComplete, { beeps: false, ambience: false });

    expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(isBackgroundTestInFlight()).toBe(false);

    // Not idempotent-blocked either: a press with the switches back on plays.
    playBackgroundTest();
    expect(hoisted.playOnChannel).toHaveBeenCalledWith(SFX, TICK_OPEN);

    vi.advanceTimersByTime(TEST_DURATION_MS);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("clears the pending close-tick timer when reset (no post-reset side effects)", () => {
    const onComplete = vi.fn();
    playBackgroundTest(onComplete);
    hoisted.playOnChannel.mockClear();
    hoisted.stopChannel.mockClear();

    _resetBackgroundTest();
    vi.advanceTimersByTime(TEST_DURATION_MS * 2);

    // After reset, the queued close-tick / ambient stop / onComplete must NOT
    // fire — otherwise mocked audio calls leak across tests.
    expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    expect(hoisted.stopChannel).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();

    // The flag is also cleared so a fresh playBackgroundTest can start.
    playBackgroundTest();
    expect(hoisted.playOnChannel).toHaveBeenCalledWith(SFX, TICK_OPEN);
  });
});
