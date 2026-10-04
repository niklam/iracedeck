/**
 * Mock implementation of AudioNative for non-Windows platforms and tests.
 *
 * Returns success for every call but produces no audio.
 */
import type { AudioDeviceInfo } from "./index.js";

export class AudioNativeMock {
  /** The identity last passed to {@link setSessionIdentity}, or null if none is set. */
  sessionIdentity: { displayName: string; iconPath?: string } | null = null;

  /**
   * The callback last passed to {@link setDeviceReroutedCallback}, or null if
   * none is registered. Tests call it to simulate a device reroute.
   */
  deviceReroutedCallback: (() => void) | null = null;

  initAudioEngine(): boolean {
    console.debug("[AudioNativeMock] initAudioEngine()");

    return true;
  }

  destroyAudioEngine(): void {
    console.debug("[AudioNativeMock] destroyAudioEngine()");
    // Destroying the engine clears the session identity and the reroute
    // callback, as it does natively.
    this.sessionIdentity = null;
    this.deviceReroutedCallback = null;
  }

  startAudioEngine(): boolean {
    return true;
  }

  stopAudioEngine(): boolean {
    return true;
  }

  playOnChannel(_channel: number, _filePath: string, _loop = false, _volume = 1.0): boolean {
    return true;
  }

  stopChannel(_channel: number): void {}

  setChannelVolume(_channel: number, _volume: number): void {}

  isChannelPlaying(_channel: number): boolean {
    return false;
  }

  setChannelEndCallback(_channel: number, _callback: () => void): void {}

  stopAllChannels(): void {}

  seekChannelRandom(_channel: number): void {}

  getAudioDevices(): AudioDeviceInfo[] {
    return [{ index: 0, name: "Mock Audio Device", id: MOCK_DEVICE_ID, isDefault: true }];
  }

  setAudioDevice(_deviceIndex: number): boolean {
    return true;
  }

  setAudioDeviceById(deviceId: string): boolean {
    // Mock honors only the synthetic mock id; unknown ids would be
    // unrecoverable on a real device, and tests rely on this distinction.
    return deviceId === MOCK_DEVICE_ID;
  }

  setSessionIdentity(displayName: string, iconPath?: string): boolean {
    // Recorded for tests; there is no mixer to name. An empty name clears the
    // identity, as it does natively.
    if (displayName === "") {
      this.sessionIdentity = null;
    } else {
      this.sessionIdentity = iconPath === undefined ? { displayName } : { displayName, iconPath };
    }

    return true;
  }

  setDeviceReroutedCallback(callback: (() => void) | null): void {
    // Recorded for tests; no device is ever rerouted here.
    this.deviceReroutedCallback = callback;
  }
}

const MOCK_DEVICE_ID = "mock-device-0";
