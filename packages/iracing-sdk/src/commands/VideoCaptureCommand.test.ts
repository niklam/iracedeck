import { beforeEach, describe, expect, it, vi } from "vitest";

import type { INativeSDK } from "../interfaces.js";
import { BroadcastMsg, VideoCaptureMode } from "./constants.js";
import { VideoCaptureCommand } from "./VideoCaptureCommand.js";

function createMockNative(): INativeSDK {
  return {
    startup: vi.fn(),
    shutdown: vi.fn(),
    isConnected: vi.fn(),
    getHeader: vi.fn(),
    getData: vi.fn(),
    waitForData: vi.fn(),
    getSessionInfoStr: vi.fn(),
    getVarHeaderEntry: vi.fn(),
    varNameToIndex: vi.fn(),
    broadcastMsg: vi.fn(),
    sendChatMessage: vi.fn(),
  };
}

describe("VideoCaptureCommand", () => {
  let mockNative: INativeSDK;
  let videoCaptureCommand: VideoCaptureCommand;

  beforeEach(() => {
    mockNative = createMockNative();
    videoCaptureCommand = new VideoCaptureCommand(mockNative);
  });

  describe("screenshot", () => {
    it("should send VideoCapture with TriggerScreenShot mode", () => {
      videoCaptureCommand.screenshot();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.VideoCapture,
        VideoCaptureMode.TriggerScreenShot,
        0,
        0,
      );
    });

    it("should return true", () => {
      expect(videoCaptureCommand.screenshot()).toBe(true);
    });
  });

  describe("start", () => {
    it("should send VideoCapture with StartVideoCapture mode", () => {
      videoCaptureCommand.start();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.VideoCapture,
        VideoCaptureMode.StartVideoCapture,
        0,
        0,
      );
    });

    it("should return true", () => {
      expect(videoCaptureCommand.start()).toBe(true);
    });
  });

  describe("stop", () => {
    it("should send VideoCapture with EndVideoCapture mode", () => {
      videoCaptureCommand.stop();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.VideoCapture,
        VideoCaptureMode.EndVideoCapture,
        0,
        0,
      );
    });

    it("should return true", () => {
      expect(videoCaptureCommand.stop()).toBe(true);
    });
  });

  describe("toggle", () => {
    it("should send VideoCapture with ToggleVideoCapture mode", () => {
      videoCaptureCommand.toggle();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.VideoCapture,
        VideoCaptureMode.ToggleVideoCapture,
        0,
        0,
      );
    });

    it("should return true", () => {
      expect(videoCaptureCommand.toggle()).toBe(true);
    });
  });

  describe("showTimer", () => {
    it("should send VideoCapture with ShowVideoTimer mode", () => {
      videoCaptureCommand.showTimer();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.VideoCapture,
        VideoCaptureMode.ShowVideoTimer,
        0,
        0,
      );
    });

    it("should return true", () => {
      expect(videoCaptureCommand.showTimer()).toBe(true);
    });
  });

  describe("hideTimer", () => {
    it("should send VideoCapture with HideVideoTimer mode", () => {
      videoCaptureCommand.hideTimer();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.VideoCapture,
        VideoCaptureMode.HideVideoTimer,
        0,
        0,
      );
    });

    it("should return true", () => {
      expect(videoCaptureCommand.hideTimer()).toBe(true);
    });
  });

  describe("return values", () => {
    it("all methods should return true", () => {
      expect(videoCaptureCommand.screenshot()).toBe(true);
      expect(videoCaptureCommand.start()).toBe(true);
      expect(videoCaptureCommand.stop()).toBe(true);
      expect(videoCaptureCommand.toggle()).toBe(true);
      expect(videoCaptureCommand.showTimer()).toBe(true);
      expect(videoCaptureCommand.hideTimer()).toBe(true);
    });
  });
});
