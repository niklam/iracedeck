import type { AudioNative } from "@iracedeck/audio-native";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetAudio,
  AudioChannel,
  getAudio,
  IDLE_STOP_DELAY_MS,
  initializeAudio,
  isAudioInitialized,
} from "./audio-service.js";

function createMockNative(): AudioNative {
  return {
    initAudioEngine: vi.fn(() => true),
    destroyAudioEngine: vi.fn(),
    playOnChannel: vi.fn(() => true),
    stopChannel: vi.fn(),
    setChannelVolume: vi.fn(),
    isChannelPlaying: vi.fn(() => false),
    setChannelEndCallback: vi.fn(),
    stopAllChannels: vi.fn(),
    seekChannelRandom: vi.fn(),
    getAudioDevices: vi.fn(() => [{ index: 0, name: "Default Device", id: "default-id", isDefault: true }]),
    setAudioDevice: vi.fn(() => true),
    setAudioDeviceById: vi.fn(() => true),
    startAudioEngine: vi.fn(() => true),
    stopAudioEngine: vi.fn(() => true),
  } as unknown as AudioNative;
}

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
};

describe("AudioService", () => {
  afterEach(() => {
    _resetAudio();
  });

  it("should not be initialized by default", () => {
    expect(isAudioInitialized()).toBe(false);
  });

  it("should throw when getting audio before initialization", () => {
    expect(() => getAudio()).toThrow("Audio service not initialized");
  });

  it("should initialize successfully", () => {
    initializeAudio(mockLogger as never, createMockNative());
    expect(isAudioInitialized()).toBe(true);
  });

  it("should throw on double initialization", () => {
    initializeAudio(mockLogger as never, createMockNative());
    expect(() => initializeAudio(mockLogger as never, createMockNative())).toThrow("already initialized");
  });

  it("should reset for test isolation", () => {
    initializeAudio(mockLogger as never, createMockNative());
    expect(isAudioInitialized()).toBe(true);
    _resetAudio();
    expect(isAudioInitialized()).toBe(false);
  });

  describe("engine lifecycle", () => {
    it("should init the native engine", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      const result = getAudio().init();
      expect(result).toBe(true);
      expect(native.initAudioEngine).toHaveBeenCalled();
    });

    it("should return false when native init fails", () => {
      const native = createMockNative();
      (native.initAudioEngine as ReturnType<typeof vi.fn>).mockReturnValue(false);
      initializeAudio(mockLogger as never, native);
      const result = getAudio().init();
      expect(result).toBe(false);
    });

    it("should skip double init", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      getAudio().init();
      expect(native.initAudioEngine).toHaveBeenCalledTimes(1);
    });

    it("should destroy the engine", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      getAudio().destroy();
      expect(native.destroyAudioEngine).toHaveBeenCalled();
    });
  });

  describe("channel operations", () => {
    it("should play on channel", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      const result = getAudio().playOnChannel(AudioChannel.Voice, "/path/to/sound.mp3");
      expect(result).toBe(true);
      expect(native.playOnChannel).toHaveBeenCalledWith(AudioChannel.Voice, "/path/to/sound.mp3", false, 1.0);
    });

    it("should play with loop", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      getAudio().playOnChannel(AudioChannel.Ambient, "/ambient.mp3", true);
      expect(native.playOnChannel).toHaveBeenCalledWith(AudioChannel.Ambient, "/ambient.mp3", true, 1.0);
    });

    it("should return false when engine not ready", () => {
      const native = createMockNative();
      (native.initAudioEngine as ReturnType<typeof vi.fn>).mockReturnValue(false);
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      const result = getAudio().playOnChannel(AudioChannel.Voice, "/path/to/sound.mp3");
      expect(result).toBe(false);
    });

    it("prepends basePath to relative paths", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, ["/plugin/assets/audio"]);
      getAudio().init();
      getAudio().playOnChannel(AudioChannel.Voice, "sfx/IRD-tick-open.mp3");
      expect(native.playOnChannel).toHaveBeenLastCalledWith(
        AudioChannel.Voice,
        expect.stringMatching(/[\\/]plugin[\\/]assets[\\/]audio[\\/]sfx[\\/]IRD-tick-open\.mp3$/),
        false,
        1.0,
      );
    });

    it("leaves absolute paths untouched when basePath is set", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, ["/plugin/assets/audio"]);
      getAudio().init();
      getAudio().playOnChannel(AudioChannel.Radar, "/abs/path/clip.mp3");
      expect(native.playOnChannel).toHaveBeenLastCalledWith(AudioChannel.Radar, "/abs/path/clip.mp3", false, 1.0);
    });

    it("leaves relative paths untouched when basePath is null", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      getAudio().playOnChannel(AudioChannel.Voice, "sfx/IRD-tick-open.mp3");
      expect(native.playOnChannel).toHaveBeenLastCalledWith(AudioChannel.Voice, "sfx/IRD-tick-open.mp3", false, 1.0);
    });

    it("throws when a relative path tries to escape every audio root via ..", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, ["/plugin/assets/audio"]);
      getAudio().init();
      expect(() => getAudio().playOnChannel(AudioChannel.Voice, "../../etc/passwd")).toThrow(
        /escapes every audio root/,
      );
    });

    it("should stop channel", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      getAudio().stopChannel(AudioChannel.SFX);
      expect(native.stopChannel).toHaveBeenCalledWith(AudioChannel.SFX);
    });

    it("should stop all channels", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      getAudio().stopAllChannels();
      expect(native.stopAllChannels).toHaveBeenCalled();
    });

    it("should set channel volume clamped to 0-1", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      getAudio().setChannelVolume(AudioChannel.Voice, 1.5);
      expect(native.setChannelVolume).toHaveBeenCalledWith(AudioChannel.Voice, 1);
      getAudio().setChannelVolume(AudioChannel.Voice, -0.5);
      expect(native.setChannelVolume).toHaveBeenCalledWith(AudioChannel.Voice, 0);
    });

    it("should use stored (perceptually curved) volume when playing on channel", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      getAudio().setChannelVolume(AudioChannel.Voice, 0.6);
      getAudio().playOnChannel(AudioChannel.Voice, "/sound.mp3");
      // Stored channel volume passes through the power-2.5 curve before
      // reaching miniaudio (#531): 0.6 → 0.6^2.5 ≈ 0.279.
      expect(native.playOnChannel).toHaveBeenCalledWith(
        AudioChannel.Voice,
        "/sound.mp3",
        false,
        expect.closeTo(0.279, 3),
      );
    });

    it("should check if channel is playing", () => {
      const native = createMockNative();
      (native.isChannelPlaying as ReturnType<typeof vi.fn>).mockReturnValue(true);
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      expect(getAudio().isChannelPlaying(AudioChannel.Radar)).toBe(true);
    });
  });

  describe("perceptual volume curve (#531)", () => {
    // miniaudio's `ma_sound_set_volume` is linear-amplitude; the audio
    // service applies a power-2.5 curve at the public setters so user
    // sliders feel proportional to perceived loudness instead of bunching
    // their audible range into the bottom 30% of travel.

    it("setChannelVolume curves the input before storing on the channel", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();

      getAudio().setChannelVolume(AudioChannel.Voice, 0.5);
      // 0.5^2.5 ≈ 0.17678. Without the curve this would be 0.5 (≈ −6 dB),
      // which is the linear-amplitude bug that motivated #531.
      expect(native.setChannelVolume).toHaveBeenCalledWith(AudioChannel.Voice, expect.closeTo(0.1768, 4));
    });

    it("setBusVolume curves the bus value but keeps mix ratio linear", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      vi.clearAllMocks();

      // Bus volume 0.5, SFX channel mix ratio 0.7. Curve is applied to the
      // bus value (0.5^2.5 ≈ 0.17678) and then multiplied by the mix ratio
      // → 0.17678 * 0.7 ≈ 0.1237.
      getAudio().setBusVolume(/* AudioBus.Background */ 1, 0.5);

      expect(native.setChannelVolume).toHaveBeenCalledWith(AudioChannel.SFX, expect.closeTo(0.1237, 4));
      // Ambient (mix ratio 0.8): 0.17678 * 0.8 ≈ 0.1414.
      expect(native.setChannelVolume).toHaveBeenCalledWith(AudioChannel.Ambient, expect.closeTo(0.1414, 4));
    });

    it("getBusVolume returns the user-facing linear value, not the curved amplitude", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();

      getAudio().setBusVolume(/* AudioBus.Voice */ 0, 0.5);

      // The slider value is what callers (PI rehydrate, Pit Crew step
      // handlers) want to read back — not the curved amplitude.
      expect(getAudio().getBusVolume(0)).toBe(0.5);
    });

    it("preserves slider = 100% as full amplitude (1^2.5 = 1, no regression at max)", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      vi.clearAllMocks();

      getAudio().setBusVolume(/* AudioBus.Voice */ 0, 1);

      expect(native.setChannelVolume).toHaveBeenCalledWith(AudioChannel.Voice, 1);
    });

    it("preserves slider = 0% as silent (0^2.5 = 0)", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      vi.clearAllMocks();

      getAudio().setBusVolume(/* AudioBus.Voice */ 0, 0);

      expect(native.setChannelVolume).toHaveBeenCalledWith(AudioChannel.Voice, 0);
    });

    it("clamps before curving so over-1 inputs resolve to 1.0, negatives and non-finite to 0", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      vi.clearAllMocks();

      // 1.5 clamped to 1.0, then curve(1.0) = 1.0. Without clamping first,
      // `Math.pow(-0.5, 2.5)` would return NaN and crash the native call.
      getAudio().setChannelVolume(AudioChannel.Voice, 1.5);
      expect(native.setChannelVolume).toHaveBeenLastCalledWith(AudioChannel.Voice, 1);

      getAudio().setChannelVolume(AudioChannel.Voice, -0.5);
      expect(native.setChannelVolume).toHaveBeenLastCalledWith(AudioChannel.Voice, 0);

      // Non-finite inputs (NaN, ±Infinity) are coerced to 0. `Math.max/min`
      // would otherwise propagate NaN straight through to the native layer.
      getAudio().setChannelVolume(AudioChannel.Voice, Number.NaN);
      expect(native.setChannelVolume).toHaveBeenLastCalledWith(AudioChannel.Voice, 0);

      getAudio().setChannelVolume(AudioChannel.Voice, Number.POSITIVE_INFINITY);
      expect(native.setChannelVolume).toHaveBeenLastCalledWith(AudioChannel.Voice, 0);
    });
  });

  describe("channel completion callbacks", () => {
    it("should fire one-shot callback on channel end", () => {
      const native = createMockNative();
      // Capture the end callbacks registered by the constructor
      const endCallbacks: Record<number, () => void> = {};
      (native.setChannelEndCallback as ReturnType<typeof vi.fn>).mockImplementation((ch: number, cb: () => void) => {
        endCallbacks[ch] = cb;
      });

      initializeAudio(mockLogger as never, native);
      getAudio().init();

      const onComplete = vi.fn();
      getAudio().onChannelComplete(AudioChannel.SFX, onComplete);

      // Simulate native end callback
      endCallbacks[AudioChannel.SFX]();
      expect(onComplete).toHaveBeenCalledTimes(1);

      // One-shot: second fire should not call again
      endCallbacks[AudioChannel.SFX]();
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe("playback observer", () => {
    it("fires onStart with the resolved path when a clip plays", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();

      const onStart = vi.fn();
      getAudio().setPlaybackObserver({ onStart });
      getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");

      expect(onStart).toHaveBeenCalledWith(AudioChannel.Voice, "/msg.mp3");
    });

    it("does not fire onStart when the native engine rejects the play", () => {
      const native = createMockNative();
      (native.playOnChannel as ReturnType<typeof vi.fn>).mockReturnValue(false);
      initializeAudio(mockLogger as never, native);
      getAudio().init();

      const onStart = vi.fn();
      getAudio().setPlaybackObserver({ onStart });
      getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");

      expect(onStart).not.toHaveBeenCalled();
    });

    it("fires onComplete when the native end callback fires", () => {
      const native = createMockNative();
      const endCallbacks: Record<number, () => void> = {};
      (native.setChannelEndCallback as ReturnType<typeof vi.fn>).mockImplementation((ch: number, cb: () => void) => {
        endCallbacks[ch] = cb;
      });

      initializeAudio(mockLogger as never, native);
      getAudio().init();

      const onComplete = vi.fn();
      getAudio().setPlaybackObserver({ onComplete });
      // Mark the channel active first — onComplete is gated on the
      // start/end pairing now, so an unsolicited native end on an idle
      // channel is intentionally a no-op.
      getAudio().playOnChannel(AudioChannel.Radar, "/tick.mp3");

      endCallbacks[AudioChannel.Radar]();
      expect(onComplete).toHaveBeenCalledWith(AudioChannel.Radar);
    });

    it("clears the observer when set to null", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();

      const onStart = vi.fn();
      getAudio().setPlaybackObserver({ onStart });
      getAudio().setPlaybackObserver(null);
      getAudio().playOnChannel(AudioChannel.SFX, "/tick.mp3");

      expect(onStart).not.toHaveBeenCalled();
    });

    it("isolates observer errors from the caller", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();

      getAudio().setPlaybackObserver({
        onStart: () => {
          throw new Error("observer boom");
        },
      });

      expect(() => getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3")).not.toThrow();
    });

    it("fires onComplete before the voice-sequence engine schedules the next clip", () => {
      const native = createMockNative();
      const endCallbacks: Record<number, () => void> = {};
      (native.setChannelEndCallback as ReturnType<typeof vi.fn>).mockImplementation((ch: number, cb: () => void) => {
        endCallbacks[ch] = cb;
      });

      initializeAudio(mockLogger as never, native);
      getAudio().init();

      const events: string[] = [];
      getAudio().setPlaybackObserver({
        onStart: (ch, path) => events.push(`start:${ch}:${path}`),
        onComplete: (ch) => events.push(`complete:${ch}`),
      });

      getAudio().playVoiceSequence(["/msg1.mp3", "/msg2.mp3"]);
      // First message fires start
      expect(events).toEqual([`start:${AudioChannel.Voice}:/msg1.mp3`]);

      // Native end fires for msg1 → observer must see complete BEFORE next start
      events.length = 0;
      endCallbacks[AudioChannel.Voice]();

      expect(events[0]).toBe(`complete:${AudioChannel.Voice}`);
      expect(events[1]).toBe(`start:${AudioChannel.Voice}:/msg2.mp3`);
    });

    it("fires onComplete from stopChannel so looping channels go idle in monitors", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();

      const onComplete = vi.fn();
      getAudio().setPlaybackObserver({ onComplete });
      getAudio().playOnChannel(AudioChannel.Ambient, "/loop.mp3", true);
      getAudio().stopChannel(AudioChannel.Ambient);

      expect(onComplete).toHaveBeenCalledWith(AudioChannel.Ambient);
    });

    it("fires onComplete for every active channel from stopAllChannels", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();

      const onComplete = vi.fn();
      getAudio().setPlaybackObserver({ onComplete });

      // Bring every channel to the active state first — idle channels
      // intentionally don't fire onComplete on stop now.
      for (const ch of [AudioChannel.Ambient, AudioChannel.SFX, AudioChannel.Voice, AudioChannel.Radar]) {
        getAudio().playOnChannel(ch, `/clip-${ch}.mp3`);
      }

      getAudio().stopAllChannels();

      expect(onComplete).toHaveBeenCalledTimes(4);

      for (const ch of [AudioChannel.Ambient, AudioChannel.SFX, AudioChannel.Voice, AudioChannel.Radar]) {
        expect(onComplete).toHaveBeenCalledWith(ch);
      }
    });

    it("fires onComplete for every active channel when switching audio device by index", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();

      const onComplete = vi.fn();
      getAudio().setPlaybackObserver({ onComplete });

      for (const ch of [AudioChannel.Ambient, AudioChannel.SFX, AudioChannel.Voice, AudioChannel.Radar]) {
        getAudio().playOnChannel(ch, `/clip-${ch}.mp3`);
      }

      getAudio().setAudioDevice(2);

      expect(onComplete).toHaveBeenCalledTimes(4);
    });

    it("fires onComplete for every active channel when switching audio device by id", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();

      const onComplete = vi.fn();
      getAudio().setPlaybackObserver({ onComplete });

      for (const ch of [AudioChannel.Ambient, AudioChannel.SFX, AudioChannel.Voice, AudioChannel.Radar]) {
        getAudio().playOnChannel(ch, `/clip-${ch}.mp3`);
      }

      getAudio().setAudioDeviceById("default-id");

      expect(onComplete).toHaveBeenCalledTimes(4);
    });

    it("does not fire onComplete for stopChannel on an already-idle channel", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();

      const onComplete = vi.fn();
      getAudio().setPlaybackObserver({ onComplete });
      getAudio().stopChannel(AudioChannel.SFX);

      expect(onComplete).not.toHaveBeenCalled();
    });

    it("does not fire onComplete on stopAllChannels when nothing is playing", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();

      const onComplete = vi.fn();
      getAudio().setPlaybackObserver({ onComplete });
      getAudio().stopAllChannels();

      expect(onComplete).not.toHaveBeenCalled();
    });

    it("stopChannel(Voice) cancels the active voice sequence so a deferred native end can't resume it", () => {
      const native = createMockNative();
      const endCallbacks: Record<number, () => void> = {};
      (native.setChannelEndCallback as ReturnType<typeof vi.fn>).mockImplementation((ch: number, cb: () => void) => {
        endCallbacks[ch] = cb;
      });

      initializeAudio(mockLogger as never, native);
      getAudio().init();

      // Start a 3-clip sequence so the voice-sequence state machine has
      // pending messages. Pre-fix: stopChannel(Voice) cleared the
      // observer state but left voiceSeqState armed; a deferred native
      // end echo would then schedule msg2 via handleVoiceEnd and the
      // mock native.playOnChannel would be called for "/msg2.mp3".
      getAudio().playVoiceSequence(["/msg1.mp3", "/msg2.mp3", "/msg3.mp3"]);
      const playsBeforeStop = (native.playOnChannel as ReturnType<typeof vi.fn>).mock.calls.length;

      getAudio().stopChannel(AudioChannel.Voice);

      // Native engine echoes its end callback after the manual stop.
      endCallbacks[AudioChannel.Voice]();

      // No additional play was scheduled — the sequence was cancelled.
      const playsAfterStop = (native.playOnChannel as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(playsAfterStop).toBe(playsBeforeStop);
    });

    it("destroy() drains active channels and resets channelActive so a re-init starts clean", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();

      const onComplete = vi.fn();
      getAudio().setPlaybackObserver({ onComplete });
      getAudio().playOnChannel(AudioChannel.Ambient, "/loop.mp3", true);
      getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");
      getAudio().destroy();

      // Both active channels notified on teardown.
      expect(onComplete).toHaveBeenCalledWith(AudioChannel.Ambient);
      expect(onComplete).toHaveBeenCalledWith(AudioChannel.Voice);

      // After destroy + observer detached, a stale native end echo for any
      // channel must not fire a synthetic onComplete (channelActive cleared).
      onComplete.mockClear();
      getAudio().stopChannel(AudioChannel.Ambient);
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("does not double-fire onComplete when native end callback follows manual stop", () => {
      const native = createMockNative();
      const endCallbacks: Record<number, () => void> = {};
      (native.setChannelEndCallback as ReturnType<typeof vi.fn>).mockImplementation((ch: number, cb: () => void) => {
        endCallbacks[ch] = cb;
      });

      initializeAudio(mockLogger as never, native);
      getAudio().init();

      const onComplete = vi.fn();
      getAudio().setPlaybackObserver({ onComplete });
      getAudio().playOnChannel(AudioChannel.Ambient, "/loop.mp3", true);
      getAudio().stopChannel(AudioChannel.Ambient);
      // Native engine echoes its end callback after the manual stop.
      endCallbacks[AudioChannel.Ambient]();

      expect(onComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe("voice sequence", () => {
    it("should play single file without connectors", () => {
      const native = createMockNative();
      const endCallbacks: Record<number, () => void> = {};
      (native.setChannelEndCallback as ReturnType<typeof vi.fn>).mockImplementation((ch: number, cb: () => void) => {
        endCallbacks[ch] = cb;
      });

      initializeAudio(mockLogger as never, native);
      getAudio().init();

      const onSeqComplete = vi.fn();
      getAudio().onVoiceSequenceComplete(onSeqComplete);
      getAudio().playVoiceSequence(["/msg1.mp3"]);

      // First message plays
      expect(native.playOnChannel).toHaveBeenCalledWith(AudioChannel.Voice, "/msg1.mp3", false, 1.0);

      // Simulate message end
      endCallbacks[AudioChannel.Voice]();
      expect(onSeqComplete).toHaveBeenCalledTimes(1);
    });

    it("should insert connectors between messages", () => {
      const native = createMockNative();
      const endCallbacks: Record<number, () => void> = {};
      (native.setChannelEndCallback as ReturnType<typeof vi.fn>).mockImplementation((ch: number, cb: () => void) => {
        endCallbacks[ch] = cb;
      });

      initializeAudio(mockLogger as never, native);
      getAudio().init();

      const onSeqComplete = vi.fn();
      getAudio().onVoiceSequenceComplete(onSeqComplete);
      getAudio().playVoiceSequence(["/msg1.mp3", "/msg2.mp3"], ["/and.mp3"]);

      // First message plays
      expect(native.playOnChannel).toHaveBeenCalledWith(AudioChannel.Voice, "/msg1.mp3", false, 1.0);

      // Message 1 ends → connector plays
      endCallbacks[AudioChannel.Voice]();
      expect(native.playOnChannel).toHaveBeenCalledWith(AudioChannel.Voice, "/and.mp3", false, 1.0);

      // Connector ends → message 2 plays
      endCallbacks[AudioChannel.Voice]();
      expect(native.playOnChannel).toHaveBeenCalledWith(AudioChannel.Voice, "/msg2.mp3", false, 1.0);

      // Message 2 ends → sequence complete
      endCallbacks[AudioChannel.Voice]();
      expect(onSeqComplete).toHaveBeenCalledTimes(1);
    });

    it("should cancel voice sequence", () => {
      const native = createMockNative();
      const endCallbacks: Record<number, () => void> = {};
      (native.setChannelEndCallback as ReturnType<typeof vi.fn>).mockImplementation((ch: number, cb: () => void) => {
        endCallbacks[ch] = cb;
      });

      initializeAudio(mockLogger as never, native);
      getAudio().init();

      const onSeqComplete = vi.fn();
      getAudio().onVoiceSequenceComplete(onSeqComplete);
      getAudio().playVoiceSequence(["/msg1.mp3", "/msg2.mp3"]);
      getAudio().cancelVoiceSequence();

      // Simulate end callback after cancel — should not fire sequence complete
      endCallbacks[AudioChannel.Voice]();
      expect(onSeqComplete).not.toHaveBeenCalled();
    });

    it("resolves sequence clips + connectors against basePath", () => {
      const native = createMockNative();
      const endCallbacks: Record<number, () => void> = {};
      (native.setChannelEndCallback as ReturnType<typeof vi.fn>).mockImplementation((ch: number, cb: () => void) => {
        endCallbacks[ch] = cb;
      });

      initializeAudio(mockLogger as never, native, ["/plugin/assets/audio"]);
      getAudio().init();
      getAudio().playVoiceSequence(["sfx/one.mp3", "sfx/two.mp3"], ["sfx/and.mp3"]);

      const msgPattern = /[\\/]plugin[\\/]assets[\\/]audio[\\/]sfx[\\/]one\.mp3$/;
      expect(native.playOnChannel).toHaveBeenCalledWith(
        AudioChannel.Voice,
        expect.stringMatching(msgPattern),
        false,
        1.0,
      );

      endCallbacks[AudioChannel.Voice]();
      const connectorPattern = /[\\/]plugin[\\/]assets[\\/]audio[\\/]sfx[\\/]and\.mp3$/;
      expect(native.playOnChannel).toHaveBeenCalledWith(
        AudioChannel.Voice,
        expect.stringMatching(connectorPattern),
        false,
        1.0,
      );

      endCallbacks[AudioChannel.Voice]();
      const msg2Pattern = /[\\/]plugin[\\/]assets[\\/]audio[\\/]sfx[\\/]two\.mp3$/;
      expect(native.playOnChannel).toHaveBeenCalledWith(
        AudioChannel.Voice,
        expect.stringMatching(msg2Pattern),
        false,
        1.0,
      );
    });

    it("should skip empty file array", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      getAudio().playVoiceSequence([]);
      // playOnChannel should only have been called by init setup, not for empty sequence
      expect(native.playOnChannel).not.toHaveBeenCalled();
    });
  });

  describe("device selection", () => {
    it("getAudioDevices forwards the native enumeration with stable id", () => {
      const native = createMockNative();
      (native.getAudioDevices as ReturnType<typeof vi.fn>).mockReturnValue([
        { index: 0, name: "Speakers", id: "AAAA", isDefault: true },
        { index: 1, name: "Headset", id: "BBBB", isDefault: false },
      ]);
      initializeAudio(mockLogger as never, native);

      expect(getAudio().getAudioDevices()).toEqual([
        { index: 0, name: "Speakers", id: "AAAA", isDefault: true },
        { index: 1, name: "Headset", id: "BBBB", isDefault: false },
      ]);
    });

    it("setAudioDevice stops all channels and forwards the index", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      vi.clearAllMocks();

      const ok = getAudio().setAudioDevice(-1);

      expect(ok).toBe(true);
      expect(native.stopAllChannels).toHaveBeenCalledTimes(1);
      expect(native.setAudioDevice).toHaveBeenCalledWith(-1);
    });

    it("setAudioDeviceById stops all channels and forwards the id", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      vi.clearAllMocks();

      const ok = getAudio().setAudioDeviceById("DEADBEEF");

      expect(ok).toBe(true);
      expect(native.stopAllChannels).toHaveBeenCalledTimes(1);
      expect(native.setAudioDeviceById).toHaveBeenCalledWith("DEADBEEF");
    });

    it("setAudioDeviceById returns false (and does not throw) when the native layer rejects the id", () => {
      const native = createMockNative();
      (native.setAudioDeviceById as ReturnType<typeof vi.fn>).mockReturnValue(false);
      initializeAudio(mockLogger as never, native);
      getAudio().init();

      const ok = getAudio().setAudioDeviceById("STALE-ID");

      expect(ok).toBe(false);
    });
  });

  describe("engine device start/stop (#849 — idle stream blocks PC sleep)", () => {
    function createServiceWithEndCallbacks() {
      const native = createMockNative();
      const endCallbacks: Record<number, () => void> = {};
      (native.setChannelEndCallback as ReturnType<typeof vi.fn>).mockImplementation((ch: number, cb: () => void) => {
        endCallbacks[ch] = cb;
      });
      initializeAudio(mockLogger as never, native);
      getAudio().init();

      return { native, endCallbacks };
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("init() does not start the playback device", () => {
      const { native } = createServiceWithEndCallbacks();
      expect(native.startAudioEngine).not.toHaveBeenCalled();
    });

    it("starts the device on the first play", () => {
      const { native } = createServiceWithEndCallbacks();
      const ok = getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");
      expect(ok).toBe(true);
      expect(native.startAudioEngine).toHaveBeenCalledTimes(1);
    });

    it("does not re-start the device while it is already running", () => {
      const { native } = createServiceWithEndCallbacks();
      getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");
      getAudio().playOnChannel(AudioChannel.SFX, "/tick.mp3");
      expect(native.startAudioEngine).toHaveBeenCalledTimes(1);
    });

    it("stops the device after all channels have been idle for the idle window", () => {
      const { native, endCallbacks } = createServiceWithEndCallbacks();
      getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");
      endCallbacks[AudioChannel.Voice]();

      vi.advanceTimersByTime(IDLE_STOP_DELAY_MS);

      expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);
    });

    it("does not stop the device before the idle window elapses", () => {
      const { native, endCallbacks } = createServiceWithEndCallbacks();
      getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");
      endCallbacks[AudioChannel.Voice]();

      vi.advanceTimersByTime(IDLE_STOP_DELAY_MS - 1);

      expect(native.stopAudioEngine).not.toHaveBeenCalled();
    });

    it("a new play within the idle window cancels the pending stop", () => {
      const { native, endCallbacks } = createServiceWithEndCallbacks();
      getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");
      endCallbacks[AudioChannel.Voice]();

      vi.advanceTimersByTime(IDLE_STOP_DELAY_MS / 2);
      getAudio().playOnChannel(AudioChannel.Voice, "/next.mp3");
      vi.advanceTimersByTime(IDLE_STOP_DELAY_MS);

      expect(native.stopAudioEngine).not.toHaveBeenCalled();
      // Device never stopped, so no second start either.
      expect(native.startAudioEngine).toHaveBeenCalledTimes(1);
    });

    it("restarts the device on the next play after an idle stop", () => {
      const { native, endCallbacks } = createServiceWithEndCallbacks();
      getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");
      endCallbacks[AudioChannel.Voice]();
      vi.advanceTimersByTime(IDLE_STOP_DELAY_MS);
      expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);

      getAudio().playOnChannel(AudioChannel.Voice, "/later.mp3");

      expect(native.startAudioEngine).toHaveBeenCalledTimes(2);
    });

    it("does not stop the device while another channel is still active", () => {
      const { native, endCallbacks } = createServiceWithEndCallbacks();
      getAudio().playOnChannel(AudioChannel.Ambient, "/ambient.mp3", true);
      getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");
      endCallbacks[AudioChannel.Voice]();

      vi.advanceTimersByTime(IDLE_STOP_DELAY_MS * 2);

      expect(native.stopAudioEngine).not.toHaveBeenCalled();
    });

    it("manual stopAllChannels also arms the idle stop", () => {
      const { native } = createServiceWithEndCallbacks();
      getAudio().playOnChannel(AudioChannel.Ambient, "/ambient.mp3", true);

      getAudio().stopAllChannels();
      vi.advanceTimersByTime(IDLE_STOP_DELAY_MS);

      expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);
    });

    it("manual stopChannel of the last active channel arms the idle stop", () => {
      const { native } = createServiceWithEndCallbacks();
      getAudio().playOnChannel(AudioChannel.Radar, "/tick.mp3");

      getAudio().stopChannel(AudioChannel.Radar);
      vi.advanceTimersByTime(IDLE_STOP_DELAY_MS);

      expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);
    });

    it("a device switch leaves the device stopped until the next play", () => {
      const { native } = createServiceWithEndCallbacks();
      getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");

      getAudio().setAudioDevice(1);

      expect(native.stopAudioEngine).toHaveBeenCalled();

      getAudio().playOnChannel(AudioChannel.Voice, "/after-switch.mp3");
      expect(native.startAudioEngine).toHaveBeenCalledTimes(2);
    });

    it("a device switch by id leaves the device stopped until the next play", () => {
      const { native } = createServiceWithEndCallbacks();
      getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");

      getAudio().setAudioDeviceById("BBBB");

      expect(native.stopAudioEngine).toHaveBeenCalled();

      getAudio().playOnChannel(AudioChannel.Voice, "/after-switch.mp3");
      expect(native.startAudioEngine).toHaveBeenCalledTimes(2);
    });

    it("retries the device start on the next play when starting fails", () => {
      const { native } = createServiceWithEndCallbacks();
      (native.startAudioEngine as ReturnType<typeof vi.fn>).mockReturnValue(false);

      getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");
      getAudio().playOnChannel(AudioChannel.Voice, "/msg2.mp3");

      expect(native.startAudioEngine).toHaveBeenCalledTimes(2);
    });

    it("aborts the play when the device fails to start: returns false, no onStart, unloads the queued sound", () => {
      const { native } = createServiceWithEndCallbacks();
      (native.startAudioEngine as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const onStart = vi.fn();
      getAudio().setPlaybackObserver({ onStart });

      const ok = getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");

      expect(ok).toBe(false);
      expect(onStart).not.toHaveBeenCalled();
      // The queued sound must be unloaded — otherwise it would blast out
      // whenever a LATER play manages to start the device.
      expect(native.stopChannel).toHaveBeenCalledWith(AudioChannel.Voice);
    });

    it("retries a failed idle teardown instead of marking the device stopped", () => {
      const { native, endCallbacks } = createServiceWithEndCallbacks();
      (native.stopAudioEngine as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

      getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");
      endCallbacks[AudioChannel.Voice]();

      vi.advanceTimersByTime(IDLE_STOP_DELAY_MS);
      expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);

      // First attempt failed — the device must still count as running and
      // the release must be retried after another idle window.
      vi.advanceTimersByTime(IDLE_STOP_DELAY_MS);
      expect(native.stopAudioEngine).toHaveBeenCalledTimes(2);

      // Second attempt succeeded — the next play restarts the device.
      getAudio().playOnChannel(AudioChannel.Voice, "/again.mp3");
      expect(native.startAudioEngine).toHaveBeenCalledTimes(2);
    });

    it("destroy cancels a pending idle stop", () => {
      const { native, endCallbacks } = createServiceWithEndCallbacks();
      getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");
      endCallbacks[AudioChannel.Voice]();

      getAudio().destroy();
      (native.stopAudioEngine as ReturnType<typeof vi.fn>).mockClear();
      vi.advanceTimersByTime(IDLE_STOP_DELAY_MS * 2);

      expect(native.stopAudioEngine).not.toHaveBeenCalled();
    });
  });
});

describe("audio root resolution (issue #1034)", () => {
  const PLUGIN = path.resolve("/plugin/assets/audio");
  const PACK = path.resolve("/packs/luca");

  beforeEach(() => {
    _resetAudio();
  });

  /** Normalise to POSIX separators so assertions read the same on any platform. */
  function posix(value: string): string {
    return value.split(path.sep).join("/");
  }

  function playedPath(native: AudioNative): string {
    const calls = (native.playOnChannel as unknown as { mock: { calls: unknown[][] } }).mock.calls;

    return posix(String(calls[0][1]));
  }

  it("resolves against the first root that has the file", () => {
    const native = createMockNative();
    initializeAudio(mockLogger as never, native, [PLUGIN, PACK]);
    getAudio().init();
    getAudio().setFileProbe((candidate) => candidate.startsWith(PACK));

    getAudio().playOnChannel(AudioChannel.Voice, "voice/luca/a.mp3");

    expect(playedPath(native)).toBe(posix(path.join(PACK, "voice/luca/a.mp3")));
  });

  it("prefers the plugin root when both roots have the file, so a pack cannot shadow a bundled clip", () => {
    const native = createMockNative();
    initializeAudio(mockLogger as never, native, [PLUGIN, PACK]);
    getAudio().init();
    getAudio().setFileProbe(() => true);

    getAudio().playOnChannel(AudioChannel.Voice, "voice/default/a.mp3");

    expect(playedPath(native)).toBe(posix(path.join(PLUGIN, "voice/default/a.mp3")));
  });

  it("falls back to the first root when no root has the file", () => {
    const native = createMockNative();
    initializeAudio(mockLogger as never, native, [PLUGIN, PACK]);
    getAudio().init();
    getAudio().setFileProbe(() => false);

    getAudio().playOnChannel(AudioChannel.Voice, "voice/ghost/a.mp3");

    expect(playedPath(native)).toBe(posix(path.join(PLUGIN, "voice/ghost/a.mp3")));
  });

  it("rejects a path escaping every root", () => {
    const native = createMockNative();
    initializeAudio(mockLogger as never, native, [PLUGIN]);
    getAudio().init();

    expect(() => getAudio().playOnChannel(AudioChannel.Voice, "../../etc/passwd")).toThrow("escapes");
  });

  it("passes absolute paths through unchanged", () => {
    const native = createMockNative();
    const absolute = path.resolve("/tmp/x.mp3");
    initializeAudio(mockLogger as never, native, [PLUGIN]);
    getAudio().init();

    getAudio().playOnChannel(AudioChannel.Voice, absolute);

    expect(playedPath(native)).toBe(posix(absolute));
  });

  it("resolves a newly installed pack after setRoots, with no restart", () => {
    const native = createMockNative();
    initializeAudio(mockLogger as never, native, [PLUGIN]);
    getAudio().init();
    getAudio().setFileProbe((candidate) => candidate.startsWith(PACK));

    getAudio().setRoots([PLUGIN, PACK]);
    getAudio().playOnChannel(AudioChannel.Voice, "voice/luca/a.mp3");

    expect(playedPath(native)).toBe(posix(path.join(PACK, "voice/luca/a.mp3")));
  });

  it("does not resolve at all when there are no roots", () => {
    const native = createMockNative();
    initializeAudio(mockLogger as never, native);
    getAudio().init();

    getAudio().playOnChannel(AudioChannel.Voice, "voice/luca/a.mp3");

    expect(playedPath(native)).toBe("voice/luca/a.mp3");
  });
});
