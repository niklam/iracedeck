/**
 * @iracedeck/audio-native
 *
 * Native Node.js addon wrapping the miniaudio single-header library.
 * Provides a 5-channel mixer (one channel per {@link AudioChannel} entry) used by
 * the Race Engineer, the radar and other audio actions.
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
 *
 * The indices are dense from 0, and `IRD_MAX_CHANNELS` in `addon.cc` is their
 * count: a new channel is an entry here, the same entry in
 * `@iracedeck/audio-service`'s copy of this enum, and a bump of that constant.
 * A binary built before the bump refuses the new channel (its play returns
 * false), so a stale `.node` makes the channel silent rather than crashing.
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
  /**
   * Control feedback such as the volume step tick (#1455). Routed to no bus in
   * `@iracedeck/audio-service`: each clip is played at a level its caller passes.
   */
  Feedback = 4,
}

/**
 * Audio device descriptor returned by {@link AudioNative.getAudioDevices}.
 *
 * `id` is a hex-encoded `ma_device_id` — the platform-stable identifier
 * (WASAPI endpoint ID on Windows, CoreAudio UID on macOS, etc.) suitable
 * for persisting selection across sessions. `index` is the volatile
 * enumeration position retained for backward compatibility with
 * {@link AudioNative.setAudioDevice}.
 */
export type AudioDeviceInfo = { index: number; name: string; id: string; isDefault: boolean };

/**
 * How this package's native addon was loaded (#1373). Read once, at module load.
 *
 * - `native`: the `.node` loaded; every call goes to it.
 * - `mock` / `platform`: not Windows, so the addon was never tried.
 * - `mock` / `forced`: `IRACEDECK_MOCK` or a `.mock` file asked for the mock.
 * - `load-failed`: Windows, not forced, and the `.node` threw on load. `error`
 *   is the thrown message, which names the file and the OS reason, so it is
 *   for the log only — it holds a path under the user's profile. The class
 *   still delegates to the silent mock: nothing it does misleads but the
 *   silence, which the plugin's banner explains.
 *
 * Declared here and again, identically, in `@iracedeck/iracing-native`: both
 * are zero-dependency leaves, and `plugin-runtime` reads the two structurally.
 */
export type NativeLoadStatus =
  | { readonly kind: "native" }
  | { readonly kind: "mock"; readonly reason: "platform" | "forced" }
  | { readonly kind: "load-failed"; readonly error: string };

/** The outcome of {@link loadNativeAddon}: the addon, or `null` for every status but `native`. */
export interface NativeLoadResult<T> {
  readonly addon: T | null;
  readonly status: NativeLoadStatus;
}

/**
 * The load decision, without the module-scope side effects (#1373): the
 * platform, the force flag and the loader come in, so the failed path is
 * testable without a `.node` and without un-mocking the suite (#1084). Off
 * Windows and under the force flag the loader is never called.
 *
 * @internal Exported for testing
 */
export function loadNativeAddon<T>(options: {
  platform: string;
  forceMock: boolean;
  load: () => T;
}): NativeLoadResult<T> {
  if (options.platform !== "win32") return { addon: null, status: { kind: "mock", reason: "platform" } };

  if (options.forceMock) return { addon: null, status: { kind: "mock", reason: "forced" } };

  try {
    return { addon: options.load(), status: { kind: "native" } };
  } catch (err) {
    return { addon: null, status: { kind: "load-failed", error: err instanceof Error ? err.message : String(err) } };
  }
}

// Load the native addon (only on Windows, and never under the force flag).
// Force mock mode by creating a `.mock` file in the sdPlugin folder,
// or by setting IRACEDECK_MOCK=1 in the environment.
const moduleLoad: NativeLoadResult<any> = loadNativeAddon({
  platform: platform(),
  forceMock: !!process.env.IRACEDECK_MOCK || existsSync(join(process.cwd(), ".mock")),
  load: () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const require = createRequire(import.meta.url);

    return require(join(__dirname, "..", "build", "Release", "audio_native.node"));
  },
});
const addon: any = moduleLoad.addon;

/** How this package's native addon was loaded at module load (#1373). Fixed for the run. */
export function getNativeLoadStatus(): NativeLoadStatus {
  return moduleLoad.status;
}

/**
 * miniaudio-backed multi-channel audio mixer, one channel per {@link AudioChannel} entry.
 *
 * On Windows, delegates to the native addon. On macOS/Linux, under the forced
 * mock, or when the `.node` failed to load (see {@link getNativeLoadStatus}),
 * delegates to {@link AudioNativeMock} which returns success for every call
 * but produces no audio.
 *
 * The method surface is the one consumed by `@iracedeck/audio-service`'s
 * `initializeAudio(logger, native, …)` — any shape-compatible object can be
 * passed in its place for testing.
 */
export class AudioNative {
  private mock: AudioNativeMock | null = null;

  private getMock(): AudioNativeMock {
    if (!this.mock) this.mock = new AudioNativeMock();

    return this.mock;
  }

  /**
   * Initialize the audio subsystem (the device-enumeration context).
   * Deliberately opens NO audio device — Windows holds a sleep-blocking
   * power request for a WASAPI stream that merely exists (issue #849), so
   * the engine/device is created lazily by {@link startAudioEngine} /
   * `playOnChannel` and torn down by {@link stopAudioEngine}.
   * @returns true if the audio subsystem is usable
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
   * Start the audio device, lazily creating the engine on the selected
   * output device first if none exists. No device exists after
   * {@link initAudioEngine} or {@link stopAudioEngine} — even an idle,
   * stopped stream makes Windows hold a sleep-blocking power request
   * (issue #849) — so callers start around actual playback. Idempotent:
   * an already-started device reports success.
   *
   * @returns true if the device is running after the call
   */
  startAudioEngine(): boolean {
    return addon ? addon.startAudioEngine() : this.getMock().startAudioEngine();
  }

  /**
   * Release the audio device entirely (engine teardown), removing the OS
   * audio stream and with it Windows' sleep-blocking power request
   * (issue #849). Any sounds still loaded are released with the engine —
   * callers stop only when every channel is idle. The next play or
   * {@link startAudioEngine} recreates the engine on demand. Idempotent.
   *
   * @returns true if no device exists after the call
   */
  stopAudioEngine(): boolean {
    return addon ? addon.stopAudioEngine() : this.getMock().stopAudioEngine();
  }

  /**
   * Play an audio file on a specific mixer channel.
   * Stops any existing sound on that channel first.
   * Supports WAV, MP3, and FLAC formats.
   *
   * @param channel - Channel index (an {@link AudioChannel} value)
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
   * @param channel - Channel index (an {@link AudioChannel} value)
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
   * @param channel - Channel index (an {@link AudioChannel} value)
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
   * @param channel - Channel index (an {@link AudioChannel} value)
   * @returns true if the channel has active playback
   */
  isChannelPlaying(channel: number): boolean {
    return addon ? addon.isChannelPlaying(channel) : this.getMock().isChannelPlaying(channel);
  }

  /**
   * Register a callback that fires when a channel's sound finishes playing.
   * The callback is marshaled from the audio thread to the JS main thread.
   *
   * @param channel - Channel index (an {@link AudioChannel} value)
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

  /**
   * Switch audio output to a device looked up by its stable `id` from
   * {@link getAudioDevices}. Returns true on success, false if the id is
   * unknown to the current enumeration (e.g. unplugged device).
   */
  setAudioDeviceById(deviceId: string): boolean {
    if (addon) {
      return addon.setAudioDeviceById(deviceId);
    }

    return this.getMock().setAudioDeviceById(deviceId);
  }

  /**
   * Set the name, and optionally the icon, that the Windows Volume Mixer
   * shows for our audio session instead of the host executable's ("Node")
   * (issue #1253). Applied to every engine created afterwards and reapplied
   * when the output follows a default-device change. Refused while an engine
   * exists, so call it before the first play; {@link destroyAudioEngine}
   * clears it. A no-op off Windows.
   *
   * @param displayName - The session's display name; empty clears the identity
   * @param iconPath - Optional absolute path to an `.ico` file
   * @returns true if the identity was stored; false while an engine exists,
   *          or when the loaded native binary predates this method
   */
  setSessionIdentity(displayName: string, iconPath?: string): boolean {
    if (addon) {
      return callAddonSetSessionIdentity(addon, displayName, iconPath);
    }

    return this.getMock().setSessionIdentity(displayName, iconPath);
  }

  /**
   * Register a callback that fires, on the JS thread, each time the output
   * follows a default-device change onto a new endpoint (issue #1330). It
   * fires whether or not an identity is set: the native layer reapplies the
   * session identity on a thread of its own (issue #1411), so the JS thread
   * does nothing on a reroute but this. A callback that throws is swallowed.
   * Pass `null` to clear it; {@link destroyAudioEngine} clears it too. A no-op
   * off Windows, and when the loaded native binary predates this method.
   *
   * @param callback - Function to call on reroute, or null to clear
   */
  setDeviceReroutedCallback(callback: (() => void) | null): void {
    if (addon) {
      callAddonSetDeviceReroutedCallback(addon, callback);
    } else {
      this.getMock().setDeviceReroutedCallback(callback);
    }
  }
}

/**
 * Call the addon's `setSessionIdentity`, or report false when the loaded
 * binary predates it. The TypeScript and the binary are built by separate
 * steps, so a plugin can start against an older `audio_native.node` (before
 * #1258, a binary a deck host had loaded survived every rebuild), and a
 * missing function must not throw inside `initializeAudio` and abort plugin
 * startup over a cosmetic feature (#1253).
 *
 * @internal Exported for testing
 */
export function callAddonSetSessionIdentity(
  nativeAddon: { setSessionIdentity?: unknown },
  displayName: string,
  iconPath?: string,
): boolean {
  if (typeof nativeAddon.setSessionIdentity !== "function") {
    return false;
  }

  return nativeAddon.setSessionIdentity(displayName, iconPath) === true;
}

/**
 * Call the addon's `setDeviceReroutedCallback`, or do nothing when the loaded
 * binary predates it — the same tolerance as
 * {@link callAddonSetSessionIdentity}: a missing function must not throw inside
 * `init()` and abort plugin startup over a diagnostic log line (#1330).
 *
 * @internal Exported for testing
 */
export function callAddonSetDeviceReroutedCallback(
  nativeAddon: { setDeviceReroutedCallback?: unknown },
  callback: (() => void) | null,
): void {
  if (typeof nativeAddon.setDeviceReroutedCallback !== "function") {
    return;
  }

  nativeAddon.setDeviceReroutedCallback(callback);
}
