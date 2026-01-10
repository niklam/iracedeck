import { describe, it, expect, vi, beforeEach } from "vitest";
import { LogLevel, createConsoleLogger, consoleLogger, silentLogger, ILogger } from "./index.js";

describe("LogLevel", () => {
  it("should have correct ordering (Trace most verbose)", () => {
    expect(LogLevel.Trace).toBeLessThan(LogLevel.Debug);
    expect(LogLevel.Debug).toBeLessThan(LogLevel.Info);
    expect(LogLevel.Info).toBeLessThan(LogLevel.Warn);
    expect(LogLevel.Warn).toBeLessThan(LogLevel.Error);
    expect(LogLevel.Error).toBeLessThan(LogLevel.Silent);
  });
});

describe("createConsoleLogger", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should create a logger with default Info level", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const logger = createConsoleLogger();
    logger.debug("debug message");
    logger.info("info message");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith("info message");
  });

  it("should respect log level filtering", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const logger = createConsoleLogger(undefined, LogLevel.Warn);
    logger.debug("debug");
    logger.info("info");
    logger.warn("warn");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("warn");
  });

  it("should format messages with scope", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const logger = createConsoleLogger("MyScope");
    logger.info("test message");

    expect(infoSpy).toHaveBeenCalledWith("[MyScope] test message");
  });

  it("should chain scopes with colon separator", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const logger = createConsoleLogger("Parent").createScope("Child");
    logger.info("test");

    expect(infoSpy).toHaveBeenCalledWith("[Parent:Child] test");
  });

  it("withLevel should return new logger without mutating original", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const original = createConsoleLogger(undefined, LogLevel.Info);
    const verbose = original.withLevel(LogLevel.Debug);

    original.debug("from original");
    verbose.debug("from verbose");

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith("from verbose");
  });

  it("createScope should inherit log level", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const parent = createConsoleLogger(undefined, LogLevel.Debug);
    const child = parent.createScope("Child");
    child.debug("child debug");

    expect(debugSpy).toHaveBeenCalledWith("[Child] child debug");
  });

  it("should log trace at Trace level", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const logger = createConsoleLogger(undefined, LogLevel.Trace);
    logger.trace("trace message");

    expect(debugSpy).toHaveBeenCalledWith("trace message");
  });

  it("should log error at Error level", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = createConsoleLogger(undefined, LogLevel.Error);
    logger.error("error message");

    expect(errorSpy).toHaveBeenCalledWith("error message");
  });

  it("Silent level should suppress all messages", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = createConsoleLogger(undefined, LogLevel.Silent);
    logger.trace("trace");
    logger.debug("debug");
    logger.info("info");
    logger.warn("warn");
    logger.error("error");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("consoleLogger", () => {
  it("should be an ILogger instance", () => {
    expect(consoleLogger).toHaveProperty("trace");
    expect(consoleLogger).toHaveProperty("debug");
    expect(consoleLogger).toHaveProperty("info");
    expect(consoleLogger).toHaveProperty("warn");
    expect(consoleLogger).toHaveProperty("error");
    expect(consoleLogger).toHaveProperty("withLevel");
    expect(consoleLogger).toHaveProperty("createScope");
  });
});

describe("silentLogger", () => {
  it("should not call console methods", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    silentLogger.trace("trace");
    silentLogger.debug("debug");
    silentLogger.info("info");
    silentLogger.warn("warn");
    silentLogger.error("error");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("withLevel should return silentLogger", () => {
    expect(silentLogger.withLevel(LogLevel.Trace)).toBe(silentLogger);
  });

  it("createScope should return silentLogger", () => {
    expect(silentLogger.createScope("test")).toBe(silentLogger);
  });
});
