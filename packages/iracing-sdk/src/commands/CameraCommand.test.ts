import { beforeEach, describe, expect, it, vi } from "vitest";

import type { INativeSDK } from "../interfaces.js";
import { CameraState } from "../types.js";
import { CameraCommand } from "./CameraCommand.js";
import { BroadcastMsg, CameraFocusMode } from "./constants.js";

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

describe("CameraCommand", () => {
  let mockNative: INativeSDK;
  let cameraCommand: CameraCommand;

  beforeEach(() => {
    mockNative = createMockNative();
    cameraCommand = new CameraCommand(mockNative);
  });

  describe("switchPos", () => {
    it("should send CamSwitchPos with position, group, and camera", () => {
      cameraCommand.switchPos(1, 2, 3);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.CamSwitchPos, 1, 2, 3);
    });

    it("should accept CameraFocusMode for position", () => {
      cameraCommand.switchPos(CameraFocusMode.FocusAtLeader, 5, 0);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.CamSwitchPos,
        CameraFocusMode.FocusAtLeader,
        5,
        0,
      );
    });

    it("should return true", () => {
      expect(cameraCommand.switchPos(1, 1, 1)).toBe(true);
    });
  });

  describe("switchNum", () => {
    it("should send CamSwitchNum with car number, group, and camera", () => {
      cameraCommand.switchNum(42, 3, 1);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.CamSwitchNum, 42, 3, 1);
    });

    it("should accept CameraFocusMode for car number", () => {
      cameraCommand.switchNum(CameraFocusMode.FocusAtIncident, 2, 0);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.CamSwitchNum,
        CameraFocusMode.FocusAtIncident,
        2,
        0,
      );
    });

    it("should return true", () => {
      expect(cameraCommand.switchNum(1, 1, 1)).toBe(true);
    });
  });

  describe("setState", () => {
    it("should send CamSetState with state value", () => {
      cameraCommand.setState(0x0001);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.CamSetState, 0x0001, 0, 0);
    });

    it("should accept combined state flags", () => {
      const combinedState = CameraState.UIHidden | CameraState.UseAutoShotSelection;
      cameraCommand.setState(combinedState);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.CamSetState, combinedState, 0, 0);
    });

    it("should return true", () => {
      expect(cameraCommand.setState(0)).toBe(true);
    });
  });

  describe("hideUI", () => {
    it("should add UIHidden flag to current state", () => {
      cameraCommand.hideUI(0);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.CamSetState, CameraState.UIHidden, 0, 0);
    });

    it("should preserve existing flags when adding UIHidden", () => {
      const existingState = CameraState.UseAutoShotSelection;
      cameraCommand.hideUI(existingState);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.CamSetState,
        existingState | CameraState.UIHidden,
        0,
        0,
      );
    });

    it("should handle undefined current state", () => {
      cameraCommand.hideUI(undefined);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.CamSetState, CameraState.UIHidden, 0, 0);
    });

    it("should return true", () => {
      expect(cameraCommand.hideUI(0)).toBe(true);
    });
  });

  describe("showUI", () => {
    it("should remove UIHidden flag from current state", () => {
      const currentState = CameraState.UIHidden;
      cameraCommand.showUI(currentState);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.CamSetState, 0, 0, 0);
    });

    it("should preserve other flags when removing UIHidden", () => {
      const currentState = CameraState.UIHidden | CameraState.UseAutoShotSelection;
      cameraCommand.showUI(currentState);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.CamSetState,
        CameraState.UseAutoShotSelection,
        0,
        0,
      );
    });

    it("should handle state without UIHidden flag", () => {
      const currentState = CameraState.UseAutoShotSelection;
      cameraCommand.showUI(currentState);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.CamSetState,
        CameraState.UseAutoShotSelection,
        0,
        0,
      );
    });

    it("should handle undefined current state", () => {
      cameraCommand.showUI(undefined);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.CamSetState, 0, 0, 0);
    });

    it("should return true", () => {
      expect(cameraCommand.showUI(0)).toBe(true);
    });
  });

  describe("focusOnLeader", () => {
    it("should call switchPos with FocusAtLeader mode", () => {
      cameraCommand.focusOnLeader(5, 2);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.CamSwitchPos,
        CameraFocusMode.FocusAtLeader,
        5,
        2,
      );
    });

    it("should return true", () => {
      expect(cameraCommand.focusOnLeader(1, 0)).toBe(true);
    });
  });

  describe("focusOnIncident", () => {
    it("should call switchPos with FocusAtIncident mode", () => {
      cameraCommand.focusOnIncident(3, 1);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.CamSwitchPos,
        CameraFocusMode.FocusAtIncident,
        3,
        1,
      );
    });

    it("should return true", () => {
      expect(cameraCommand.focusOnIncident(1, 0)).toBe(true);
    });
  });

  describe("focusOnExiting", () => {
    it("should call switchPos with FocusAtExiting mode", () => {
      cameraCommand.focusOnExiting(4, 0);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.CamSwitchPos,
        CameraFocusMode.FocusAtExiting,
        4,
        0,
      );
    });

    it("should return true", () => {
      expect(cameraCommand.focusOnExiting(1, 0)).toBe(true);
    });
  });

  describe("return values", () => {
    it("all methods should return true", () => {
      expect(cameraCommand.switchPos(1, 1, 1)).toBe(true);
      expect(cameraCommand.switchNum(1, 1, 1)).toBe(true);
      expect(cameraCommand.setState(0)).toBe(true);
      expect(cameraCommand.hideUI(0)).toBe(true);
      expect(cameraCommand.showUI(0)).toBe(true);
      expect(cameraCommand.focusOnLeader(1, 1)).toBe(true);
      expect(cameraCommand.focusOnIncident(1, 1)).toBe(true);
      expect(cameraCommand.focusOnExiting(1, 1)).toBe(true);
    });
  });
});
