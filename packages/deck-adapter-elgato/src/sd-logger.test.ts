import { LogLevel } from "@iracedeck/logger";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createLogWriteFailures, createSDLogger, SDLoggerLike } from "./sd-logger.js";

describe("the SDK level ranking the guard mirrors (#1630)", () => {
  const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const ownRequire = createRequire(join(packageDir, "package.json"));
  const sdkPackageJson = join(packageDir, "node_modules", "@elgato", "streamdeck", "package.json");
  const sdkRequire = createRequire(sdkPackageJson);

  function dependencies(file: string): Record<string, string> {
    return (JSON.parse(readFileSync(file, "utf8")) as { dependencies: Record<string, string> }).dependencies;
  }

  it("pins the same @elgato/utils as @elgato/streamdeck", () => {
    // `createSDLogger` ranks levels with `defcon` from its own `@elgato/utils`,
    // while the SDK's `Logger.write` gates with its own copy. A bump of one pin
    // without the other installs two copies, and the mirror can drift from the
    // gate it mirrors. Move both together.
    expect(dependencies(join(packageDir, "package.json"))["@elgato/utils"]).toBe(
      dependencies(sdkPackageJson)["@elgato/utils"],
    );
  });

  it("resolves to the very copy the SDK's logger uses", () => {
    expect(realpathSync(ownRequire.resolve("@elgato/utils/logging"))).toBe(
      realpathSync(sdkRequire.resolve("@elgato/utils/logging")),
    );
  });
});

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

    it("should filter trace when level is Debug (default)", () => {
      const logger = createSDLogger(mockSDLogger);

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

  describe("failed writes (#1630)", () => {
    const LEVELS = ["trace", "debug", "info", "warn", "error"] as const;

    function enospc(): Error {
      return Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    }

    /**
     * An SD-logger double shaped like the SDK's `Logger` over a `FileTarget`:
     * a line below `state.level` is dropped before any write, as `Logger.write`
     * does; any other line throws while `state.failing` is set, else is
     * recorded on `lines`. Scopes share the list, the level and the switch, as
     * the SDK's scopes share one target.
     */
    function createFileDouble(
      state: { failing: boolean; error?: () => unknown; level?: string },
      lines: string[] = [],
      scope = "root",
    ): SDLoggerLike & { lines: string[] } {
      const order = ["error", "warn", "info", "debug", "trace"];
      const writer = (lvl: string) =>
        vi.fn((msg: string) => {
          if (state.level !== undefined && order.indexOf(lvl) > order.indexOf(state.level)) return;

          if (state.failing) throw (state.error ?? enospc)();

          lines.push(`${lvl.toUpperCase()} ${scope}: ${msg}`);
        });

      return {
        get level() {
          return state.level;
        },
        lines,
        trace: writer("trace"),
        debug: writer("debug"),
        info: writer("info"),
        warn: writer("warn"),
        error: writer("error"),
        createScope: vi.fn((name: string) => createFileDouble(state, lines, name)),
      };
    }

    it("never throws through the wrapper, at any level", () => {
      const state = { failing: true };
      const logger = createSDLogger(createFileDouble(state), LogLevel.Trace);

      for (const lvl of LEVELS) expect(() => logger[lvl](`${lvl} line`)).not.toThrow();
    });

    it("never throws through createScope or withLevel", () => {
      const state = { failing: true };
      const logger = createSDLogger(createFileDouble(state), LogLevel.Info);
      const scoped = logger.createScope("Replay");
      const verbose = scoped.withLevel(LogLevel.Trace);

      for (const lvl of LEVELS) {
        expect(() => scoped[lvl]("x")).not.toThrow();
        expect(() => verbose[lvl]("x")).not.toThrow();
      }
    });

    it("never throws for a non-Error throw", () => {
      const state = { failing: true, error: () => "disk gone" };
      const logger = createSDLogger(createFileDouble(state));

      expect(() => logger.info("x")).not.toThrow();
    });

    it("writes one notice with the count across scopes, before the recovering line", () => {
      const state = { failing: true };
      const root = createFileDouble(state);
      const logger = createSDLogger(root);
      const replay = logger.createScope("Replay");
      const startup = logger.createScope("Startup");

      replay.error("save failed 1");
      startup.info("phase 1");
      replay.error("save failed 2");

      state.failing = false;
      startup.info("phase 2");
      startup.info("phase 3");

      expect(root.lines).toEqual([
        "WARN Startup: Log writes failed; 3 lines were dropped (first failure: ENOSPC)",
        "INFO Startup: phase 2",
        "INFO Startup: phase 3",
      ]);
    });

    it("shares the count with a withLevel logger", () => {
      const state = { failing: true };
      const root = createFileDouble(state);
      const logger = createSDLogger(root, LogLevel.Info);

      logger.withLevel(LogLevel.Trace).trace("lost");
      state.failing = false;
      logger.info("back");

      expect(root.lines).toEqual([
        "WARN root: Log writes failed; 1 line was dropped (first failure: ENOSPC)",
        "INFO root: back",
      ]);
    });

    it("keeps the first failure's reason, not a later one's", () => {
      const state: { failing: boolean; error: () => unknown } = { failing: true, error: enospc };
      const root = createFileDouble(state);
      const logger = createSDLogger(root);

      logger.info("a");
      state.error = () => Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      logger.info("b");
      state.failing = false;
      logger.info("c");

      expect(root.lines[0]).toBe("WARN root: Log writes failed; 2 lines were dropped (first failure: ENOSPC)");
    });

    it("names the error's message when it has no code, and the value when it is no Error", () => {
      const state: { failing: boolean; error: () => unknown } = {
        failing: true,
        error: () => new Error("target closed"),
      };
      const root = createFileDouble(state);
      const logger = createSDLogger(root);

      logger.info("a");
      state.failing = false;
      logger.info("b");
      state.failing = true;
      state.error = () => 42;
      logger.info("c");
      state.failing = false;
      logger.info("d");

      expect(root.lines).toEqual([
        "WARN root: Log writes failed; 1 line was dropped (first failure: target closed)",
        "INFO root: b",
        "WARN root: Log writes failed; 1 line was dropped (first failure: 42)",
        "INFO root: d",
      ]);
    });

    it("does not count a line the wrapper's level gate filters out", () => {
      const state = { failing: true };
      const root = createFileDouble(state);
      const logger = createSDLogger(root, LogLevel.Info);

      logger.info("lost");
      logger.debug("filtered");
      logger.trace("filtered");
      state.failing = false;
      logger.info("back");

      expect(root.lines[0]).toBe("WARN root: Log writes failed; 1 line was dropped (first failure: ENOSPC)");
      expect(root.debug).not.toHaveBeenCalled();
      expect(root.trace).not.toHaveBeenCalled();
    });

    it("retries a failed notice on the next call, counting the line it held back", () => {
      const state = { failing: true };
      const root = createFileDouble(state);
      const logger = createSDLogger(root);

      logger.info("a");
      logger.info("b");

      // The second call attempted the notice, which failed, so "b" was never sent.
      expect(root.warn).toHaveBeenCalledTimes(1);
      expect(root.info).toHaveBeenCalledTimes(1);

      state.failing = false;
      logger.info("c");

      expect(root.lines).toEqual([
        "WARN root: Log writes failed; 2 lines were dropped (first failure: ENOSPC)",
        "INFO root: c",
      ]);
    });

    it("neither attempts the notice nor counts a line the SDK's own level filters", () => {
      const state = { failing: true, level: "info" };
      const root = createFileDouble(state);
      const logger = createSDLogger(root);

      logger.info("lost");
      logger.debug("not written by the SDK");
      logger.debug("not written by the SDK either");

      expect(root.warn).not.toHaveBeenCalled();

      state.failing = false;
      logger.info("back");

      expect(root.lines).toEqual([
        "WARN root: Log writes failed; 1 line was dropped (first failure: ENOSPC)",
        "INFO root: back",
      ]);
    });

    it("holds the notice while the SDK filters warnings, and writes it once they pass", () => {
      const state = { failing: true, level: "error" };
      const root = createFileDouble(state);
      const logger = createSDLogger(root);

      logger.error("lost");
      state.failing = false;
      logger.error("back at error level");

      expect(root.warn).not.toHaveBeenCalled();
      expect(root.lines).toEqual(["ERROR root: back at error level"]);

      state.level = "info";
      logger.info("level raised");

      expect(root.lines.slice(1)).toEqual([
        "WARN root: Log writes failed; 1 line was dropped (first failure: ENOSPC)",
        "INFO root: level raised",
      ]);
    });

    it("writes nothing extra when no write ever failed", () => {
      const root = createFileDouble({ failing: false });
      const logger = createSDLogger(root);

      logger.info("a");
      logger.createScope("S").warn("b");

      expect(root.lines).toEqual(["INFO root: a", "WARN S: b"]);
    });

    it("keeps separate counts for separate roots", () => {
      const state = { failing: true };
      const rootA = createFileDouble(state);
      const rootB = createFileDouble(state, []);
      const a = createSDLogger(rootA, LogLevel.Debug, createLogWriteFailures());
      const b = createSDLogger(rootB);

      a.info("lost");
      state.failing = false;
      b.info("b");

      expect(rootB.lines).toEqual(["INFO root: b"]);
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
