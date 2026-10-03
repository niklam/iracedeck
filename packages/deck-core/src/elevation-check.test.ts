import type { ILogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { _resetElevationCheck, createElevationCheckSubscriber, hasElevationMismatch } from "./elevation-check.js";
import { ELEVATION_WARNING_ID, ELEVATION_WARNING_MESSAGE } from "./elevation-warning.js";
import { clearWarning, setWarning } from "./pi-warnings.js";

vi.mock("./pi-warnings.js", () => ({
  setWarning: vi.fn(),
  clearWarning: vi.fn(),
}));

function createMockLogger(): ILogger {
  const logger: ILogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withLevel: () => logger,
    createScope: () => logger,
  };

  return logger;
}

describe("createElevationCheckSubscriber", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetElevationCheck();
  });

  it("does not probe while disconnected", () => {
    const getStatus = vi.fn(() => ({ mismatch: false }));
    const subscriber = createElevationCheckSubscriber({ getStatus, logger: createMockLogger() });

    subscriber(undefined, false);
    subscriber(undefined, false);

    expect(getStatus).not.toHaveBeenCalled();
  });

  it("probes once on connect and not on subsequent connected ticks", () => {
    const getStatus = vi.fn(() => ({ mismatch: false }));
    const subscriber = createElevationCheckSubscriber({ getStatus, logger: createMockLogger() });

    subscriber(undefined, true);
    subscriber(undefined, true);
    subscriber(undefined, true);

    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it("re-probes after a disconnect and reconnect", () => {
    const getStatus = vi.fn(() => ({ mismatch: false }));
    const subscriber = createElevationCheckSubscriber({ getStatus, logger: createMockLogger() });

    subscriber(undefined, true);
    subscriber(undefined, false);
    subscriber(undefined, true);

    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("logs at warn and posts the PI warning on a mismatch", () => {
    const logger = createMockLogger();
    const subscriber = createElevationCheckSubscriber({
      getStatus: () => ({ mismatch: true }),
      logger,
    });

    subscriber(undefined, true);

    expect(logger.warn).toHaveBeenCalledWith(
      "iRacing appears to run at a higher integrity level than the plugin; outbound commands will be silently dropped",
    );
    expect(logger.info).not.toHaveBeenCalled();
    expect(setWarning).toHaveBeenCalledWith(ELEVATION_WARNING_ID, "warning", ELEVATION_WARNING_MESSAGE);
    expect(clearWarning).not.toHaveBeenCalled();
  });

  it("logs the outcome at info and clears the PI warning when there is no mismatch (issue #902)", () => {
    const logger = createMockLogger();
    const subscriber = createElevationCheckSubscriber({
      getStatus: () => ({ mismatch: false }),
      logger,
    });

    subscriber(undefined, true);

    expect(logger.info).toHaveBeenCalledWith("Elevation check passed; no integrity mismatch detected");
    expect(logger.warn).not.toHaveBeenCalled();
    expect(clearWarning).toHaveBeenCalledWith(ELEVATION_WARNING_ID);
    expect(setWarning).not.toHaveBeenCalled();
  });

  it("logs the raw status at debug on both outcomes", () => {
    const mismatchLogger = createMockLogger();
    createElevationCheckSubscriber({
      getStatus: () => ({ mismatch: true, selfElevated: false }),
      logger: mismatchLogger,
    })(undefined, true);
    expect(mismatchLogger.debug).toHaveBeenCalledWith(
      `Elevation status: ${JSON.stringify({ mismatch: true, selfElevated: false })}`,
    );

    const passLogger = createMockLogger();
    createElevationCheckSubscriber({
      getStatus: () => ({ mismatch: false, selfElevated: true }),
      logger: passLogger,
    })(undefined, true);
    expect(passLogger.debug).toHaveBeenCalledWith(
      `Elevation status: ${JSON.stringify({ mismatch: false, selfElevated: true })}`,
    );
  });

  it("swallows a throwing probe, logs at warn, and leaves the PI warning untouched", () => {
    const logger = createMockLogger();
    const subscriber = createElevationCheckSubscriber({
      getStatus: () => {
        throw new Error("probe exploded");
      },
      logger,
    });

    expect(() => subscriber(undefined, true)).not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith("Elevation check failed; skipping until the next connection");
    expect(logger.debug).toHaveBeenCalledWith("Elevation check error: probe exploded");
    expect(logger.info).not.toHaveBeenCalled();
    expect(setWarning).not.toHaveBeenCalled();
    expect(clearWarning).not.toHaveBeenCalled();
  });

  it("does not re-probe on later connected ticks after a failed probe", () => {
    const getStatus = vi.fn(() => {
      throw new Error("probe exploded");
    });
    const subscriber = createElevationCheckSubscriber({ getStatus, logger: createMockLogger() });

    subscriber(undefined, true);
    subscriber(undefined, true);

    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it("re-probes on reconnect after a failed probe", () => {
    const getStatus = vi
      .fn<() => { mismatch: boolean }>()
      .mockImplementationOnce(() => {
        throw new Error("probe exploded");
      })
      .mockImplementation(() => ({ mismatch: false }));
    const subscriber = createElevationCheckSubscriber({ getStatus, logger: createMockLogger() });

    subscriber(undefined, true);
    subscriber(undefined, false);
    subscriber(undefined, true);

    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(clearWarning).toHaveBeenCalledWith(ELEVATION_WARNING_ID);
  });
});

// The focus service gates the implicit window focus on this reader (#976).
describe("hasElevationMismatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetElevationCheck();
  });

  it("is false before any probe has run", () => {
    expect(hasElevationMismatch()).toBe(false);
  });

  it("is true after a probe reports a mismatch", () => {
    createElevationCheckSubscriber({ getStatus: () => ({ mismatch: true }), logger: createMockLogger() })(
      undefined,
      true,
    );

    expect(hasElevationMismatch()).toBe(true);
  });

  it("is false after a probe passes", () => {
    createElevationCheckSubscriber({ getStatus: () => ({ mismatch: false }), logger: createMockLogger() })(
      undefined,
      true,
    );

    expect(hasElevationMismatch()).toBe(false);
  });

  it("forgets the mismatch on disconnect, before the next probe has answered", () => {
    const subscriber = createElevationCheckSubscriber({
      getStatus: () => ({ mismatch: true }),
      logger: createMockLogger(),
    });

    subscriber(undefined, true);
    subscriber(undefined, false);

    expect(hasElevationMismatch()).toBe(false);
  });

  it("tracks a reconnect at a different elevation", () => {
    const getStatus = vi
      .fn<() => { mismatch: boolean }>()
      .mockReturnValueOnce({ mismatch: true })
      .mockReturnValueOnce({ mismatch: false });
    const subscriber = createElevationCheckSubscriber({ getStatus, logger: createMockLogger() });

    subscriber(undefined, true);
    expect(hasElevationMismatch()).toBe(true);

    subscriber(undefined, false);
    subscriber(undefined, true);
    expect(hasElevationMismatch()).toBe(false);
  });

  it("is false when the probe threw, even after an earlier mismatch on another connection", () => {
    const getStatus = vi
      .fn<() => { mismatch: boolean }>()
      .mockReturnValueOnce({ mismatch: true })
      .mockImplementationOnce(() => {
        throw new Error("probe exploded");
      });
    const subscriber = createElevationCheckSubscriber({ getStatus, logger: createMockLogger() });

    subscriber(undefined, true);
    subscriber(undefined, false);
    subscriber(undefined, true);

    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(hasElevationMismatch()).toBe(false);
  });

  it("is cleared by _resetElevationCheck", () => {
    createElevationCheckSubscriber({ getStatus: () => ({ mismatch: true }), logger: createMockLogger() })(
      undefined,
      true,
    );
    _resetElevationCheck();

    expect(hasElevationMismatch()).toBe(false);
  });
});
