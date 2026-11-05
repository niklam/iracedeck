import { describe, expect, it, vi } from "vitest";

import { AudioChannel, type IAudioService } from "./audio-service.js";
import { createFakeAudio } from "./testing.js";

/*
 * The fake's own behaviour. That no production source imports
 * `@iracedeck/audio-service/testing` is the root guard's,
 * `scripts/testing-entries-test-only.test.mjs`, which holds every package's
 * `./testing` entry to it (#1375).
 */
describe("createFakeAudio (#1504)", () => {
  it("is an IAudioService with every member a mock", () => {
    const audio = createFakeAudio();
    const service: IAudioService = audio;

    expect(service.init()).toBe(true);
    expect(audio.init).toHaveBeenCalledTimes(1);
    expect(vi.isMockFunction(audio.setPlaybackObserver)).toBe(true);
  });

  it("records plays with loop defaulting to false, and stops", () => {
    const audio = createFakeAudio();

    expect(audio.playOnChannel(AudioChannel.Voice, "voice/a.mp3")).toBe(true);
    audio.playOnChannel(AudioChannel.Ambient, "ambient.mp3", true);
    audio.stopChannel(AudioChannel.Ambient);

    expect(audio._played).toEqual([
      { channel: AudioChannel.Voice, path: "voice/a.mp3", loop: false },
      { channel: AudioChannel.Ambient, path: "ambient.mp3", loop: true },
    ]);
    expect(audio._stopped).toEqual([AudioChannel.Ambient]);
  });

  it("fires a channel's completion once, and never after the channel was stopped", () => {
    const audio = createFakeAudio();
    const voiceDone = vi.fn();
    const sfxDone = vi.fn();

    audio.onChannelComplete(AudioChannel.Voice, voiceDone);
    audio.onChannelComplete(AudioChannel.SFX, sfxDone);
    audio.stopChannel(AudioChannel.SFX);
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);

    expect(voiceDone).toHaveBeenCalledTimes(1);
    expect(sfxDone).not.toHaveBeenCalled();
  });

  it("_reset empties the recorders and forgets completions but keeps call history", () => {
    const audio = createFakeAudio();
    const done = vi.fn();

    audio.playOnChannel(AudioChannel.Voice, "voice/a.mp3");
    audio.stopChannel(AudioChannel.SFX);
    audio.onChannelComplete(AudioChannel.Feedback, done);
    audio._reset();
    audio._triggerChannelEnd(AudioChannel.Feedback);

    expect(audio._played).toEqual([]);
    expect(audio._stopped).toEqual([]);
    expect(done).not.toHaveBeenCalled();
    expect(audio.playOnChannel).toHaveBeenCalledTimes(1);
  });

  it("takes a per-test override through the member's mock", () => {
    const audio = createFakeAudio();

    audio.isChannelPlaying.mockReturnValue(true);

    expect(audio.isChannelPlaying(AudioChannel.Voice)).toBe(true);
    expect(createFakeAudio().isChannelPlaying(AudioChannel.Voice)).toBe(false);
  });
});
