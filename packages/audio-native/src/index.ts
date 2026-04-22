/**
 * @iracedeck/audio-native
 *
 * Native Node.js addon wrapping the miniaudio single-header library.
 * Provides a 4-channel mixer used by Pit Crew and other audio actions.
 *
 * On non-Windows platforms, a mock implementation is used automatically
 * to enable development and testing on macOS/Linux.
 */
import { existsSync } from "fs";
import { createRequire } from "module";
import { platform } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { AudioNativeMock } from "./mock-impl.js";

export { AudioNativeMock } from "./mock-impl.js";

/**
 * Audio mixer channel indices for the miniaudio engine.
 */
export enum AudioChannel {
  /** Pit lane background noise (loops) */
  Ambient = 0,
  /** Walkie-talkie open/close ticks */
  SFX = 1,
  /** Engineer voice messages, reminders, toggles */
  Voice = 2,
  /** Directional radar ticks (independent) */
  Radar = 3,
}

/** Audio device descriptor returned by {@link AudioNative.getAudioDevices}. */
export type AudioDeviceInfo = { index: number; name: string; isDefault: boolean };

// Try to load native addon (only on Windows, with safety catch).
// Force mock mode by creating a `.mock` file in the sdPlugin folder,
// or by setting IRACEDECK_MOCK=1 in the environment.
let addon: any = null;
const forceMock = !!process.env.IRACEDECK_MOCK || existsSync(join(process.cwd(), ".mock"));

if (platform() === "win32" && !forceMock) {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const require = createRequire(import.meta.url);
    addon = require(join(__dirname, "..", "build", "Release", "audio_native.node"));
  } catch {
    /* Native addon not available — mock will be used */
  }
}

/**
 * miniaudio-backed 4-channel audio mixer.
 *
 * On Windows, delegates to the native addon. On macOS/Linux (or when the
 * native addon is unavailable), delegates to {@link AudioNativeMock} which
 * returns success for every call but produces no audio.
 *
 * The method surface is the one consumed by `@iracedeck/audio-service`'s
 * `initializeAudio(logger, native)` — any shape-compatible object can be
 * passed in its place for testing.
 */
export class AudioNative {
  private mock: AudioNativeMock | null = null;

  private getMock(): AudioNativeMock {
    if (!this.mock) this.mock = new AudioNativeMock();

    return this.mock;
  }

  /**
   * Initialize the miniaudio audio engine.
   * @returns true if the engine was created successfully
   */
  initAudioEngine(): boolean {
    return addon ? addon.initAudioEngine() : this.getMock().initAudioEngine();
  }

  /**
   * Destroy the miniaudio engine and release all resources.
   */
  destroyAudioEngine(): void {
    if (addon) {
      addon.destroyAudioEngine();
    } else {
      this.getMock().destroyAudioEngine();
    }
  }

  /**
   * Play an audio file on a specific mixer channel.
   * Stops any existing sound on that channel first.
   * Supports WAV, MP3, and FLAC formats.
   *
   * @param channel - Channel index (0–3, use AudioChannel enum)
   * @param filePath - Absolute path to the audio file
   * @param loop - Whether to loop the sound (default false)
   * @param volume - Volume level 0.0–1.0 (default 1.0)
   * @returns true if playback started successfully
   */
  playOnChannel(channel: number, filePath: string, loop = false, volume = 1.0): boolean {
    return addon
      ? addon.playOnChannel(channel, filePath, loop, volume)
      : this.getMock().playOnChannel(channel, filePath, loop, volume);
  }

  /**
   * Stop playback on a specific channel and release the sound.
   * @param channel - Channel index (0–3)
   */
  stopChannel(channel: number): void {
    if (addon) {
      addon.stopChannel(channel);
    } else {
      this.getMock().stopChannel(channel);
    }
  }

  /**
   * Set the volume on a specific channel.
   * @param channel - Channel index (0–3)
   * @param volume - Volume level 0.0–1.0
   */
  setChannelVolume(channel: number, volume: number): void {
    if (addon) {
      addon.setChannelVolume(channel, volume);
    } else {
      this.getMock().setChannelVolume(channel, volume);
    }
  }

  /**
   * Check if a channel is currently playing audio.
   * @param channel - Channel index (0–3)
   * @returns true if the channel has active playback
   */
  isChannelPlaying(channel: number): boolean {
    return addon ? addon.isChannelPlaying(channel) : this.getMock().isChannelPlaying(channel);
  }

  /**
   * Register a callback that fires when a channel's sound finishes playing.
   * The callback is marshaled from the audio thread to the JS main thread.
   *
   * @param channel - Channel index (0–3)
   * @param callback - Function to call when playback completes
   */
  setChannelEndCallback(channel: number, callback: () => void): void {
    if (addon) {
      addon.setChannelEndCallback(channel, callback);
    } else {
      this.getMock().setChannelEndCallback(channel, callback);
    }
  }

  /**
   * Stop all mixer channels.
   */
  stopAllChannels(): void {
    if (addon) {
      addon.stopAllChannels();
    } else {
      this.getMock().stopAllChannels();
    }
  }

  /**
   * Seek a channel to a random position (for ambient variation).
   */
  seekChannelRandom(channel: number): void {
    if (addon) {
      addon.seekChannelRandom(channel);
    } else {
      this.getMock().seekChannelRandom(channel);
    }
  }

  /**
   * Get list of available audio playback devices.
   */
  getAudioDevices(): AudioDeviceInfo[] {
    if (addon) {
      return addon.getAudioDevices();
    }

    return this.getMock().getAudioDevices();
  }

  /**
   * Switch audio output to a specific device. -1 for system default.
   */
  setAudioDevice(deviceIndex: number): boolean {
    if (addon) {
      return addon.setAudioDevice(deviceIndex);
    }

    return this.getMock().setAudioDevice(deviceIndex);
  }
}
