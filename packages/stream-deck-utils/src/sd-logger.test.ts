import { LogLevel } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSDLogger, SDLoggerLike } from "./sd-logger.js";

function createMockSDLogger(): SDLoggerLike {
  const mock: SDLoggerLike = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    createScope: vi.fn(() => createMockSDLogger()),
  };

  return mock;
}

describe("createSDLogger", () => {
  let mockSDLogger: SDLoggerLike;

  beforeEach(() => {
    mockSDLogger = createMockSDLogger();
  });

  describe("log level filtering", () => {
    it("should log all levels when level is Trace", () => {
      const logger = createSDLogger(mockSDLogger, LogLevel.Trace);

      logger.trace("trace msg");
      logger.debug("debug msg");
      logger.info("info msg");
      logger.warn("warn msg");
      logger.error("error msg");

      expect(mockSDLogger.trace).toHaveBeenCalledWith("trace msg");
      expect(mockSDLogger.debug).toHaveBeenCalledWith("debug msg");
      expect(mockSDLogger.info).toHaveBeenCalledWith("info msg");
      expect(mockSDLogger.warn).toHaveBeenCalledWith("warn msg");
      expect(mockSDLogger.error).toHaveBeenCalledWith("error msg");
    });

    it("should filter trace when level is Debug", () => {
      const logger = createSDLogger(mockSDLogger, LogLevel.Debug);

      logger.trace("trace msg");
      logger.debug("debug msg");
      logger.info("info msg");
      logger.warn("warn msg");
      logger.error("error msg");

      expect(mockSDLogger.trace).not.toHaveBeenCalled();
      expect(mockSDLogger.debug).toHaveBeenCalledWith("debug msg");
      expect(mockSDLogger.info).toHaveBeenCalledWith("info msg");
      expect(mockSDLogger.warn).toHaveBeenCalledWith("warn msg");
      expect(mockSDLogger.error).toHaveBeenCalledWith("error msg");
    });

    it("should filter trace and debug when level is Info (default)", () => {
      const logger = createSDLogger(mockSDLogger);

      logger.trace("trace msg");
      logger.debug("debug msg");
      logger.info("info msg");
      logger.warn("warn msg");
      logger.error("error msg");

      expect(mockSDLogger.trace).not.toHaveBeenCalled();
      expect(mockSDLogger.debug).not.toHaveBeenCalled();
      expect(mockSDLogger.info).toHaveBeenCalledWith("info msg");
      expect(mockSDLogger.warn).toHaveBeenCalledWith("warn msg");
      expect(mockSDLogger.error).toHaveBeenCalledWith("error msg");
    });

    it("should filter trace, debug, and info when level is Warn", () => {
      const logger = createSDLogger(mockSDLogger, LogLevel.Warn);

      logger.trace("trace msg");
      logger.debug("debug msg");
      logger.info("info msg");
      logger.warn("warn msg");
      logger.error("error msg");

      expect(mockSDLogger.trace).not.toHaveBeenCalled();
      expect(mockSDLogger.debug).not.toHaveBeenCalled();
      expect(mockSDLogger.info).not.toHaveBeenCalled();
      expect(mockSDLogger.warn).toHaveBeenCalledWith("warn msg");
      expect(mockSDLogger.error).toHaveBeenCalledWith("error msg");
    });

    it("should only log errors when level is Error", () => {
      const logger = createSDLogger(mockSDLogger, LogLevel.Error);

      logger.trace("trace msg");
      logger.debug("debug msg");
      logger.info("info msg");
      logger.warn("warn msg");
      logger.error("error msg");

      expect(mockSDLogger.trace).not.toHaveBeenCalled();
      expect(mockSDLogger.debug).not.toHaveBeenCalled();
      expect(mockSDLogger.info).not.toHaveBeenCalled();
      expect(mockSDLogger.warn).not.toHaveBeenCalled();
      expect(mockSDLogger.error).toHaveBeenCalledWith("error msg");
    });
  });

  describe("withLevel", () => {
    it("should create new logger with different level", () => {
      const logger = createSDLogger(mockSDLogger, LogLevel.Error);
      const verboseLogger = logger.withLevel(LogLevel.Trace);

      // Original logger should only log errors
      logger.trace("trace1");
      logger.info("info1");
      expect(mockSDLogger.trace).not.toHaveBeenCalled();
      expect(mockSDLogger.info).not.toHaveBeenCalled();

      // New logger should log all levels
      verboseLogger.trace("trace2");
      verboseLogger.info("info2");
      expect(mockSDLogger.trace).toHaveBeenCalledWith("trace2");
      expect(mockSDLogger.info).toHaveBeenCalledWith("info2");
    });

    it("should not affect original logger", () => {
      const logger = createSDLogger(mockSDLogger, LogLevel.Info);
      logger.withLevel(LogLevel.Trace);

      logger.trace("should not log");
      expect(mockSDLogger.trace).not.toHaveBeenCalled();
    });
  });

  describe("createScope", () => {
    it("should delegate to underlying logger createScope", () => {
      const logger = createSDLogger(mockSDLogger, LogLevel.Info);

      logger.createScope("MyScope");

      expect(mockSDLogger.createScope).toHaveBeenCalledWith("MyScope");
    });

    it("should return an ILogger for the scoped logger", () => {
      const scopedMock = createMockSDLogger();
      vi.mocked(mockSDLogger.createScope).mockReturnValue(scopedMock);

      const logger = createSDLogger(mockSDLogger, LogLevel.Info);
      const scoped = logger.createScope("MyScope");

      scoped.info("scoped message");

      expect(scopedMock.info).toHaveBeenCalledWith("scoped message");
    });

    it("should preserve log level in scoped logger", () => {
      const scopedMock = createMockSDLogger();
      vi.mocked(mockSDLogger.createScope).mockReturnValue(scopedMock);

      const logger = createSDLogger(mockSDLogger, LogLevel.Warn);
      const scoped = logger.createScope("MyScope");

      scoped.info("should not log");
      scoped.warn("should log");

      expect(scopedMock.info).not.toHaveBeenCalled();
      expect(scopedMock.warn).toHaveBeenCalledWith("should log");
    });
  });

  describe("ILogger interface compliance", () => {
    it("should implement all ILogger methods", () => {
      const logger = createSDLogger(mockSDLogger);

      expect(typeof logger.trace).toBe("function");
      expect(typeof logger.debug).toBe("function");
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
      expect(typeof logger.withLevel).toBe("function");
      expect(typeof logger.createScope).toBe("function");
    });
  });
});
