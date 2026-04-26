import type { AudioNative } from "@iracedeck/audio-native";
import { afterEach, describe, expect, it, vi } from "vitest";

import { _resetAudio, AudioChannel, getAudio, initializeAudio, isAudioInitialized } from "./audio-service.js";

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
      initializeAudio(mockLogger as never, native, "/plugin/assets/audio");
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
      initializeAudio(mockLogger as never, native, "/plugin/assets/audio");
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

    it("throws when a relative path tries to escape basePath via ..", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native, "/plugin/assets/audio");
      getAudio().init();
      expect(() => getAudio().playOnChannel(AudioChannel.Voice, "../../etc/passwd")).toThrow(/escapes basePath/);
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

    it("should use stored volume when playing on channel", () => {
      const native = createMockNative();
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      getAudio().setChannelVolume(AudioChannel.Voice, 0.6);
      getAudio().playOnChannel(AudioChannel.Voice, "/sound.mp3");
      expect(native.playOnChannel).toHaveBeenCalledWith(AudioChannel.Voice, "/sound.mp3", false, 0.6);
    });

    it("should check if channel is playing", () => {
      const native = createMockNative();
      (native.isChannelPlaying as ReturnType<typeof vi.fn>).mockReturnValue(true);
      initializeAudio(mockLogger as never, native);
      getAudio().init();
      expect(getAudio().isChannelPlaying(AudioChannel.Radar)).toBe(true);
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

      initializeAudio(mockLogger as never, native, "/plugin/assets/audio");
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
});
