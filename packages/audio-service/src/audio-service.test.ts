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
    setSessionIdentity: vi.fn(() => true),
    setDeviceReroutedCallback: vi.fn<(callback: (() => void) | null) => void>(),
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

  describe("session identity (#1253 — the Volume Mixer names our session)", () => {
    const identity = { displayName: "iRaceDeck", iconPath: "C:/plugin/imgs/plugin/iracedeck.ico" };

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("hands the identity to the native layer before the engine is created or started", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, [], identity);
      getAudio().init();
      getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");

      expect(native.setSessionIdentity).toHaveBeenCalledTimes(1);
      expect(native.setSessionIdentity).toHaveBeenCalledWith("iRaceDeck", identity.iconPath);

      const identityOrder = vi.mocked(native.setSessionIdentity).mock.invocationCallOrder[0];
      expect(identityOrder).toBeLessThan(vi.mocked(native.initAudioEngine).mock.invocationCallOrder[0]);
      expect(identityOrder).toBeLessThan(vi.mocked(native.playOnChannel).mock.invocationCallOrder[0]);
      expect(identityOrder).toBeLessThan(vi.mocked(native.startAudioEngine).mock.invocationCallOrder[0]);
    });

    it("touches nothing native from the constructor — init() hands the identity over", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, [], identity);

      expect(native.setSessionIdentity).not.toHaveBeenCalled();

      getAudio().init();

      expect(native.setSessionIdentity).toHaveBeenCalledTimes(1);
    });

    it("hands it over once however often init() is called while the engine is ready", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, [], identity);
      getAudio().init();
      getAudio().init();

      expect(native.setSessionIdentity).toHaveBeenCalledTimes(1);
    });

    it("hands it over again on the init() after a destroy(), which clears it natively", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, [], identity);
      getAudio().init();
      getAudio().destroy();
      getAudio().init();

      expect(native.setSessionIdentity).toHaveBeenCalledTimes(2);
      const secondIdentity = vi.mocked(native.setSessionIdentity).mock.invocationCallOrder[1];
      expect(secondIdentity).toBeGreaterThan(vi.mocked(native.destroyAudioEngine).mock.invocationCallOrder[0]);
      expect(secondIdentity).toBeLessThan(vi.mocked(native.initAudioEngine).mock.invocationCallOrder[1]);
    });

    it("passes a display name without an icon through unchanged", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, [], { displayName: "iRaceDeck" });
      getAudio().init();

      expect(native.setSessionIdentity).toHaveBeenCalledWith("iRaceDeck", undefined);
    });

    it("passes nothing to the native layer when no identity is given", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, []);
      getAudio().init();
      getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");

      expect(native.setSessionIdentity).not.toHaveBeenCalled();
    });

    it("warns and carries on when the native layer refuses the identity", () => {
      const native = createMockNative();
      vi.mocked(native.setSessionIdentity).mockReturnValue(false);
      initializeAudio(mockLogger as never, native, [], identity);

      expect(getAudio().init()).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("session identity"));
    });
  });

  describe("device reroute log line (#1330)", () => {
    /** The callback the service last handed to the native layer. */
    function registeredRerouteCallback(native: AudioNative): () => void {
      const calls = vi.mocked(native.setDeviceReroutedCallback).mock.calls;
      const callback = calls.at(-1)?.[0];

      if (!callback) throw new Error("no device-rerouted callback was registered");

      return callback;
    }

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("logs one info line, with no parameters, per reroute", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, []);
      getAudio().init();
      vi.mocked(mockLogger.info).mockClear();

      registeredRerouteCallback(native)();

      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith("Audio device rerouted");
    });

    it("registers whether or not a session identity is given", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, []);
      getAudio().init();

      expect(native.setSessionIdentity).not.toHaveBeenCalled();
      expect(native.setDeviceReroutedCallback).toHaveBeenCalledTimes(1);
    });

    it("touches nothing native from the constructor — init() registers it, before the engine exists", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, []);

      expect(native.setDeviceReroutedCallback).not.toHaveBeenCalled();

      getAudio().init();

      expect(vi.mocked(native.setDeviceReroutedCallback).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(native.initAudioEngine).mock.invocationCallOrder[0],
      );
    });

    it("registers once however often init() is called while the engine is ready", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, []);
      getAudio().init();
      getAudio().init();

      expect(native.setDeviceReroutedCallback).toHaveBeenCalledTimes(1);
    });

    it("registers again on the init() after a destroy(), which clears it natively", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, []);
      getAudio().init();
      getAudio().destroy();
      getAudio().init();

      expect(native.setDeviceReroutedCallback).toHaveBeenCalledTimes(2);
      expect(vi.mocked(native.setDeviceReroutedCallback).mock.invocationCallOrder[1]).toBeGreaterThan(
        vi.mocked(native.destroyAudioEngine).mock.invocationCallOrder[0],
      );

      vi.mocked(mockLogger.info).mockClear();
      registeredRerouteCallback(native)();

      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith("Audio device rerouted");
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

    describe("held open (#1347 — one device open for a whole session, not one per burst)", () => {
      const HELD = "Audio device held open";
      const RELEASED = "Audio device hold released";
      const STARTED = "Audio device started";
      const STOPPED = "Audio device stopped (idle)";
      const HOLD_FAILED = "Audio device could not be held open; sounds will open it on demand";
      const DEVICE_LOST = "Audio device was lost; the next sound reopens it";
      const PLAY_FAILED = "Failed to start audio playback device";

      /** How often the service has logged exactly `line` at `level` since the mocks were last cleared. */
      function logged(level: "debug" | "info" | "warn" | "error", line: string): number {
        return vi.mocked(mockLogger[level]).mock.calls.filter(([message]) => message === line).length;
      }

      beforeEach(() => {
        vi.clearAllMocks();
      });

      it("hold starts the device without waiting for a sound", () => {
        const { native } = createServiceWithEndCallbacks();

        getAudio().hold("session");

        expect(native.startAudioEngine).toHaveBeenCalledTimes(1);
        expect(native.playOnChannel).not.toHaveBeenCalled();
      });

      it("a sound played while held does not open the device a second time", () => {
        const { native } = createServiceWithEndCallbacks();
        getAudio().hold("session");

        expect(getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3")).toBe(true);

        // The native layer is asked again, because a held device can go away
        // with nothing telling this layer; it reports the device running, so
        // nothing is reopened.
        expect(native.startAudioEngine).toHaveBeenCalledTimes(2);
        expect(logged("info", STARTED)).toBe(1);
        expect(native.stopAudioEngine).not.toHaveBeenCalled();
      });

      it("on demand a sound within a burst does not ask the native layer again", () => {
        const { native } = createServiceWithEndCallbacks();

        getAudio().playOnChannel(AudioChannel.Voice, "/a.mp3");
        getAudio().playOnChannel(AudioChannel.SFX, "/b.mp3");

        expect(native.startAudioEngine).toHaveBeenCalledTimes(1);
      });

      it("a held device that went away is noticed at the next sound, and the sound after that reopens it", () => {
        const { native, endCallbacks } = createServiceWithEndCallbacks();
        getAudio().hold("session");

        // The selected device disappears: the native layer cannot start it,
        // and has torn its engine down.
        vi.mocked(native.startAudioEngine).mockReturnValueOnce(false);

        expect(getAudio().playOnChannel(AudioChannel.Voice, "/lost.mp3")).toBe(false);
        expect(logged("warn", DEVICE_LOST)).toBe(1);
        expect(logged("error", PLAY_FAILED)).toBe(1);
        expect(logged("warn", HOLD_FAILED)).toBe(0);

        expect(getAudio().playOnChannel(AudioChannel.Voice, "/next.mp3")).toBe(true);
        expect(logged("info", STARTED)).toBe(2);
        // Still the same hold: it is not announced a second time.
        expect(logged("info", HELD)).toBe(1);

        // And still held: the reopened device stays up through the silence.
        endCallbacks[AudioChannel.Voice]();
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS * 100);

        expect(native.stopAudioEngine).not.toHaveBeenCalled();
        expect(logged("warn", DEVICE_LOST)).toBe(1);
      });

      it("drains every channel when a held device is lost, so the idle stop can arm after the release", () => {
        const { native, endCallbacks } = createServiceWithEndCallbacks();
        const completed: AudioChannel[] = [];
        getAudio().setPlaybackObserver({ onComplete: (channel) => completed.push(channel) });
        getAudio().hold("session");
        // A loop whose engine is about to go: it will never report an end.
        getAudio().playOnChannel(AudioChannel.Ambient, "/bed.mp3", true);

        vi.mocked(native.startAudioEngine).mockReturnValueOnce(false);
        getAudio().playOnChannel(AudioChannel.Voice, "/lost.mp3");

        expect(completed).toEqual([AudioChannel.Ambient]);

        getAudio().playOnChannel(AudioChannel.Voice, "/next.mp3");
        endCallbacks[AudioChannel.Voice]();
        getAudio().release("session");
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS);

        expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);
      });

      it("a second reason arriving on a lost device says so and warns that it could not be held", () => {
        const { native } = createServiceWithEndCallbacks();
        getAudio().hold("session");
        vi.mocked(native.startAudioEngine).mockReturnValueOnce(false);

        getAudio().hold("preview");

        expect(logged("warn", DEVICE_LOST)).toBe(1);
        expect(logged("warn", HOLD_FAILED)).toBe(1);
        expect(mockLogger.error).not.toHaveBeenCalled();
      });

      it("hold cancels a pending idle stop", () => {
        const { native, endCallbacks } = createServiceWithEndCallbacks();
        getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");
        endCallbacks[AudioChannel.Voice]();
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS - 1);

        getAudio().hold("session");
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS * 100);

        expect(native.stopAudioEngine).not.toHaveBeenCalled();
        // The device the clip opened is the one being held — no second open.
        expect(logged("info", STARTED)).toBe(1);
      });

      it("arms no idle stop while held, however long the channels stay idle", () => {
        const { native } = createServiceWithEndCallbacks();
        getAudio().hold("session");

        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS * 100);

        expect(native.stopAudioEngine).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      });

      it("arms no idle stop when a clip ends while held", () => {
        const { native, endCallbacks } = createServiceWithEndCallbacks();
        getAudio().hold("session");
        getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");
        endCallbacks[AudioChannel.Voice]();

        expect(vi.getTimerCount()).toBe(0);

        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS * 100);

        expect(native.stopAudioEngine).not.toHaveBeenCalled();
        expect(logged("info", STARTED)).toBe(1);
      });

      it("arms no idle stop when the channels are stopped by hand while held", () => {
        const { native } = createServiceWithEndCallbacks();
        getAudio().hold("session");
        getAudio().playOnChannel(AudioChannel.Ambient, "/ambient.mp3", true);
        getAudio().playOnChannel(AudioChannel.Radar, "/tick.mp3");

        getAudio().stopChannel(AudioChannel.Radar);
        getAudio().stopAllChannels();
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS * 100);

        expect(native.stopAudioEngine).not.toHaveBeenCalled();
      });

      it("release of the last reason arms the idle stop, and the device closes one idle window later", () => {
        const { native } = createServiceWithEndCallbacks();
        getAudio().hold("session");
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS * 100);

        getAudio().release("session");

        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS - 1);
        expect(native.stopAudioEngine).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);
      });

      it("release with a clip still playing closes the device one idle window after the clip ends", () => {
        const { native, endCallbacks } = createServiceWithEndCallbacks();
        getAudio().hold("session");
        getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");

        getAudio().release("session");
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS * 100);

        // Nothing is armed by the release itself: the clip is never cut.
        expect(native.stopAudioEngine).not.toHaveBeenCalled();

        endCallbacks[AudioChannel.Voice]();

        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS - 1);
        expect(native.stopAudioEngine).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);
      });

      it("is on demand again after the release: the next sound opens the device and its end closes it", () => {
        const { native, endCallbacks } = createServiceWithEndCallbacks();
        getAudio().hold("session");
        getAudio().release("session");
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS);
        expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);

        getAudio().playOnChannel(AudioChannel.Voice, "/later.mp3");
        expect(native.startAudioEngine).toHaveBeenCalledTimes(2);

        endCallbacks[AudioChannel.Voice]();
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS);

        expect(native.stopAudioEngine).toHaveBeenCalledTimes(2);
      });

      it("two reasons need both releases", () => {
        const { native } = createServiceWithEndCallbacks();
        getAudio().hold("session");
        getAudio().hold("preview");

        getAudio().release("session");
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS * 100);

        expect(native.stopAudioEngine).not.toHaveBeenCalled();
        expect(logged("info", RELEASED)).toBe(0);

        getAudio().release("preview");
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS);

        expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);
        expect(logged("info", RELEASED)).toBe(1);
        // One device open served both holders.
        expect(logged("info", STARTED)).toBe(1);
        expect(logged("info", HELD)).toBe(1);
      });

      it("releasing an unknown reason does not release another holder's hold", () => {
        const { native } = createServiceWithEndCallbacks();
        getAudio().hold("session");
        vi.mocked(mockLogger.debug).mockClear();

        getAudio().release("preview");
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS * 100);

        expect(native.stopAudioEngine).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expect(logged("info", RELEASED)).toBe(0);
        expect(mockLogger.debug).not.toHaveBeenCalled();
      });

      it("releasing an unknown reason with nothing held changes nothing", () => {
        const { native, endCallbacks } = createServiceWithEndCallbacks();
        vi.mocked(mockLogger.info).mockClear();
        vi.mocked(mockLogger.debug).mockClear();

        getAudio().release("session");

        expect(mockLogger.info).not.toHaveBeenCalled();
        expect(mockLogger.debug).not.toHaveBeenCalled();
        expect(native.startAudioEngine).not.toHaveBeenCalled();
        expect(native.stopAudioEngine).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);

        // Nor does it re-time a stop that was already pending.
        getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");
        endCallbacks[AudioChannel.Voice]();
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS - 1);
        getAudio().release("session");
        vi.advanceTimersByTime(1);

        expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);
      });

      it("a repeated hold of the same reason neither restarts the device nor logs again", () => {
        const { native } = createServiceWithEndCallbacks();
        getAudio().hold("session");
        vi.mocked(mockLogger.info).mockClear();
        vi.mocked(mockLogger.debug).mockClear();

        getAudio().hold("session");

        expect(native.startAudioEngine).toHaveBeenCalledTimes(1);
        expect(mockLogger.info).not.toHaveBeenCalled();
        expect(mockLogger.debug).not.toHaveBeenCalled();
      });

      it("a repeated hold is still one hold: a single release gives it up", () => {
        const { native } = createServiceWithEndCallbacks();
        getAudio().hold("session");
        getAudio().hold("session");

        getAudio().release("session");
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS);

        expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);
      });

      it("a failed start while holding warns once, with no error line, and playback still opens the device on demand", () => {
        const { native, endCallbacks } = createServiceWithEndCallbacks();
        vi.mocked(native.startAudioEngine).mockReturnValueOnce(false);

        getAudio().hold("session");

        expect(native.startAudioEngine).toHaveBeenCalledTimes(1);
        expect(logged("warn", HOLD_FAILED)).toBe(1);
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.error).not.toHaveBeenCalled();
        expect(logged("info", HELD)).toBe(0);
        expect(logged("info", STARTED)).toBe(0);

        // The hold is still recorded: the next sound opens the device as it
        // would on demand, and from then on the device stays up.
        expect(getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3")).toBe(true);
        expect(native.startAudioEngine).toHaveBeenCalledTimes(2);
        expect(logged("info", STARTED)).toBe(1);

        endCallbacks[AudioChannel.Voice]();
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS * 100);

        expect(native.stopAudioEngine).not.toHaveBeenCalled();
        expect(logged("warn", HOLD_FAILED)).toBe(1);
        expect(mockLogger.error).not.toHaveBeenCalled();

        getAudio().release("session");
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS);

        expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);
      });

      it("a play that fails to start the device while held keeps the playback error line, not the hold warning", () => {
        const { native } = createServiceWithEndCallbacks();
        vi.mocked(native.startAudioEngine).mockReturnValue(false);
        getAudio().hold("session");
        vi.mocked(mockLogger.warn).mockClear();

        expect(getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3")).toBe(false);

        expect(logged("error", PLAY_FAILED)).toBe(1);
        expect(mockLogger.warn).not.toHaveBeenCalled();
      });

      it("each further reason retries a failed start, and warns once per failed attempt", () => {
        const { native } = createServiceWithEndCallbacks();
        vi.mocked(native.startAudioEngine).mockReturnValueOnce(false).mockReturnValueOnce(false);

        getAudio().hold("session");
        getAudio().hold("preview");

        expect(native.startAudioEngine).toHaveBeenCalledTimes(2);
        expect(logged("warn", HOLD_FAILED)).toBe(2);

        getAudio().hold("third");

        expect(native.startAudioEngine).toHaveBeenCalledTimes(3);
        expect(logged("warn", HOLD_FAILED)).toBe(2);
        expect(logged("info", STARTED)).toBe(1);
        expect(mockLogger.error).not.toHaveBeenCalled();
      });

      it("a hold taken before init() warns without asking the native layer, and holds once a sound has opened the device", () => {
        const native = createMockNative();
        const endCallbacks: Record<number, () => void> = {};
        vi.mocked(native.setChannelEndCallback).mockImplementation((channel, callback) => {
          endCallbacks[channel] = callback;
        });
        initializeAudio(mockLogger as never, native);

        getAudio().hold("session");

        expect(native.startAudioEngine).not.toHaveBeenCalled();
        expect(logged("warn", HOLD_FAILED)).toBe(1);
        expect(mockLogger.error).not.toHaveBeenCalled();
        expect(logged("info", HELD)).toBe(0);

        // init() opens no device by itself, held or not (#849).
        getAudio().init();
        expect(native.startAudioEngine).not.toHaveBeenCalled();

        getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");
        endCallbacks[AudioChannel.Voice]();
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS * 100);

        expect(native.startAudioEngine).toHaveBeenCalledTimes(1);
        expect(native.stopAudioEngine).not.toHaveBeenCalled();
      });

      it("a hold taken after a failed init() warns the same way", () => {
        const native = createMockNative();
        vi.mocked(native.initAudioEngine).mockReturnValue(false);
        initializeAudio(mockLogger as never, native);
        getAudio().init();
        vi.mocked(mockLogger.error).mockClear();

        getAudio().hold("session");

        expect(native.startAudioEngine).not.toHaveBeenCalled();
        expect(logged("warn", HOLD_FAILED)).toBe(1);
        expect(mockLogger.error).not.toHaveBeenCalled();
      });

      it("a device switch while held reopens the device at once, on the new device", () => {
        const { native } = createServiceWithEndCallbacks();
        getAudio().hold("session");

        expect(getAudio().setAudioDevice(1)).toBe(true);

        expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);
        expect(native.startAudioEngine).toHaveBeenCalledTimes(2);

        // Closed, pointed at the new device, then opened — in that order.
        const switched = vi.mocked(native.setAudioDevice).mock.invocationCallOrder[0];
        const closed = vi.mocked(native.stopAudioEngine).mock.invocationCallOrder[0];
        const reopened = vi.mocked(native.startAudioEngine).mock.invocationCallOrder[1];
        expect(switched).toBeLessThan(reopened);
        expect(closed).toBeLessThan(reopened);

        // Still held on the new device: no idle stop, and a sound needs no start.
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS * 100);
        getAudio().playOnChannel(AudioChannel.Voice, "/after-switch.mp3");

        expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);
        expect(logged("info", STARTED)).toBe(2);
      });

      it("a device switch by id while held reopens the device at once, on the new device", () => {
        const { native } = createServiceWithEndCallbacks();
        getAudio().hold("session");

        expect(getAudio().setAudioDeviceById("BBBB")).toBe(true);

        expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);
        expect(native.startAudioEngine).toHaveBeenCalledTimes(2);

        const switched = vi.mocked(native.setAudioDeviceById).mock.invocationCallOrder[0];
        const closed = vi.mocked(native.stopAudioEngine).mock.invocationCallOrder[0];
        const reopened = vi.mocked(native.startAudioEngine).mock.invocationCallOrder[1];
        expect(switched).toBeLessThan(reopened);
        expect(closed).toBeLessThan(reopened);

        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS * 100);

        expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);
      });

      it("a rejected id while held leaves the reopen to the caller's fallback: one open, not two", () => {
        const { native } = createServiceWithEndCallbacks();
        vi.mocked(native.setAudioDeviceById).mockReturnValue(false);
        getAudio().hold("session");

        expect(getAudio().setAudioDeviceById("STALE-ID")).toBe(false);

        // Closed like any switch, and not reopened on the selection the caller
        // is moving away from.
        expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);
        expect(native.startAudioEngine).toHaveBeenCalledTimes(1);
        expect(logged("warn", HOLD_FAILED)).toBe(0);

        // The fallback every caller makes opens it, once, on the default.
        expect(getAudio().setAudioDevice(-1)).toBe(true);

        expect(native.startAudioEngine).toHaveBeenCalledTimes(2);
        expect(logged("info", STARTED)).toBe(2);
      });

      it("a rejected id with no fallback gets the device at the next sound, and the hold keeps it", () => {
        const { native, endCallbacks } = createServiceWithEndCallbacks();
        vi.mocked(native.setAudioDeviceById).mockReturnValue(false);
        getAudio().hold("session");
        getAudio().setAudioDeviceById("STALE-ID");

        expect(getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3")).toBe(true);
        endCallbacks[AudioChannel.Voice]();
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS * 100);

        expect(logged("info", STARTED)).toBe(2);
        expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);
      });

      it("a refused device switch while held reopens the device too", () => {
        const { native } = createServiceWithEndCallbacks();
        vi.mocked(native.setAudioDevice).mockReturnValue(false);
        getAudio().hold("session");

        expect(getAudio().setAudioDevice(7)).toBe(false);

        expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);
        expect(native.startAudioEngine).toHaveBeenCalledTimes(2);
      });

      it("a reopen that fails after a device switch warns, and the next sound opens the device", () => {
        const { native, endCallbacks } = createServiceWithEndCallbacks();
        getAudio().hold("session");
        vi.mocked(native.startAudioEngine).mockReturnValueOnce(false);

        getAudio().setAudioDeviceById("BBBB");

        expect(logged("warn", HOLD_FAILED)).toBe(1);
        expect(mockLogger.error).not.toHaveBeenCalled();

        expect(getAudio().playOnChannel(AudioChannel.Voice, "/after-switch.mp3")).toBe(true);
        expect(native.startAudioEngine).toHaveBeenCalledTimes(3);

        endCallbacks[AudioChannel.Voice]();
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS * 100);

        // One stop, the switch's own — none for idleness.
        expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);
      });

      it("a device switch while not held leaves the device closed, as before", () => {
        const { native } = createServiceWithEndCallbacks();
        getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");

        getAudio().setAudioDevice(1);
        getAudio().setAudioDeviceById("BBBB");
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS * 100);

        // Only the play's start: neither switch reopened anything.
        expect(native.startAudioEngine).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).not.toHaveBeenCalled();
      });

      it("a device switch after the last release leaves the device closed", () => {
        const { native } = createServiceWithEndCallbacks();
        getAudio().hold("session");
        getAudio().release("session");

        getAudio().setAudioDevice(1);
        getAudio().setAudioDeviceById("BBBB");
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS * 100);

        // Only the hold's start.
        expect(native.startAudioEngine).toHaveBeenCalledTimes(1);
      });

      it("destroy clears every hold: after the next init the device is on demand again", () => {
        const { native, endCallbacks } = createServiceWithEndCallbacks();
        getAudio().hold("session");
        getAudio().hold("preview");

        getAudio().destroy();
        getAudio().init();
        vi.mocked(native.startAudioEngine).mockClear();
        vi.mocked(native.stopAudioEngine).mockClear();

        // init() does not reopen for a hold that no longer exists.
        expect(native.startAudioEngine).not.toHaveBeenCalled();

        getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");
        endCallbacks[AudioChannel.Voice]();
        vi.advanceTimersByTime(IDLE_STOP_DELAY_MS);

        expect(native.startAudioEngine).toHaveBeenCalledTimes(1);
        expect(native.stopAudioEngine).toHaveBeenCalledTimes(1);
      });

      it("a reason held before destroy is unknown afterwards, and can be taken afresh", () => {
        const { native } = createServiceWithEndCallbacks();
        getAudio().hold("session");
        getAudio().destroy();
        getAudio().init();
        vi.clearAllMocks();

        getAudio().release("session");

        expect(mockLogger.info).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);

        getAudio().hold("session");

        expect(native.startAudioEngine).toHaveBeenCalledTimes(1);
        expect(logged("info", HELD)).toBe(1);
      });

      describe("log lines", () => {
        it("says the device is held when the first reason arrives, after the device-started line", () => {
          createServiceWithEndCallbacks();
          vi.mocked(mockLogger.info).mockClear();

          getAudio().hold("session");

          expect(vi.mocked(mockLogger.info).mock.calls).toEqual([[STARTED], [HELD]]);
        });

        it("says it is held without a started line when a sound had already opened the device", () => {
          createServiceWithEndCallbacks();
          getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");
          vi.mocked(mockLogger.info).mockClear();

          getAudio().hold("session");

          expect(vi.mocked(mockLogger.info).mock.calls).toEqual([[HELD]]);
        });

        it("says nothing at info for a second reason, or for any release but the last", () => {
          createServiceWithEndCallbacks();
          getAudio().hold("session");
          vi.mocked(mockLogger.info).mockClear();

          getAudio().hold("preview");
          getAudio().release("session");

          expect(mockLogger.info).not.toHaveBeenCalled();

          getAudio().release("preview");

          expect(vi.mocked(mockLogger.info).mock.calls).toEqual([[RELEASED]]);
        });

        it("says the hold is released, then that the device stopped one idle window later", () => {
          createServiceWithEndCallbacks();
          getAudio().hold("session");
          vi.mocked(mockLogger.info).mockClear();

          getAudio().release("session");

          expect(vi.mocked(mockLogger.info).mock.calls).toEqual([[RELEASED]]);

          vi.advanceTimersByTime(IDLE_STOP_DELAY_MS);

          expect(vi.mocked(mockLogger.info).mock.calls).toEqual([[RELEASED], [STOPPED]]);
        });

        it("keeps the reason out of the info lines and names it at debug", () => {
          createServiceWithEndCallbacks();
          vi.mocked(mockLogger.debug).mockClear();

          getAudio().hold("iracing-session");
          getAudio().release("iracing-session");

          expect(vi.mocked(mockLogger.debug).mock.calls).toEqual([
            ["Hold taken: iracing-session"],
            ["Hold released: iracing-session"],
          ]);

          for (const [message] of vi.mocked(mockLogger.info).mock.calls) {
            expect(message).not.toContain("iracing-session");
          }
        });

        it("writes only the warning when the start fails, and still says released at the release", () => {
          const { native } = createServiceWithEndCallbacks();
          vi.mocked(native.startAudioEngine).mockReturnValue(false);
          vi.mocked(mockLogger.info).mockClear();

          getAudio().hold("session");

          expect(mockLogger.info).not.toHaveBeenCalled();
          expect(vi.mocked(mockLogger.warn).mock.calls).toEqual([[HOLD_FAILED]]);
          expect(mockLogger.error).not.toHaveBeenCalled();

          getAudio().release("session");

          expect(vi.mocked(mockLogger.info).mock.calls).toEqual([[RELEASED]]);
          // Nothing was opened, so nothing is armed to close.
          expect(vi.getTimerCount()).toBe(0);
        });

        it("says it is held when a sound opens the device after the hold's own start failed, once per hold", () => {
          const { native, endCallbacks } = createServiceWithEndCallbacks();
          vi.mocked(native.startAudioEngine).mockReturnValueOnce(false);
          getAudio().hold("session");
          vi.mocked(mockLogger.info).mockClear();

          getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");

          expect(vi.mocked(mockLogger.info).mock.calls).toEqual([[STARTED], [HELD]]);

          // A later sound, a second reason and a device switch all find the
          // hold already announced.
          endCallbacks[AudioChannel.Voice]();
          getAudio().playOnChannel(AudioChannel.Voice, "/msg.mp3");
          getAudio().hold("preview");
          getAudio().setAudioDevice(2);

          expect(logged("info", HELD)).toBe(1);

          getAudio().release("session");
          getAudio().release("preview");

          expect(logged("info", RELEASED)).toBe(1);

          // The next hold is a new one and says so again.
          getAudio().hold("session");

          expect(logged("info", HELD)).toBe(2);
        });

        it("says the hold is released when destroy clears it, and nothing when there was none", () => {
          createServiceWithEndCallbacks();
          getAudio().hold("session");
          getAudio().hold("preview");
          vi.mocked(mockLogger.info).mockClear();

          getAudio().destroy();

          expect(vi.mocked(mockLogger.info).mock.calls).toEqual([[RELEASED], ["Audio engine destroyed"]]);

          getAudio().init();
          vi.mocked(mockLogger.info).mockClear();

          getAudio().destroy();

          expect(vi.mocked(mockLogger.info).mock.calls).toEqual([["Audio engine destroyed"]]);
        });

        it("after a device switch while held, the started line follows the switched line and held is not repeated", () => {
          createServiceWithEndCallbacks();
          getAudio().hold("session");
          vi.mocked(mockLogger.info).mockClear();

          getAudio().setAudioDevice(1);

          expect(vi.mocked(mockLogger.info).mock.calls).toEqual([["Audio output device switched"], [STARTED]]);
        });
      });
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

  it("prefers the earlier root when two unbound roots both have the file", () => {
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

  describe("a pack root serves only the clips the scan admitted from it", () => {
    const EVIL = path.resolve("/packs/aaa-evil");

    it("does not let an earlier pack serve a clip belonging to a later one", () => {
      // `aaa-evil` has the file ON DISK — the scanner drops a foreign-voice file
      // from a pack's clip list rather than deleting it — and sorts first, so
      // file presence alone would hand every luca callout aaa-evil's audio, with
      // nothing said in the settings list or the collision problems.
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, [{ dir: PLUGIN }]);
      getAudio().init();
      getAudio().setFileProbe((candidate) => candidate.startsWith(EVIL) || candidate.startsWith(PACK));

      getAudio().setRoots([
        { dir: PLUGIN },
        { dir: EVIL, clips: ["voice/aaa-evil/a.mp3"] },
        { dir: PACK, clips: ["voice/luca/a.mp3"] },
      ]);
      getAudio().playOnChannel(AudioChannel.Voice, "voice/luca/a.mp3");

      expect(playedPath(native)).toBe(posix(path.join(PACK, "voice/luca/a.mp3")));
    });

    it("does not let a pack supply a plugin-root clip the plugin does not ship", () => {
      // The scanner admits only a pack's own voices, but it cannot stop one
      // SHIPPING files under any other path. A clip the unrestricted root does
      // not have must still resolve there, never to a pack that planted it.
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, [{ dir: PLUGIN }]);
      getAudio().init();
      getAudio().setFileProbe((candidate) => candidate.startsWith(EVIL));

      getAudio().setRoots([{ dir: PLUGIN }, { dir: EVIL, clips: ["voice/aaa-evil/a.mp3"] }]);
      getAudio().playOnChannel(AudioChannel.Voice, "voice/default/rare-01.mp3");

      expect(playedPath(native)).toBe(posix(path.join(PLUGIN, "voice/default/rare-01.mp3")));
    });

    it("refuses a `..` path that escapes one root and lands inside a sibling pack root", () => {
      // Pack roots are siblings under one parent, so containment alone cannot
      // refuse this: the path pops out of the plugin root and back into the pack,
      // where `path.relative` reports no `..` at all. The allow-list is what
      // refuses it — no scan ever produces a clip path spelled this way.
      const native = createMockNative();
      const sibling = path.resolve("/plugin/assets/audio/../../packs/luca/voice/luca/a.mp3");
      initializeAudio(mockLogger as never, native, [{ dir: PLUGIN }]);
      getAudio().init();
      getAudio().setFileProbe((candidate) => candidate === sibling);

      getAudio().setRoots([{ dir: PLUGIN }, { dir: PACK, clips: ["voice/luca/a.mp3"] }]);

      expect(() => getAudio().playOnChannel(AudioChannel.Voice, "../../packs/luca/voice/luca/a.mp3")).toThrow(
        "escapes",
      );
    });

    it("still serves the clips a pack WAS admitted for", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, [{ dir: PLUGIN }]);
      getAudio().init();
      getAudio().setFileProbe((candidate) => candidate.startsWith(PACK));

      getAudio().setRoots([{ dir: PLUGIN }, { dir: PACK, clips: ["voice/luca/a.mp3"] }]);
      getAudio().playOnChannel(AudioChannel.Voice, "voice/luca/a.mp3");

      expect(playedPath(native)).toBe(posix(path.join(PACK, "voice/luca/a.mp3")));
    });
  });

  it("does not resolve at all when there are no roots", () => {
    const native = createMockNative();
    initializeAudio(mockLogger as never, native);
    getAudio().init();

    getAudio().playOnChannel(AudioChannel.Voice, "voice/luca/a.mp3");

    expect(playedPath(native)).toBe("voice/luca/a.mp3");
  });

  describe("a bound root answers only its own composite voice (#1144)", () => {
    // Two packs, `a` and `b`, each shipping a voice called `matt` under the
    // SAME relative path. The engine addresses them as `voice/a::matt/…` and
    // `voice/b::matt/…`; each pack's root binds its composite to the bare
    // folder inside it, and resolves nothing else.
    const PACK_A = path.resolve("/packs/a");
    const PACK_B = path.resolve("/packs/b");
    const CLIP = "voice/matt/x/y.mp3";

    function boundRoots() {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, [{ dir: PLUGIN }]);
      getAudio().init();
      getAudio().setFileProbe((candidate) => candidate.startsWith(PACK_A) || candidate.startsWith(PACK_B));
      getAudio().setRoots([
        { dir: PLUGIN },
        { dir: PACK_A, clips: [CLIP], voices: { "a::matt": "matt" } },
        { dir: PACK_B, clips: [CLIP], voices: { "b::matt": "matt" } },
      ]);

      return native;
    }

    it("resolves each composite path inside the root bound to it, as the bare path", () => {
      const native = boundRoots();

      getAudio().playOnChannel(AudioChannel.Voice, "voice/a::matt/x/y.mp3");
      getAudio().playOnChannel(AudioChannel.Voice, "voice/b::matt/x/y.mp3");

      const calls = (native.playOnChannel as unknown as { mock: { calls: unknown[][] } }).mock.calls;

      expect(posix(String(calls[0][1]))).toBe(posix(path.join(PACK_A, CLIP)));
      expect(posix(String(calls[1][1]))).toBe(posix(path.join(PACK_B, CLIP)));
    });

    it("never serves a bare voice path from a bound root, even one that has the file", () => {
      // Both packs HAVE `voice/matt/x/y.mp3` on disk and in their allow-lists.
      // A bound root is skipped by the ordered walk entirely, so the bare path
      // falls to the unrestricted plugin root exactly as a missing clip does.
      const native = boundRoots();

      getAudio().playOnChannel(AudioChannel.Voice, CLIP);

      expect(playedPath(native)).toBe(posix(path.join(PLUGIN, CLIP)));
    });

    it("still resolves an sfx path through the plugin root", () => {
      const native = boundRoots();
      getAudio().setFileProbe((candidate) => candidate.startsWith(PLUGIN));

      getAudio().playOnChannel(AudioChannel.SFX, "sfx/tick.mp3");

      expect(playedPath(native)).toBe(posix(path.join(PLUGIN, "sfx/tick.mp3")));
    });

    it("does not serve a composite path whose bare form the bound root was not admitted for", () => {
      // The file IS on disk — the probe says yes for anything under the pack —
      // but the scanner did not admit it, and "on disk" was never the rule.
      // The path takes the unbound walk instead, which can only land on the
      // plugin root: the same "missing clip" answer an unknown path gets.
      const native = boundRoots();

      getAudio().playOnChannel(AudioChannel.Voice, "voice/a::matt/x/planted.mp3");

      expect(playedPath(native)).toBe(posix(path.join(PLUGIN, "voice/a::matt/x/planted.mp3")));
      expect(playedPath(native).startsWith(posix(PACK_A))).toBe(false);
    });

    it("does not serve a composite path whose tail steps out of the voice but stays inside the pack", () => {
      // `..` that never leaves the pack folder passes the containment check,
      // so the allow-list is the only thing between it and an undeclared
      // voice's files. The scan never admits a path spelled this way.
      const native = boundRoots();

      getAudio().playOnChannel(AudioChannel.Voice, "voice/a::matt/../undeclared/x.mp3");

      expect(playedPath(native).startsWith(posix(PACK_A))).toBe(false);
      expect(playedPath(native).startsWith(posix(PLUGIN))).toBe(true);
    });

    it("resolves to the bound root, not another, when the clip is missing there", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, [{ dir: PLUGIN }]);
      getAudio().init();
      getAudio().setFileProbe(() => false);
      getAudio().setRoots([
        { dir: PLUGIN },
        { dir: PACK_A, clips: [CLIP], voices: { "a::matt": "matt" } },
        { dir: PACK_B, clips: [CLIP], voices: { "b::matt": "matt" } },
      ]);

      getAudio().playOnChannel(AudioChannel.Voice, "voice/b::matt/x/y.mp3");

      expect(playedPath(native)).toBe(posix(path.join(PACK_B, CLIP)));
    });

    it("falls to the ordered walk for a composite nobody binds", () => {
      const native = boundRoots();
      getAudio().setFileProbe(() => false);

      getAudio().playOnChannel(AudioChannel.Voice, "voice/c::matt/x/y.mp3");

      expect(playedPath(native)).toBe(posix(path.join(PLUGIN, "voice/c::matt/x/y.mp3")));
    });

    it("refuses a composite path whose tail escapes the bound root", () => {
      boundRoots();

      expect(() => getAudio().playOnChannel(AudioChannel.Voice, "voice/a::matt/../../../etc/passwd")).toThrow(
        "escapes",
      );
    });

    it("forgets a binding when setRoots replaces it", () => {
      const native = boundRoots();

      getAudio().playOnChannel(AudioChannel.Voice, "voice/a::matt/x/y.mp3");
      expect(playedPath(native)).toBe(posix(path.join(PACK_A, CLIP)));

      // The probe is deliberately left as it is — it still says yes under
      // PACK_A — so only `setRoots` clearing the memo can change the answer.
      getAudio().setRoots([{ dir: PLUGIN }, { dir: PACK_B, clips: [CLIP], voices: { "b::matt": "matt" } }]);
      getAudio().playOnChannel(AudioChannel.Voice, "voice/a::matt/x/y.mp3");

      const calls = (native.playOnChannel as unknown as { mock: { calls: unknown[][] } }).mock.calls;

      // The memo did not survive: the path is walked again and lands on the
      // plugin root, since no root binds `a::matt` any more.
      expect(posix(String(calls[1][1]))).toBe(posix(path.join(PLUGIN, "voice/a::matt/x/y.mp3")));
    });
  });
});
