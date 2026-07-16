import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudioNativeMock } from "./mock-impl.js";

describe("AudioNativeMock", () => {
  let mock: AudioNativeMock;

  beforeEach(() => {
    mock = new AudioNativeMock();
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("engine lifecycle", () => {
    it("initAudioEngine returns true and logs", () => {
      expect(mock.initAudioEngine()).toBe(true);
      expect(console.debug).toHaveBeenCalled();
    });

    it("destroyAudioEngine does not throw and logs", () => {
      expect(() => mock.destroyAudioEngine()).not.toThrow();
      expect(console.debug).toHaveBeenCalled();
    });

    it("startAudioEngine returns true", () => {
      expect(mock.startAudioEngine()).toBe(true);
    });

    it("stopAudioEngine returns true", () => {
      expect(mock.stopAudioEngine()).toBe(true);
    });
  });

  describe("channel operations", () => {
    it("playOnChannel returns true with any args", () => {
      expect(mock.playOnChannel(0, "/some/path.mp3")).toBe(true);
      expect(mock.playOnChannel(2, "/other.mp3", true, 0.5)).toBe(true);
    });

    it("stopChannel does not throw", () => {
      expect(() => mock.stopChannel(1)).not.toThrow();
    });

    it("setChannelVolume does not throw", () => {
      expect(() => mock.setChannelVolume(2, 0.75)).not.toThrow();
    });

    it("isChannelPlaying always returns false", () => {
      expect(mock.isChannelPlaying(0)).toBe(false);
      expect(mock.isChannelPlaying(3)).toBe(false);
    });

    it("setChannelEndCallback does not throw", () => {
      expect(() => mock.setChannelEndCallback(0, () => {})).not.toThrow();
    });

    it("stopAllChannels does not throw", () => {
      expect(() => mock.stopAllChannels()).not.toThrow();
    });

    it("seekChannelRandom does not throw", () => {
      expect(() => mock.seekChannelRandom(0)).not.toThrow();
    });
  });

  describe("device enumeration", () => {
    it("getAudioDevices returns a single default mock device with a stable id", () => {
      const devices = mock.getAudioDevices();
      expect(devices).toEqual([{ index: 0, name: "Mock Audio Device", id: "mock-device-0", isDefault: true }]);
    });

    it("setAudioDevice returns true for any index", () => {
      expect(mock.setAudioDevice(-1)).toBe(true);
      expect(mock.setAudioDevice(0)).toBe(true);
      expect(mock.setAudioDevice(99)).toBe(true);
    });

    it("setAudioDeviceById returns true for the known mock id", () => {
      expect(mock.setAudioDeviceById("mock-device-0")).toBe(true);
    });

    it("setAudioDeviceById returns false for unknown ids", () => {
      expect(mock.setAudioDeviceById("unknown-id")).toBe(false);
      expect(mock.setAudioDeviceById("")).toBe(false);
    });
  });
});
