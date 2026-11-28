import type { ILogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { INativeSDK } from "../interfaces.js";
import type { SimContextBoundary, SimContextBoundaryListener, SimContextBoundarySource } from "../SDKController.js";
import { CameraState } from "../types.js";
import {
  CameraCommand,
  DIRECTOR_FOCUS_MODES,
  endFocusAtContextBoundaries,
  isDirectorFocusMode,
} from "./CameraCommand.js";
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

  describe("focusOnMostExciting", () => {
    it("should call switchPos with FocusAtExiting mode", () => {
      cameraCommand.focusOnMostExciting(4, 0);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.CamSwitchPos,
        CameraFocusMode.FocusAtExiting,
        4,
        0,
      );
    });

    it("should return true", () => {
      expect(cameraCommand.focusOnMostExciting(1, 0)).toBe(true);
    });
  });

  describe("cycleCamera", () => {
    it("should send CamSwitchPos with incremented group for next", () => {
      cameraCommand.cycleCamera(5, 3, 1);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.CamSwitchPos, 5, 4, 0);
    });

    it("should send CamSwitchPos with decremented group for previous", () => {
      cameraCommand.cycleCamera(5, 3, -1);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.CamSwitchPos, 5, 2, 0);
    });

    it("should pass camera=0 to keep current sub-camera", () => {
      cameraCommand.cycleCamera(2, 1, 1);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.CamSwitchPos, 2, 2, 0);
    });

    it("should return true", () => {
      expect(cameraCommand.cycleCamera(1, 1, 1)).toBe(true);
    });
  });

  describe("cycleCar", () => {
    it("should send CamSwitchPos with incremented car position for next", () => {
      cameraCommand.cycleCar(5, 1);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.CamSwitchPos, 6, 0, 0);
    });

    it("should send CamSwitchPos with decremented car position for previous", () => {
      cameraCommand.cycleCar(5, -1);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.CamSwitchPos, 4, 0, 0);
    });

    it("should pass group=0 and camera=0 to keep current camera", () => {
      cameraCommand.cycleCar(3, 1);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.CamSwitchPos, 4, 0, 0);
    });

    it("should return true", () => {
      expect(cameraCommand.cycleCar(1, 1)).toBe(true);
    });
  });

  describe("cycleDrivingCamera", () => {
    it("should send CamSwitchPos with incremented group for next", () => {
      cameraCommand.cycleDrivingCamera(5, 3, 1);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.CamSwitchPos, 5, 4, 0);
    });

    it("should send CamSwitchPos with decremented group for previous", () => {
      cameraCommand.cycleDrivingCamera(5, 3, -1);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.CamSwitchPos, 5, 2, 0);
    });

    it("should behave identically to cycleCamera", () => {
      cameraCommand.cycleCamera(10, 5, 1);
      const cameraCycleArgs = (mockNative.broadcastMsg as ReturnType<typeof vi.fn>).mock.calls[0];

      (mockNative.broadcastMsg as ReturnType<typeof vi.fn>).mockClear();

      cameraCommand.cycleDrivingCamera(10, 5, 1);
      const drivingCycleArgs = (mockNative.broadcastMsg as ReturnType<typeof vi.fn>).mock.calls[0];

      expect(drivingCycleArgs).toEqual(cameraCycleArgs);
    });

    it("should return true", () => {
      expect(cameraCommand.cycleDrivingCamera(1, 1, 1)).toBe(true);
    });
  });

  describe("the director focus in effect (#1656)", () => {
    const { FocusAtIncident, FocusAtLeader, FocusAtExiting, FocusAtDriver } = CameraFocusMode;

    it("is none at construction, as at a plugin start", () => {
      expect(cameraCommand.focusModeInEffect()).toBeNull();
      // A second instance starts empty too, whatever the first holds.
      cameraCommand.focusOnMostExciting(1, 0);
      expect(new CameraCommand(mockNative).focusModeInEffect()).toBeNull();
    });

    it("is set by each focus helper to its own mode", () => {
      cameraCommand.focusOnLeader(1, 0);
      expect(cameraCommand.focusModeInEffect()).toBe(FocusAtLeader);

      cameraCommand.focusOnIncident(1, 0);
      expect(cameraCommand.focusModeInEffect()).toBe(FocusAtIncident);

      cameraCommand.focusOnMostExciting(1, 0);
      expect(cameraCommand.focusModeInEffect()).toBe(FocusAtExiting);
    });

    it.each([
      ["switchPos", (target: number) => cameraCommand.switchPos(target, 15, 0)],
      ["switchNum", (target: number) => cameraCommand.switchNum(target, 15, 0)],
    ])("is set by a %s whose target is a director focus", (_name, send) => {
      for (const mode of DIRECTOR_FOCUS_MODES) {
        send(mode);
        expect(cameraCommand.focusModeInEffect()).toBe(mode);
      }
    });

    it("a later focus replaces the one before", () => {
      cameraCommand.focusOnMostExciting(1, 0);
      cameraCommand.switchPos(FocusAtLeader, 16, 0);

      expect(cameraCommand.focusModeInEffect()).toBe(FocusAtLeader);
    });

    it("a group-only switch that keeps the focus target keeps the mode", () => {
      cameraCommand.focusOnMostExciting(14, 0);
      cameraCommand.switchPos(FocusAtExiting, 16, 0);

      expect(cameraCommand.focusModeInEffect()).toBe(FocusAtExiting);
    });

    it.each([
      ["switchNum to a car number (what pinned the camera on the sim)", () => cameraCommand.switchNum(9, 15, 0)],
      ["switchPos to a position", () => cameraCommand.switchPos(3, 15, 0)],
      ["switchPos to FocusAtDriver", () => cameraCommand.switchPos(FocusAtDriver, 15, 0)],
      ["switchNum to car number 0", () => cameraCommand.switchNum(0, 15, 0)],
      ["cycleCamera (targets the camera's car)", () => cameraCommand.cycleCamera(8, 15, 1)],
      ["cycleDrivingCamera (targets the camera's car)", () => cameraCommand.cycleDrivingCamera(8, 15, 1)],
      ["cycleCar", () => cameraCommand.cycleCar(8, 1)],
      ["a Next / Previous Car key tap", () => cameraCommand.forgetFocusMode()],
    ])("is cleared by %s", (_name, pick) => {
      cameraCommand.focusOnMostExciting(14, 0);
      expect(cameraCommand.focusModeInEffect()).toBe(FocusAtExiting);

      pick();

      expect(cameraCommand.focusModeInEffect()).toBeNull();
    });

    it("a focus after a car switch is in effect again", () => {
      cameraCommand.focusOnLeader(14, 0);
      cameraCommand.switchNum(9, 15, 0);
      cameraCommand.focusOnIncident(15, 0);

      expect(cameraCommand.focusModeInEffect()).toBe(FocusAtIncident);
    });

    it("is untouched by the state methods, which switch nothing", () => {
      cameraCommand.focusOnMostExciting(14, 0);
      cameraCommand.setState(0);
      cameraCommand.hideUI(0);
      cameraCommand.showUI(8);

      expect(cameraCommand.focusModeInEffect()).toBe(FocusAtExiting);
    });

    it("a car switch whose send throws still clears it: the user's pick wins a doubt", () => {
      cameraCommand.focusOnMostExciting(14, 0);
      vi.mocked(mockNative.broadcastMsg).mockImplementationOnce(() => {
        throw new Error("native gone");
      });

      expect(() => cameraCommand.switchNum(9, 15, 0)).toThrow("native gone");
      expect(cameraCommand.focusModeInEffect()).toBeNull();
    });

    it("a focus switch whose send throws leaves the record as it was", () => {
      cameraCommand.focusOnLeader(14, 0);
      vi.mocked(mockNative.broadcastMsg).mockImplementationOnce(() => {
        throw new Error("native gone");
      });

      expect(() => cameraCommand.focusOnMostExciting(14, 0)).toThrow("native gone");
      expect(cameraCommand.focusModeInEffect()).toBe(FocusAtLeader);
    });

    it("forgetFocusMode sends nothing", () => {
      cameraCommand.forgetFocusMode();

      expect(mockNative.broadcastMsg).not.toHaveBeenCalled();
    });

    describe("ends at every context boundary the controller reports", () => {
      /** A boundary source that hands its one listener to the test, and a camera wired to it with a logger that records the debug lines. */
      function wired(): {
        camera: CameraCommand;
        cross: (boundary: SimContextBoundary) => void;
        debug: string[];
        remove: () => void;
        listeners: () => number;
      } {
        const debug: string[] = [];
        const logger: ILogger = {
          trace: vi.fn(),
          debug: (message: string) => debug.push(message),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          withLevel: () => logger,
          createScope: () => logger,
        };
        const registered = new Set<SimContextBoundaryListener>();
        const source: SimContextBoundarySource = {
          onContextBoundary: (listener) => {
            registered.add(listener);

            return () => registered.delete(listener);
          },
        };
        const camera = new CameraCommand(mockNative, logger);
        const remove = endFocusAtContextBoundaries(camera, source);

        return {
          camera,
          cross: (boundary) => registered.forEach((listener) => listener(boundary)),
          debug,
          remove,
          listeners: () => registered.size,
        };
      }

      it.each([
        ["connection-lost", "the connection to iRacing was lost"],
        ["session-changed", "the session changed"],
        ["replay-entered", "a replay was entered"],
        ["replay-left", "the replay was left"],
      ] as const)("%s clears it, logged with its own reason and sending nothing", (boundary, reason) => {
        const { camera, cross, debug } = wired();
        camera.focusOnMostExciting(14, 0);
        vi.mocked(mockNative.broadcastMsg).mockClear();
        debug.length = 0;

        cross(boundary);

        expect(camera.focusModeInEffect()).toBeNull();
        expect(mockNative.broadcastMsg).not.toHaveBeenCalled();
        expect(debug).toHaveLength(1);
        expect(debug[0]).toContain("FocusAtExiting -> none");
        expect(debug[0]).toContain(`(${reason}`);
      });

      it("a boundary with no focus in effect logs nothing", () => {
        const { cross, debug } = wired();

        cross("connection-lost");

        expect(debug).toEqual([]);
      });

      it("a focus set after the boundary is in effect again", () => {
        const { camera, cross } = wired();
        camera.focusOnLeader(14, 0);
        cross("session-changed");

        camera.focusOnIncident(14, 0);

        expect(camera.focusModeInEffect()).toBe(FocusAtIncident);
      });

      it("returns the function that removes its listener", () => {
        const { camera, cross, remove, listeners } = wired();
        expect(listeners()).toBe(1);

        remove();
        camera.focusOnLeader(14, 0);
        cross("connection-lost");

        expect(listeners()).toBe(0);
        expect(camera.focusModeInEffect()).toBe(FocusAtLeader);
      });

      it("adds no public method to the class", () => {
        const names = Object.getOwnPropertyNames(CameraCommand.prototype);

        expect(names.filter((name) => /boundary/i.test(name))).toEqual([]);
      });
    });

    it("names exactly the three director focus modes", () => {
      expect([...DIRECTOR_FOCUS_MODES].sort()).toEqual([FocusAtIncident, FocusAtLeader, FocusAtExiting].sort());
      expect(isDirectorFocusMode(FocusAtDriver)).toBe(false);
      expect(isDirectorFocusMode(1)).toBe(false);
      expect(isDirectorFocusMode(-4)).toBe(false);
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
      expect(cameraCommand.focusOnMostExciting(1, 1)).toBe(true);
      expect(cameraCommand.cycleCamera(1, 1, 1)).toBe(true);
      expect(cameraCommand.cycleCar(1, 1)).toBe(true);
      expect(cameraCommand.cycleDrivingCamera(1, 1, 1)).toBe(true);
    });
  });
});
