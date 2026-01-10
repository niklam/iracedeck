import { beforeEach, describe, expect, it, vi } from "vitest";

import type { INativeSDK } from "../interfaces.js";
import { BroadcastMsg, ReplayPosMode, ReplaySearchMode, ReplayStateMode } from "./constants.js";
import { ReplayCommand } from "./ReplayCommand.js";

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

describe("ReplayCommand", () => {
  let mockNative: INativeSDK;
  let replayCommand: ReplayCommand;

  beforeEach(() => {
    mockNative = createMockNative();
    replayCommand = new ReplayCommand(mockNative);
  });

  describe("setPlaySpeed", () => {
    it("should send ReplaySetPlaySpeed with speed and slowMotion=0", () => {
      replayCommand.setPlaySpeed(1);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySetPlaySpeed, 1, 0, 0);
    });

    it("should send slowMotion=1 when enabled", () => {
      replayCommand.setPlaySpeed(1, true);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySetPlaySpeed, 1, 1, 0);
    });

    it("should handle negative speeds for reverse", () => {
      replayCommand.setPlaySpeed(-2);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySetPlaySpeed, -2, 0, 0);
    });

    it("should handle zero speed for pause", () => {
      replayCommand.setPlaySpeed(0);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySetPlaySpeed, 0, 0, 0);
    });

    it("should return true", () => {
      expect(replayCommand.setPlaySpeed(1)).toBe(true);
    });
  });

  describe("setPlayPosition", () => {
    it("should send ReplaySetPlayPosition with mode and split frame number", () => {
      // Frame 100: high = 0, low = 100
      replayCommand.setPlayPosition(ReplayPosMode.Begin, 100);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.ReplaySetPlayPosition,
        ReplayPosMode.Begin,
        100,
        0,
      );
    });

    it("should correctly split large frame numbers into high/low", () => {
      // Frame 70000: 70000 = 0x00011170
      // low = 0x1170 = 4464, high = 0x0001 = 1
      const frame = 70000;
      const frameLow = frame & 0xffff;
      const frameHigh = (frame >> 16) & 0xffff;

      replayCommand.setPlayPosition(ReplayPosMode.Current, frame);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.ReplaySetPlayPosition,
        ReplayPosMode.Current,
        frameLow,
        frameHigh,
      );
    });

    it("should handle End position mode", () => {
      replayCommand.setPlayPosition(ReplayPosMode.End, 0);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySetPlayPosition, ReplayPosMode.End, 0, 0);
    });

    it("should return true", () => {
      expect(replayCommand.setPlayPosition(ReplayPosMode.Begin, 0)).toBe(true);
    });
  });

  describe("search", () => {
    it("should send ReplaySearch with mode", () => {
      replayCommand.search(ReplaySearchMode.ToStart);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySearch, ReplaySearchMode.ToStart, 0, 0);
    });

    it("should handle all search modes", () => {
      const modes = [
        ReplaySearchMode.ToStart,
        ReplaySearchMode.ToEnd,
        ReplaySearchMode.PrevSession,
        ReplaySearchMode.NextSession,
        ReplaySearchMode.PrevLap,
        ReplaySearchMode.NextLap,
        ReplaySearchMode.PrevFrame,
        ReplaySearchMode.NextFrame,
        ReplaySearchMode.PrevIncident,
        ReplaySearchMode.NextIncident,
      ];

      modes.forEach((mode) => {
        vi.mocked(mockNative.broadcastMsg).mockClear();
        replayCommand.search(mode);

        expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySearch, mode, 0, 0);
      });
    });

    it("should return true", () => {
      expect(replayCommand.search(ReplaySearchMode.ToStart)).toBe(true);
    });
  });

  describe("setState", () => {
    it("should send ReplaySetState with mode", () => {
      replayCommand.setState(ReplayStateMode.EraseTape);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.ReplaySetState,
        ReplayStateMode.EraseTape,
        0,
        0,
      );
    });

    it("should return true", () => {
      expect(replayCommand.setState(ReplayStateMode.EraseTape)).toBe(true);
    });
  });

  describe("searchSessionTime", () => {
    it("should send ReplaySearchSessionTime with session and split time", () => {
      replayCommand.searchSessionTime(0, 5000);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySearchSessionTime, 0, 5000, 0);
    });

    it("should correctly split large time values into high/low", () => {
      // Time 100000ms: 100000 = 0x000186A0
      // low = 0x86A0 = 34464, high = 0x0001 = 1
      const timeMs = 100000;
      const timeLow = timeMs & 0xffff;
      const timeHigh = (timeMs >> 16) & 0xffff;

      replayCommand.searchSessionTime(2, timeMs);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySearchSessionTime, 2, timeLow, timeHigh);
    });

    it("should return true", () => {
      expect(replayCommand.searchSessionTime(0, 0)).toBe(true);
    });
  });

  // Convenience methods
  describe("play", () => {
    it("should call setPlaySpeed with 1", () => {
      replayCommand.play();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySetPlaySpeed, 1, 0, 0);
    });

    it("should return true", () => {
      expect(replayCommand.play()).toBe(true);
    });
  });

  describe("pause", () => {
    it("should call setPlaySpeed with 0", () => {
      replayCommand.pause();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySetPlaySpeed, 0, 0, 0);
    });

    it("should return true", () => {
      expect(replayCommand.pause()).toBe(true);
    });
  });

  describe("fastForward", () => {
    it("should call setPlaySpeed with 2", () => {
      replayCommand.fastForward();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySetPlaySpeed, 2, 0, 0);
    });

    it("should return true", () => {
      expect(replayCommand.fastForward()).toBe(true);
    });
  });

  describe("fastForwardAt", () => {
    it("should call setPlaySpeed with specified speed", () => {
      replayCommand.fastForwardAt(4);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySetPlaySpeed, 4, 0, 0);
    });

    it("should return true", () => {
      expect(replayCommand.fastForwardAt(8)).toBe(true);
    });
  });

  describe("rewind", () => {
    it("should call setPlaySpeed with -2", () => {
      replayCommand.rewind();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySetPlaySpeed, -2, 0, 0);
    });

    it("should return true", () => {
      expect(replayCommand.rewind()).toBe(true);
    });
  });

  describe("rewindAt", () => {
    it("should call setPlaySpeed with negative speed", () => {
      replayCommand.rewindAt(4);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySetPlaySpeed, -4, 0, 0);
    });

    it("should handle already negative speed by taking absolute value", () => {
      replayCommand.rewindAt(-4);

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySetPlaySpeed, -4, 0, 0);
    });

    it("should return true", () => {
      expect(replayCommand.rewindAt(8)).toBe(true);
    });
  });

  describe("slowMotion", () => {
    it("should call setPlaySpeed with 1 and slowMotion=true", () => {
      replayCommand.slowMotion();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySetPlaySpeed, 1, 1, 0);
    });

    it("should return true", () => {
      expect(replayCommand.slowMotion()).toBe(true);
    });
  });

  describe("goToStart", () => {
    it("should call search with ToStart mode", () => {
      replayCommand.goToStart();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySearch, ReplaySearchMode.ToStart, 0, 0);
    });

    it("should return true", () => {
      expect(replayCommand.goToStart()).toBe(true);
    });
  });

  describe("goToEnd", () => {
    it("should call search with ToEnd mode", () => {
      replayCommand.goToEnd();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySearch, ReplaySearchMode.ToEnd, 0, 0);
    });

    it("should return true", () => {
      expect(replayCommand.goToEnd()).toBe(true);
    });
  });

  describe("prevSession", () => {
    it("should call search with PrevSession mode", () => {
      replayCommand.prevSession();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.ReplaySearch,
        ReplaySearchMode.PrevSession,
        0,
        0,
      );
    });

    it("should return true", () => {
      expect(replayCommand.prevSession()).toBe(true);
    });
  });

  describe("nextSession", () => {
    it("should call search with NextSession mode", () => {
      replayCommand.nextSession();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.ReplaySearch,
        ReplaySearchMode.NextSession,
        0,
        0,
      );
    });

    it("should return true", () => {
      expect(replayCommand.nextSession()).toBe(true);
    });
  });

  describe("prevLap", () => {
    it("should call search with PrevLap mode", () => {
      replayCommand.prevLap();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySearch, ReplaySearchMode.PrevLap, 0, 0);
    });

    it("should return true", () => {
      expect(replayCommand.prevLap()).toBe(true);
    });
  });

  describe("nextLap", () => {
    it("should call search with NextLap mode", () => {
      replayCommand.nextLap();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySearch, ReplaySearchMode.NextLap, 0, 0);
    });

    it("should return true", () => {
      expect(replayCommand.nextLap()).toBe(true);
    });
  });

  describe("prevFrame", () => {
    it("should call search with PrevFrame mode", () => {
      replayCommand.prevFrame();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySearch, ReplaySearchMode.PrevFrame, 0, 0);
    });

    it("should return true", () => {
      expect(replayCommand.prevFrame()).toBe(true);
    });
  });

  describe("nextFrame", () => {
    it("should call search with NextFrame mode", () => {
      replayCommand.nextFrame();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(BroadcastMsg.ReplaySearch, ReplaySearchMode.NextFrame, 0, 0);
    });

    it("should return true", () => {
      expect(replayCommand.nextFrame()).toBe(true);
    });
  });

  describe("prevIncident", () => {
    it("should call search with PrevIncident mode", () => {
      replayCommand.prevIncident();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.ReplaySearch,
        ReplaySearchMode.PrevIncident,
        0,
        0,
      );
    });

    it("should return true", () => {
      expect(replayCommand.prevIncident()).toBe(true);
    });
  });

  describe("nextIncident", () => {
    it("should call search with NextIncident mode", () => {
      replayCommand.nextIncident();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.ReplaySearch,
        ReplaySearchMode.NextIncident,
        0,
        0,
      );
    });

    it("should return true", () => {
      expect(replayCommand.nextIncident()).toBe(true);
    });
  });

  describe("eraseTape", () => {
    it("should call setState with EraseTape mode", () => {
      replayCommand.eraseTape();

      expect(mockNative.broadcastMsg).toHaveBeenCalledWith(
        BroadcastMsg.ReplaySetState,
        ReplayStateMode.EraseTape,
        0,
        0,
      );
    });

    it("should return true", () => {
      expect(replayCommand.eraseTape()).toBe(true);
    });
  });
});
