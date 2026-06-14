import { LogLevel } from "@iracedeck/logger";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UlanziPlatformAdapter } from "./adapter.js";

// Live debug-logging toggle (issue #609): the adapter holds a shared mutable
// level that loggers created via createLogger read on every call, so flipping it
// affects already-created loggers without recreating them.
describe("UlanziPlatformAdapter log level", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to info — debug messages are suppressed", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const adapter = new UlanziPlatformAdapter();
    const logger = adapter.createLogger("Scope");
    logger.debug("hidden");

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("setLogLevel affects loggers created before the change", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const adapter = new UlanziPlatformAdapter();
    const logger = adapter.createLogger("Scope");

    logger.debug("before");
    expect(debugSpy).not.toHaveBeenCalled();

    adapter.setLogLevel(LogLevel.Debug);
    logger.debug("after");
    expect(debugSpy).toHaveBeenCalledWith("[Scope] after");

    adapter.setLogLevel(LogLevel.Info);
    logger.debug("disabled-again");
    expect(debugSpy).toHaveBeenCalledTimes(1);
  });
});
