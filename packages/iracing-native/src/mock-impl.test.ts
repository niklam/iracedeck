import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VarType } from "./defines.js";
import { MOCK_SNAPSHOTS } from "./mock-data/snapshots.js";
import { MOCK_VAR_HEADERS } from "./mock-data/telemetry.js";
import { IRacingNativeMock } from "./mock-impl.js";

describe("IRacingNativeMock", () => {
  let mock: IRacingNativeMock;

  beforeEach(() => {
    mock = new IRacingNativeMock();
  });

  describe("connection lifecycle", () => {
    it("should not be connected initially", () => {
      expect(mock.isConnected()).toBe(false);
    });

    it("should connect on startup", () => {
      expect(mock.startup()).toBe(true);
      expect(mock.isConnected()).toBe(true);
    });

    it("should disconnect on shutdown", () => {
      mock.startup();
      mock.shutdown();
      expect(mock.isConnected()).toBe(false);
    });

    it("should return null from data methods when not connected", () => {
      expect(mock.getHeader()).toBeNull();
      expect(mock.getData(0)).toBeNull();
      expect(mock.waitForData()).toBeNull();
      expect(mock.getSessionInfoStr()).toBeNull();
    });
  });

  describe("getHeader", () => {
    beforeEach(() => {
      mock.startup();
    });

    it("should return a valid header", () => {
      const header = mock.getHeader();
      expect(header).not.toBeNull();
      expect(header!.ver).toBe(2);
      expect(header!.numVars).toBe(MOCK_VAR_HEADERS.length);
      expect(header!.numBuf).toBe(4);
      expect(header!.bufLen).toBeGreaterThan(0);
    });

    it("should have sessionInfoUpdate > 0", () => {
      const header = mock.getHeader();
      expect(header!.sessionInfoUpdate).toBeGreaterThan(0);
    });
  });

  describe("data access", () => {
    beforeEach(() => {
      mock.startup();
    });

    it("should return a buffer from getData", () => {
      const buf = mock.getData(0);
      expect(buf).not.toBeNull();
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf!.length).toBeGreaterThan(0);
    });

    it("should return a buffer from waitForData", () => {
      const buf = mock.waitForData(16);
      expect(buf).not.toBeNull();
      expect(buf).toBeInstanceOf(Buffer);
    });

    it("should return session info YAML string", () => {
      const info = mock.getSessionInfoStr();
      expect(info).not.toBeNull();
      expect(info).toContain("WeekendInfo");
      expect(info).toContain("Spa");
      expect(info).toContain("DriverInfo");
    });
  });

  describe("var headers", () => {
    it("should return var headers by index", () => {
      const header = mock.getVarHeaderEntry(0);
      expect(header).not.toBeNull();
      expect(header!.name).toBeDefined();
      expect(header!.type).toBeDefined();
      expect(typeof header!.offset).toBe("number");
    });

    it("should return null for out-of-range index", () => {
      expect(mock.getVarHeaderEntry(-1)).toBeNull();
      expect(mock.getVarHeaderEntry(9999)).toBeNull();
    });

    it("should resolve variable names to indices", () => {
      const speedIndex = mock.varNameToIndex("Speed");
      expect(speedIndex).toBeGreaterThanOrEqual(0);

      const header = mock.getVarHeaderEntry(speedIndex);
      expect(header!.name).toBe("Speed");
      expect(header!.type).toBe(VarType.Float);
    });

    it("should return -1 for unknown variable names", () => {
      expect(mock.varNameToIndex("NonExistentVar")).toBe(-1);
    });
  });

  describe("no-op methods", () => {
    beforeEach(() => {
      vi.spyOn(console, "debug").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("broadcastMsg should log and not throw", () => {
      expect(() => mock.broadcastMsg(0, 1, 2, 3)).not.toThrow();
      expect(console.debug).toHaveBeenCalled();
    });

    it("sendChatMessage should return true", () => {
      expect(mock.sendChatMessage("test")).toBe(true);
      expect(console.debug).toHaveBeenCalled();
    });

    it("sendScanKeys should not throw", () => {
      expect(() => mock.sendScanKeys([0x1e])).not.toThrow();
      expect(console.debug).toHaveBeenCalled();
    });

    it("sendScanKeyDown should not throw", () => {
      expect(() => mock.sendScanKeyDown([0x1e])).not.toThrow();
      expect(console.debug).toHaveBeenCalled();
    });

    it("sendScanKeyUp should not throw", () => {
      expect(() => mock.sendScanKeyUp([0x1e])).not.toThrow();
      expect(console.debug).toHaveBeenCalled();
    });
  });

  describe("snapshot rotation", () => {
    it("should rotate snapshots after the configured interval", () => {
      // Use a very short rotation interval for testing
      const fastMock = new IRacingNativeMock(50);
      fastMock.startup();

      const buf1 = fastMock.waitForData();
      expect(buf1).not.toBeNull();

      // Wait for rotation
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const buf2 = fastMock.waitForData();
          expect(buf2).not.toBeNull();
          // Buffers should differ after rotation (different snapshot data)
          expect(buf1!.equals(buf2!)).toBe(false);
          resolve();
        }, 60);
      });
    });

    it("should cycle through all snapshots", () => {
      const fastMock = new IRacingNativeMock(10);
      fastMock.startup();

      const snapshots = new Set<string>();

      return new Promise<void>((resolve) => {
        const collect = () => {
          const buf = fastMock.waitForData();

          if (buf) snapshots.add(buf.toString("hex"));

          if (snapshots.size >= MOCK_SNAPSHOTS.length) {
            resolve();
          } else {
            setTimeout(collect, 15);
          }
        };
        collect();
      });
    });
  });
});
