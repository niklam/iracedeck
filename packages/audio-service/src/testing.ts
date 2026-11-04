/**
 * Test helpers shared with other packages' tests (#1504); never imported by
 * production code. Reached as `@iracedeck/audio-service/testing`.
 *
 * It imports `vitest`, which is why a production source must not import it: it
 * would pull the test runner into the plugin bundle. `testing.test.ts` fails on
 * any production source in `packages/` that does.
 */
import { type Mock, vi } from "vitest";

import type { AudioChannel, IAudioService } from "./audio-service.js";

/** One `playOnChannel` call the fake recorded. */
export type PlayedClip = { channel: AudioChannel; path: string; loop: boolean };

/**
 * The fake audio service: every {@link IAudioService} member as a `vi.fn`, plus
 * the recorders and controls a test drives it with. The `_` names are the
 * fake's own, never service members.
 *
 * The member list is a mapped type over `IAudioService`, so a member added to
 * the service fails to compile here, once, until the fake implements it.
 */
export type FakeAudio = { [K in keyof IAudioService]: Mock<IAudioService[K]> } & {
  /** Every `playOnChannel` call, in order; `loop` is `false` when not passed. */
  _played: PlayedClip[];
  /** Every `stopChannel` call's channel, in order. */
  _stopped: AudioChannel[];
  /**
   * Finish the clip on `channel`: fires the completion callback registered
   * with `onChannelComplete`, once. A channel with none is a no-op, as is a
   * channel `stopChannel` stopped since the callback was registered.
   */
  _triggerChannelEnd: (channel: AudioChannel) => void;
  /** Empty both recorders and forget every pending completion; the mocks' call history is kept. */
  _reset: () => void;
};

/**
 * A fake audio service with no device: plays succeed and are recorded, a clip
 * never finishes on its own (a test ends it with `_triggerChannelEnd`), and no
 * channel reports itself playing.
 *
 * Behaviour a test needs beyond that goes on the one member, through the mock:
 * `audio.isChannelPlaying.mockReturnValue(true)`, or `mockImplementation` for a
 * member that must do more, such as a `stopChannel` that also fires the
 * channel's completion. An implementation replaced that way replaces the
 * recording too. To extend the default instead, keep it first and call it from
 * the override — `const stop = audio.stopChannel.getMockImplementation();`,
 * then `stop?.(channel)` inside — as the timed fakes do, whose clips end on the
 * fake clock (`crash-caution-sequence.test.ts`, the scenario harness's
 * `heard-rig.test-util.ts`).
 */
export function createFakeAudio(): FakeAudio {
  const completions = new Map<AudioChannel, () => void>();
  const played: PlayedClip[] = [];
  const stopped: AudioChannel[] = [];

  const fake: FakeAudio = {
    init: vi.fn(() => true),
    destroy: vi.fn(),
    hold: vi.fn(),
    release: vi.fn(),
    playOnChannel: vi.fn((channel: AudioChannel, filePath: string, loop?: boolean) => {
      played.push({ channel, path: filePath, loop: loop ?? false });

      return true;
    }),
    playOnChannelAtLevel: vi.fn(() => true),
    setRoots: vi.fn(),
    setFileProbe: vi.fn(),
    stopChannel: vi.fn((channel: AudioChannel) => {
      stopped.push(channel);
      completions.delete(channel);
    }),
    stopAllChannels: vi.fn(),
    setChannelVolume: vi.fn(),
    setBusVolume: vi.fn(),
    getBusVolume: vi.fn(() => 1.0),
    isChannelPlaying: vi.fn(() => false),
    onChannelComplete: vi.fn((channel: AudioChannel, callback: () => void) => {
      completions.set(channel, callback);
    }),
    playVoiceSequence: vi.fn(),
    cancelVoiceSequence: vi.fn(),
    onVoiceSequenceComplete: vi.fn(),
    seekChannelRandom: vi.fn(),
    getAudioDevices: vi.fn(() => []),
    setAudioDevice: vi.fn(() => true),
    setAudioDeviceById: vi.fn(() => true),
    setPlaybackObserver: vi.fn(),
    _played: played,
    _stopped: stopped,
    _triggerChannelEnd: (channel: AudioChannel) => {
      const callback = completions.get(channel);

      completions.delete(channel);
      callback?.();
    },
    _reset: () => {
      played.length = 0;
      stopped.length = 0;
      completions.clear();
    },
  };

  return fake;
}
