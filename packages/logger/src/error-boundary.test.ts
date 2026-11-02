import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ERROR_REPORT_WINDOW_MS, type ErrorPolicy } from "./bounded-error-reporter.js";
import { createErrorBoundary, type ErrorBoundaryOptions, type HeldError, throwHeld } from "./error-boundary.js";
import type { ILogger } from "./index.js";

type Level = "trace" | "debug" | "info" | "warn" | "error";

interface Line {
  level: Level;
  message: string;
}

function recordingLogger(): { logger: ILogger; lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: Level) =>
    (message: string): void => {
      lines.push({ level, message });
    };
  const logger: ILogger = {
    trace: at("trace"),
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    withLevel: () => logger,
    createScope: () => logger,
  };

  return { logger, lines };
}

function setup(overrides: Partial<ErrorBoundaryOptions> = {}) {
  const { logger, lines } = recordingLogger();
  let time = 1_000_000;
  const boundary = createErrorBoundary({ logger, now: () => time, ...overrides });

  return {
    boundary,
    lines,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const WINDOW = DEFAULT_ERROR_REPORT_WINDOW_MS;

/** The callbacks `a`..`d`, where `b` and `d` throw while `armed` says so, recording the order they ran in. */
function fourCallbacks(armed: () => boolean = () => true) {
  const calls: string[] = [];
  const errors = { b: new Error("b failed"), d: new Error("d failed") };
  const callback =
    (name: string, error?: Error): (() => void) =>
    () => {
      calls.push(name);

      if (error !== undefined && armed()) throw error;
    };
  const callbacks = new Map<string, () => void>([
    ["a", callback("a")],
    ["b", callback("b", errors.b)],
    ["c", callback("c")],
    ["d", callback("d", errors.d)],
  ]);

  return { calls, errors, callbacks };
}

const invoke = (callback: () => void): void => callback();

describe("createErrorBoundary", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("policy", () => {
    it('defaults to "report"', () => {
      expect(setup().boundary.policy).toBe("report");
    });

    it('keeps "rethrow"', () => {
      expect(setup({ policy: "rethrow" }).boundary.policy).toBe("rethrow");
    });

    it('treats anything but "rethrow" as "report", so an unchecked option cannot turn reporting off', () => {
      const { boundary, lines } = setup({ policy: "silence" as ErrorPolicy });

      expect(boundary.policy).toBe("report");
      expect(
        boundary.call("x", () => {
          throw new Error("boom");
        }),
      ).toBeUndefined();
      expect(lines.map((line) => line.level)).toEqual(["error"]);
    });
  });

  describe("call", () => {
    it("returns undefined for a clean call and ignores the callback's return value", () => {
      const { boundary, lines } = setup({ policy: "rethrow" });

      // A callback typed `() => void` may still return something at runtime.
      expect(boundary.call("x", () => 42 as unknown as void)).toBeUndefined();
      expect(lines).toEqual([]);
    });

    it('under "report", reports a throw under the id, returns undefined and throws nothing', () => {
      const { boundary, lines } = setup();
      let held: HeldError = { error: "sentinel" };

      expect(() => {
        held = boundary.call("sub", () => {
          throw new Error("sub failed");
        });
      }).not.toThrow();

      expect(held).toBeUndefined();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: "error" });
      expect(lines[0]!.message).toMatch(/^sub threw: Error: sub failed\n\s+at /);
    });

    it("tells the reporter about clean calls, so a quiet window after a throw declares recovery", () => {
      const { boundary, lines, advance } = setup();

      boundary.call("sub", () => {
        throw new Error("sub failed");
      });
      advance(WINDOW);
      boundary.call("sub", () => {});

      expect(lines.map((line) => line.level)).toEqual(["error", "info"]);
      expect(lines[1]!.message).toBe("sub recovered: no errors for 60s, after 1 time in all");
    });

    it('under "rethrow", holds the very error thrown and reports nothing', () => {
      const { boundary, lines } = setup({ policy: "rethrow" });
      const error = new Error("sub failed");

      const held = boundary.call("sub", () => {
        throw error;
      });

      expect(held).toEqual({ error });
      expect(held!.error).toBe(error);
      expect(lines).toEqual([]);
    });

    it('under "rethrow", holds a thrown undefined, which the wrapper keeps apart from "nothing threw"', () => {
      const { boundary } = setup({ policy: "rethrow" });

      const held = boundary.call("sub", () => {
        throw undefined;
      });

      expect(held).toEqual({ error: undefined });
      expect(() => throwHeld(held)).toThrow();
    });
  });

  describe("callEach", () => {
    it('under "report", calls every callback in order, reports each throw under its own id, and holds nothing', () => {
      const { boundary, lines } = setup();
      const { calls, callbacks } = fourCallbacks();

      expect(boundary.callEach(callbacks, invoke)).toBeUndefined();

      expect(calls).toEqual(["a", "b", "c", "d"]);
      expect(lines.map((line) => line.message.split("\n")[0])).toEqual([
        "b threw: Error: b failed",
        "d threw: Error: d failed",
      ]);
    });

    it('under "rethrow", reaches every callback, then the entry point throws the first error', () => {
      const { boundary, lines } = setup({ policy: "rethrow" });
      const { calls, errors, callbacks } = fourCallbacks();

      // An entry point: the fan-out first, then throwHeld once the work is done.
      const entryPoint = (): void => throwHeld(boundary.callEach(callbacks, invoke));

      expect(entryPoint).toThrow(errors.b);
      expect(calls).toEqual(["a", "b", "c", "d"]);
      expect(lines).toEqual([]);
    });

    it("passes each callback's id to invoke", () => {
      const { boundary } = setup();
      const seen: string[] = [];

      boundary.callEach(
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
        (value, id) => {
          seen.push(`${id}=${value}`);
        },
      );

      expect(seen).toEqual(["a=1", "b=2"]);
    });

    it("holds nothing when nothing throws", () => {
      const { boundary } = setup({ policy: "rethrow" });
      const { calls, callbacks } = fourCallbacks(() => false);

      expect(boundary.callEach(callbacks, invoke)).toBeUndefined();
      expect(calls).toEqual(["a", "b", "c", "d"]);
    });
  });

  describe("run", () => {
    it("reports a throw from the work under the work's id", () => {
      const { boundary, lines } = setup();

      expect(
        boundary.run("controller:update", () => {
          throw new Error("read failed");
        }),
      ).toBeUndefined();

      expect(lines).toHaveLength(1);
      expect(lines[0]!.message).toMatch(/^controller:update threw: Error: read failed\n/);
    });

    it('under "rethrow", holds a throw from the work rather than reporting it', () => {
      const { boundary, lines } = setup({ policy: "rethrow" });
      const error = new Error("read failed");

      expect(
        boundary.run("controller:update", () => {
          throw error;
        }),
      ).toEqual({ error });
      expect(lines).toEqual([]);
    });

    it("reports a callback's throw inside the work once, under the callback's id, never under the work's", () => {
      const { boundary, lines } = setup();
      const { calls, callbacks } = fourCallbacks();

      expect(boundary.run("controller:update", () => boundary.callEach(callbacks, invoke))).toBeUndefined();

      expect(calls).toEqual(["a", "b", "c", "d"]);
      expect(lines.map((line) => line.message.split("\n")[0])).toEqual([
        "b threw: Error: b failed",
        "d threw: Error: d failed",
      ]);
    });

    it('under "rethrow", passes a held error from the work through untouched, after every callback ran', () => {
      const { boundary, lines } = setup({ policy: "rethrow" });
      const { calls, errors, callbacks } = fourCallbacks();

      const held = boundary.run("controller:update", () => boundary.callEach(callbacks, invoke));

      expect(held!.error).toBe(errors.b);
      expect(calls).toEqual(["a", "b", "c", "d"]);
      expect(() => throwHeld(held)).toThrow(errors.b);
      expect(lines).toEqual([]);
    });

    it("tells the reporter about a clean run, so the work's id recovers after a quiet window", () => {
      const { boundary, lines, advance } = setup();

      boundary.run("controller:update", () => {
        throw new Error("read failed");
      });
      advance(WINDOW);
      boundary.run("controller:update", () => undefined);

      expect(lines.map((line) => line.level)).toEqual(["error", "info"]);
      expect(lines[1]!.message).toMatch(/^controller:update recovered: /);
    });
  });

  describe("forget", () => {
    it("flushes the id's unreported count as one warn line and drops its keys", () => {
      const { boundary, lines } = setup();
      const failing = (): void => {
        throw new Error("sub failed");
      };

      boundary.call("sub", failing);
      boundary.call("sub", failing);
      boundary.call("sub", failing);
      boundary.forget("sub");

      expect(lines.map((line) => line.level)).toEqual(["error", "warn"]);
      expect(lines[1]!.message).toBe("sub forgotten with 2 times not yet reported (3 times in all)");

      // Dropped: the next throw is a first occurrence again.
      boundary.call("sub", failing);

      expect(lines.map((line) => line.level)).toEqual(["error", "warn", "error"]);
    });
  });

  describe("isRegistered", () => {
    /**
     * A dispatcher whose callbacks can unregister themselves: `registered` is its map,
     * and `unregisterThenThrow` is a callback that removes its own id (as a subscriber
     * calling `unsubscribe(ownId)` does) and then throws in the same call.
     */
    function dispatcher(overrides: Partial<ErrorBoundaryOptions> = {}) {
      const registered = new Set<string>();
      const rig = setup({ isRegistered: (id) => registered.has(id), ...overrides });
      const unregisterThenThrow =
        (id: string): (() => void) =>
        () => {
          registered.delete(id);
          throw new Error(`${id} failed`);
        };

      return { ...rig, registered, unregisterThenThrow };
    }

    /** One more id than the default 32-key cap holds. */
    const PAST_THE_CAP = 33;

    it("call: forgets an id that unregistered itself before throwing, so it holds no slot in the key cap", () => {
      const { boundary, lines, registered, unregisterThenThrow } = dispatcher();

      for (let n = 0; n < PAST_THE_CAP; n++) {
        const id = `gone-${n}`;

        registered.add(id);
        boundary.call(id, unregisterThenThrow(id));
      }

      registered.add("live");
      boundary.call("live", () => {
        throw new Error("live failed");
      });

      // Every throw kept its error line, and the live id's first error is one too, not a cap warning.
      expect(lines.map((line) => line.level)).toEqual(Array<Level>(PAST_THE_CAP + 1).fill("error"));
      expect(lines.at(-1)!.message).toMatch(/^live threw: Error: live failed/);
    });

    it("callEach: forgets an id that unregistered itself before throwing, so it holds no slot in the key cap", () => {
      const { boundary, lines, registered, unregisterThenThrow } = dispatcher();
      const callbacks = new Map<string, () => void>();

      for (let n = 0; n < PAST_THE_CAP; n++) {
        const id = `gone-${n}`;

        registered.add(id);
        callbacks.set(id, unregisterThenThrow(id));
      }

      callbacks.set("live", () => {
        throw new Error("live failed");
      });
      registered.add("live");

      expect(boundary.callEach(callbacks, invoke)).toBeUndefined();
      expect(lines.map((line) => line.level)).toEqual(Array<Level>(PAST_THE_CAP + 1).fill("error"));
      expect(lines.at(-1)!.message).toMatch(/^live threw: Error: live failed/);
    });

    it("keeps a registered id's state, so its repeat is counted rather than logged again", () => {
      const { boundary, lines, registered } = dispatcher();
      const failing = (): void => {
        throw new Error("sub failed");
      };

      registered.add("sub");
      boundary.call("sub", failing);
      boundary.callEach([["sub", failing]], invoke);

      expect(lines.map((line) => line.level)).toEqual(["error"]);
    });

    it("is never asked about run's ids, which are the dispatcher's own", () => {
      const isRegistered = vi.fn(() => false);
      const { boundary, lines } = setup({ isRegistered });
      const failing = (): HeldError => {
        throw new Error("poll failed");
      };

      boundary.run("controller:update", failing);
      boundary.run("controller:update", failing);

      expect(isRegistered).not.toHaveBeenCalled();
      expect(lines.map((line) => line.level)).toEqual(["error"]);
    });

    it("counts an id as registered when isRegistered throws, and never throws itself", () => {
      const { boundary, lines } = setup({
        isRegistered: () => {
          throw new Error("lookup failed");
        },
      });
      const failing = (): void => {
        throw new Error("sub failed");
      };

      expect(boundary.call("sub", failing)).toBeUndefined();
      expect(boundary.call("sub", failing)).toBeUndefined();
      expect(lines.map((line) => line.level)).toEqual(["error"]);
    });

    it('under "rethrow", holds the throw of a callback that unregistered itself', () => {
      const { boundary, lines, registered, unregisterThenThrow } = dispatcher({ policy: "rethrow" });

      registered.add("sub");
      const held = boundary.call("sub", unregisterThenThrow("sub"));

      expect(() => throwHeld(held)).toThrow("sub failed");
      expect(lines).toEqual([]);
    });
  });

  describe("options", () => {
    it("passes the reporter's options through", () => {
      const { boundary, lines, advance } = setup({ windowMs: 1_000 });

      boundary.call("sub", () => {
        throw new Error("sub failed");
      });
      advance(1_000);
      boundary.call("sub", () => {});

      expect(lines[1]!.message).toBe("sub recovered: no errors for 1s, after 1 time in all");
    });

    it("reads Date.now() on every call when no clock is given, so a clock moved after creation counts", () => {
      // Created before the fake clock is installed: a `Date.now` captured at creation
      // would keep reading the real clock and never see the window pass.
      const { logger, lines } = recordingLogger();
      const boundary = createErrorBoundary({ logger });

      boundary.call("sub", () => {
        throw new Error("sub failed");
      });
      const thrownAt = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(thrownAt + WINDOW + 1_000);
      boundary.call("sub", () => {});

      expect(lines.map((line) => line.level)).toEqual(["error", "info"]);
    });
  });
});

describe("throwHeld", () => {
  it("does nothing for undefined", () => {
    expect(() => throwHeld(undefined)).not.toThrow();
  });

  it("throws the held error itself", () => {
    const error = new Error("held");

    expect(() => throwHeld({ error })).toThrow(error);
  });
});
