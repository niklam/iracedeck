/**
 * Mock implementation of AudioNative for non-Windows platforms and tests.
 *
 * Returns success for every call but produces no audio.
 */
import type { AudioDeviceInfo } from "./index.js";

export class AudioNativeMock {
  initAudioEngine(): boolean {
    console.debug("[AudioNativeMock] initAudioEngine()");

    return true;
  }

  destroyAudioEngine(): void {
    console.debug("[AudioNativeMock] destroyAudioEngine()");
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
}

const MOCK_DEVICE_ID = "mock-device-0";
