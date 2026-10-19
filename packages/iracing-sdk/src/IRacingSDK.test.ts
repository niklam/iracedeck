import { silentLogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { INativeSDK } from "./interfaces.js";
import { IRacingSDK } from "./IRacingSDK.js";
import { VarType } from "./types.js";

// Mock native SDK
function createMockNative(): INativeSDK {
  return {
    startup: vi.fn().mockReturnValue(true),
    shutdown: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    getHeader: vi.fn().mockReturnValue({
      ver: 1,
      status: 1,
      tickRate: 60,
      sessionInfoUpdate: 0,
      sessionInfoLen: 100,
      sessionInfoOffset: 144,
      numVars: 2,
      varHeaderOffset: 244,
      numBuf: 4,
      bufLen: 1000,
    }),
    getData: vi.fn(),
    waitForData: vi.fn(),
    getSessionInfoStr: vi.fn().mockReturnValue("WeekendInfo:\n  TrackName: Spa"),
    getVarHeaderEntry: vi.fn(),
    varNameToIndex: vi.fn().mockReturnValue(-1),
    broadcastMsg: vi.fn(),
    sendChatMessage: vi.fn().mockResolvedValue(true),
  };
}

describe("IRacingSDK", () => {
  let mockNative: INativeSDK;
  let sdk: IRacingSDK;

  beforeEach(() => {
    mockNative = createMockNative();
    sdk = new IRacingSDK(mockNative);
  });

  describe("connect", () => {
    it("should call native startup and return true on success", () => {
      // Setup mock to return var headers
      vi.mocked(mockNative.getVarHeaderEntry).mockReturnValue(null);

      const result = sdk.connect();

      expect(mockNative.startup).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it("should return false when startup fails", () => {
      vi.mocked(mockNative.startup).mockReturnValue(false);

      const result = sdk.connect();

      expect(result).toBe(false);
    });

    it("should return false when header is null", () => {
      vi.mocked(mockNative.getHeader).mockReturnValue(null);

      const result = sdk.connect();

      expect(result).toBe(false);
      expect(mockNative.shutdown).toHaveBeenCalled();
    });
  });

  describe("disconnect", () => {
    it("should call native shutdown when connected", () => {
      vi.mocked(mockNative.getVarHeaderEntry).mockReturnValue(null);
      sdk.connect();

      sdk.disconnect();

      expect(mockNative.shutdown).toHaveBeenCalled();
    });

    it("should not call shutdown if not connected", () => {
      sdk.disconnect();

      expect(mockNative.shutdown).not.toHaveBeenCalled();
    });
  });

  describe("isConnected", () => {
    it("should return false when not connected", () => {
      expect(sdk.isConnected()).toBe(false);
    });

    it("should return true when connected and native returns true", () => {
      vi.mocked(mockNative.getVarHeaderEntry).mockReturnValue(null);
      sdk.connect();

      expect(sdk.isConnected()).toBe(true);
    });

    it("should return false when native isConnected returns false", () => {
      vi.mocked(mockNative.getVarHeaderEntry).mockReturnValue(null);
      sdk.connect();
      vi.mocked(mockNative.isConnected).mockReturnValue(false);

      expect(sdk.isConnected()).toBe(false);
    });
  });

  describe("getTelemetry", () => {
    it("should return null when not connected", () => {
      expect(sdk.getTelemetry()).toBe(null);
    });

    it("should return null when waitForData returns null", () => {
      vi.mocked(mockNative.getVarHeaderEntry).mockReturnValue(null);
      sdk.connect();
      vi.mocked(mockNative.waitForData).mockReturnValue(null);

      expect(sdk.getTelemetry()).toBe(null);
    });

    it("should parse telemetry from buffer", () => {
      // Setup var headers
      vi.mocked(mockNative.getHeader).mockReturnValue({
        ver: 1,
        status: 1,
        tickRate: 60,
        sessionInfoUpdate: 0,
        sessionInfoLen: 100,
        sessionInfoOffset: 144,
        numVars: 1,
        varHeaderOffset: 244,
        numBuf: 4,
        bufLen: 1000,
      });
      vi.mocked(mockNative.getVarHeaderEntry)
        .mockReturnValueOnce({
          type: VarType.Float,
          offset: 0,
          count: 1,
          countAsTime: false,
          name: "Speed",
          desc: "Speed m/s",
          unit: "m/s",
        })
        .mockReturnValue(null);

      sdk.connect();

      // Create buffer with float value at offset 0
      const buffer = Buffer.alloc(4);
      buffer.writeFloatLE(50.5, 0);
      vi.mocked(mockNative.waitForData).mockReturnValue(buffer);

      const telemetry = sdk.getTelemetry();

      expect(telemetry).not.toBe(null);
      expect(telemetry?.Speed).toBeCloseTo(50.5, 1);
    });
  });

  describe("getSessionInfo", () => {
    it("should return null when not connected", () => {
      expect(sdk.getSessionInfo()).toBe(null);
    });

    it("should parse YAML session info", () => {
      vi.mocked(mockNative.getVarHeaderEntry).mockReturnValue(null);
      sdk.connect();

      const sessionInfo = sdk.getSessionInfo();

      expect(sessionInfo).not.toBe(null);
      expect((sessionInfo?.WeekendInfo as Record<string, unknown>)?.TrackName).toBe("Spa");
    });

    it("should cache session info", () => {
      vi.mocked(mockNative.getVarHeaderEntry).mockReturnValue(null);
      sdk.connect();

      sdk.getSessionInfo();
      sdk.getSessionInfo();

      // getHeader called once in connect, then once per getSessionInfo call
      expect(mockNative.getSessionInfoStr).toHaveBeenCalledTimes(1);
    });

    // The Euro NASCAR car's session info repeats `Tires:` under CarSetup (#1461),
    // shaped as in a live dump: the first holds TireType, the second the corners
    const DUPLICATE_KEY_YAML = [
      "---",
      "DriverInfo:",
      " DriverCarIdx: 0",
      " Drivers:",
      " - CarIdx: 0",
      '   CarNumber: "46"',
      "CarSetup:",
      " Tires:",
      "  TireType:",
      "   TireType: Dry",
      " Tires:",
      "  LeftFront:",
      "   ColdPressure: 159 kPa",
      "...",
      "",
    ].join("\n");

    it("parses YAML that repeats a map key, keeping both sections", () => {
      vi.mocked(mockNative.getVarHeaderEntry).mockReturnValue(null);
      vi.mocked(mockNative.getSessionInfoStr).mockReturnValue(DUPLICATE_KEY_YAML);
      sdk.connect();

      const sessionInfo = sdk.getSessionInfo() as Record<string, any> | null;

      expect(sessionInfo?.DriverInfo.Drivers[0].CarNumber).toBe("46");
      expect(sessionInfo?.CarSetup.Tires.TireType.TireType).toBe("Dry");
      expect(sessionInfo?.CarSetup.Tires.LeftFront.ColdPressure).toBe("159 kPa");
    });

    it("warns about a repeated key once per connection", () => {
      const logger = { ...silentLogger, warn: vi.fn(), debug: vi.fn() };
      sdk = new IRacingSDK(mockNative, logger);
      vi.mocked(mockNative.getVarHeaderEntry).mockReturnValue(null);
      vi.mocked(mockNative.getSessionInfoStr).mockReturnValue(DUPLICATE_KEY_YAML);
      sdk.connect();
      sdk.getSessionInfo();

      const header = mockNative.getHeader();
      vi.mocked(mockNative.getHeader).mockReturnValue({ ...header!, sessionInfoUpdate: 1 });
      sdk.getSessionInfo();

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.debug).toHaveBeenCalledWith("Repeated session info keys: CarSetup.Tires");

      sdk.disconnect();
      sdk.connect();
      sdk.getSessionInfo();

      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it("parses a failed update once and logs it once, until the next update", () => {
      const logger = { ...silentLogger, error: vi.fn() };
      sdk = new IRacingSDK(mockNative, logger);
      vi.mocked(mockNative.getVarHeaderEntry).mockReturnValue(null);
      vi.mocked(mockNative.getSessionInfoStr).mockReturnValue("WeekendInfo: [unclosed");
      sdk.connect();

      expect(sdk.getSessionInfo()).toBe(null);
      expect(sdk.getSessionInfo()).toBe(null);
      expect(mockNative.getSessionInfoStr).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledTimes(1);

      const header = mockNative.getHeader();
      vi.mocked(mockNative.getHeader).mockReturnValue({ ...header!, sessionInfoUpdate: 1 });
      vi.mocked(mockNative.getSessionInfoStr).mockReturnValue("WeekendInfo:\n  TrackName: Spa");

      const sessionInfo = sdk.getSessionInfo();

      expect((sessionInfo?.WeekendInfo as Record<string, unknown>)?.TrackName).toBe("Spa");
      expect(mockNative.getSessionInfoStr).toHaveBeenCalledTimes(2);
    });

    it("drops the previous update's session info when the next update fails to parse", () => {
      vi.mocked(mockNative.getVarHeaderEntry).mockReturnValue(null);
      sdk.connect();
      expect(sdk.getSessionInfo()).not.toBe(null);

      const header = mockNative.getHeader();
      vi.mocked(mockNative.getHeader).mockReturnValue({ ...header!, sessionInfoUpdate: 1 });
      vi.mocked(mockNative.getSessionInfoStr).mockReturnValue("WeekendInfo: [unclosed");

      expect(sdk.getSessionInfo()).toBe(null);
    });

    it("retries when the native SDK returned no YAML string", () => {
      vi.mocked(mockNative.getVarHeaderEntry).mockReturnValue(null);
      vi.mocked(mockNative.getSessionInfoStr).mockReturnValueOnce("");
      sdk.connect();

      expect(sdk.getSessionInfo()).toBe(null);
      expect(sdk.getSessionInfo()).not.toBe(null);
      expect(mockNative.getSessionInfoStr).toHaveBeenCalledTimes(2);
    });
  });

  describe("getVarNames", () => {
    it("should return empty array when no vars", () => {
      vi.mocked(mockNative.getVarHeaderEntry).mockReturnValue(null);
      vi.mocked(mockNative.getHeader).mockReturnValue({
        ver: 1,
        status: 1,
        tickRate: 60,
        sessionInfoUpdate: 0,
        sessionInfoLen: 100,
        sessionInfoOffset: 144,
        numVars: 0,
        varHeaderOffset: 244,
        numBuf: 4,
        bufLen: 1000,
      });
      sdk.connect();

      expect(sdk.getVarNames()).toEqual([]);
    });

    it("should return var names after connect", () => {
      vi.mocked(mockNative.getHeader).mockReturnValue({
        ver: 1,
        status: 1,
        tickRate: 60,
        sessionInfoUpdate: 0,
        sessionInfoLen: 100,
        sessionInfoOffset: 144,
        numVars: 2,
        varHeaderOffset: 244,
        numBuf: 4,
        bufLen: 1000,
      });
      vi.mocked(mockNative.getVarHeaderEntry)
        .mockReturnValueOnce({
          type: VarType.Float,
          offset: 0,
          count: 1,
          countAsTime: false,
          name: "Speed",
          desc: "Speed",
          unit: "m/s",
        })
        .mockReturnValueOnce({
          type: VarType.Int,
          offset: 4,
          count: 1,
          countAsTime: false,
          name: "Gear",
          desc: "Gear",
          unit: "",
        })
        .mockReturnValue(null);

      sdk.connect();

      expect(sdk.getVarNames()).toEqual(["Speed", "Gear"]);
    });
  });
});
