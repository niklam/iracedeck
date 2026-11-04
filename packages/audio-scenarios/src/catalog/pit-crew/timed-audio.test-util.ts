import type { AudioChannel } from "@iracedeck/audio-service";
import { createFakeAudio, type FakeAudio } from "@iracedeck/audio-service/testing";

/**
 * The shared fake audio service, with clips that end on the (fake) clock after
 * their length (#1504). `clipMs` is asked when each clip starts, so a test may
 * change a length between clips. A clip restarted or stopped on its channel
 * before it ends never completes.
 */
export function createTimedAudio(clipMs: (channel: AudioChannel) => number): FakeAudio {
  const audio = createFakeAudio();
  const timers = new Map<AudioChannel, ReturnType<typeof setTimeout>>();
  const play = audio.playOnChannel.getMockImplementation();
  const stop = audio.stopChannel.getMockImplementation();

  audio.playOnChannel.mockImplementation((channel, path, loop) => {
    clearTimeout(timers.get(channel));
    timers.set(
      channel,
      setTimeout(() => {
        timers.delete(channel);
        audio._triggerChannelEnd(channel);
      }, clipMs(channel)),
    );

    return play?.(channel, path, loop) ?? true;
  });
  audio.stopChannel.mockImplementation((channel) => {
    clearTimeout(timers.get(channel));
    timers.delete(channel);
    stop?.(channel);
  });

  return audio;
}
