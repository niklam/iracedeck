import { describe, expect, it, vi } from "vitest";

import {
  type BoundedErrorReporterOptions,
  createBoundedErrorReporter,
  DEFAULT_ERROR_REPORT_WINDOW_MS,
  DEFAULT_MAX_ERROR_KEYS,
  DEFAULT_MAX_ERROR_KEYS_PER_ID,
  describeThrowable,
  type ErrorPolicy,
} from "./bounded-error-reporter.js";
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

function setup(overrides: Partial<BoundedErrorReporterOptions> = {}) {
  const { logger, lines } = recordingLogger();
  let time = 1_000_000;
  const now = vi.fn(() => time);
  const reporter = createBoundedErrorReporter({ logger, now, ...overrides });

  return {
    reporter,
    lines,
    now,
    advance: (ms: number) => {
      time += ms;
    },
    levels: () => lines.map((line) => line.level),
  };
}

const WINDOW = DEFAULT_ERROR_REPORT_WINDOW_MS;

/** An error whose first stack frame is `site`, so a test can make as many distinct sites as it needs. */
function errorAt(site: string, message = "boom"): Error {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at ${site}\n    at caller (deep.ts:1:1)`;

  return error;
}

/** An error with no stack, keyed on its name and message. */
function stacklessError(message: string): Error {
  const error = new RangeError(message);
  error.stack = undefined;

  return error;
}

/** One real throw site: every error from here shares its first frame, whatever its message. */
function throwSiteA(n: number): Error {
  return new Error(`index ${n} out of range`);
}

function throwSiteB(n: number): Error {
  return new Error(`index ${n} out of range`);
}

describe("ErrorPolicy", () => {
  it("names the two policies", () => {
    const policies: ErrorPolicy[] = ["report", "rethrow"];

    expect(policies).toEqual(["report", "rethrow"]);
  });
});

describe("createBoundedErrorReporter", () => {
  describe("defaults", () => {
    it("uses the spec's window and caps", () => {
      expect(DEFAULT_ERROR_REPORT_WINDOW_MS).toBe(60_000);
      expect(DEFAULT_MAX_ERROR_KEYS_PER_ID).toBe(4);
      expect(DEFAULT_MAX_ERROR_KEYS).toBe(32);
    });

    it("reads Date.now when no clock is given", () => {
      const { logger, lines } = recordingLogger();
      const spy = vi.spyOn(Date, "now");

      try {
        const reporter = createBoundedErrorReporter({ logger });
        reporter.report("sub", new Error("x"));

        expect(spy).toHaveBeenCalled();
        expect(lines).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("first occurrence and repeats", () => {
    it("writes one error line with the stack for the first occurrence of a key", () => {
      const { reporter, lines } = setup();
      const error = throwSiteA(1);

      reporter.report("sub", error);

      expect(lines).toHaveLength(1);
      expect(lines[0].level).toBe("error");
      expect(lines[0].message).toContain("sub");
      expect(lines[0].message).toContain(error.stack);
    });

    it("writes nothing for repeats inside the window", () => {
      const { reporter, lines, advance } = setup();

      reporter.report("sub", throwSiteA(1));

      for (let i = 0; i < 100; i++) {
        advance(500);
        reporter.report("sub", throwSiteA(i));
      }

      expect(lines).toHaveLength(1);
    });

    it("writes one warn line per window with the count since the last line", () => {
      const { reporter, lines, advance, levels } = setup();

      reporter.report("sub", throwSiteA(0));

      // 59 more throws, one a second, then the 60th lands on the window.
      for (let i = 1; i <= 60; i++) {
        advance(1_000);
        reporter.report("sub", throwSiteA(i));
      }

      expect(levels()).toEqual(["error", "warn"]);
      expect(lines[1].message).toContain("60 more times");
      expect(lines[1].message).toContain("in the last 60s");

      // The next window counts from that line, not from the first error.
      for (let i = 1; i <= 120; i++) {
        advance(500);
        reporter.report("sub", throwSiteA(i));
      }

      expect(levels()).toEqual(["error", "warn", "warn"]);
      expect(lines[2].message).toContain("120 more times");
    });

    it("says '1 more time' for a single repeat", () => {
      const { reporter, lines, advance, levels } = setup();

      reporter.report("sub", throwSiteA(0));
      // Another site keeps the id from counting as quiet.
      advance(WINDOW / 2);
      reporter.report("sub", throwSiteB(0));
      advance(WINDOW / 2);
      reporter.report("sub", throwSiteA(0));

      expect(levels()).toEqual(["error", "error", "warn"]);
      expect(lines[2].message).toContain("threw 1 more time in the last 60s");
    });

    it("never puts the stack on a warn line", () => {
      const { reporter, lines, advance } = setup();

      reporter.report("sub", errorAt("site (a.ts:1:1)", "first line\nsecond line"));
      advance(WINDOW / 2);
      reporter.report("sub", errorAt("site (a.ts:1:1)", "first line\nsecond line"));
      advance(WINDOW / 2);
      reporter.report("sub", errorAt("site (a.ts:1:1)", "first line\nsecond line"));

      expect(lines[0].message).toContain("deep.ts");
      expect(lines[1].level).toBe("warn");
      expect(lines[1].message).not.toContain("deep.ts");
      expect(lines[1].message).not.toContain("second line");
      expect(lines[1].message).toContain("first line");
    });
  });

  describe("recovery", () => {
    it("alternating throws and clean calls write one error line and no info until a quiet window", () => {
      const { reporter, lines, advance, levels } = setup();

      // A car present on one tick and gone the next: a throw every other 16 ms tick for 48 s.
      for (let tick = 0; tick < 3_000; tick++) {
        if (tick % 2 === 0) reporter.report("sub", throwSiteA(tick));
        else reporter.succeeded("sub");

        advance(16);
      }

      expect(levels()).toEqual(["error"]);

      // Clean from here on: the last throw was two ticks ago, and no info line comes until
      // a whole window has passed since it.
      advance(WINDOW - 2 * 16 - 1);
      reporter.succeeded("sub");
      expect(levels()).toEqual(["error"]);

      advance(1);
      reporter.succeeded("sub");
      expect(levels()).toEqual(["error", "info"]);
      expect(lines[1].message).toContain("sub recovered");
      expect(lines[1].message).toContain("1500 times in all");

      // Recovered once only.
      advance(WINDOW);
      reporter.succeeded("sub");
      expect(levels()).toEqual(["error", "info"]);
    });

    it("forgets the id's keys on recovery, so the next throw is a first occurrence again", () => {
      const { reporter, advance, levels } = setup();

      reporter.report("sub", throwSiteA(1));
      advance(WINDOW);
      reporter.succeeded("sub");
      reporter.report("sub", throwSiteA(2));

      expect(levels()).toEqual(["error", "info", "error"]);
    });

    it("declares recovery on the next throw when no clean call came in between", () => {
      const { reporter, lines, advance, levels } = setup();

      reporter.report("sub", throwSiteA(1));
      advance(WINDOW * 3);
      reporter.report("sub", throwSiteA(2));

      expect(levels()).toEqual(["error", "info", "error"]);
      expect(lines[1].message).toContain("1 time in all");
      expect(lines[1].message).toContain("180s");
    });

    it("counts every throw of the id, across keys and overflow, in the recovery total", () => {
      const { reporter, lines, advance } = setup({ maxKeysPerId: 1 });

      reporter.report("sub", errorAt("a (a.ts:1:1)"));
      reporter.report("sub", errorAt("a (a.ts:1:1)"));
      reporter.report("sub", errorAt("b (b.ts:1:1)"));
      reporter.report("sub", errorAt("c (c.ts:1:1)"));
      advance(WINDOW);
      reporter.succeeded("sub");

      expect(lines.at(-1)?.level).toBe("info");
      expect(lines.at(-1)?.message).toContain("4 times in all");
    });

    it("does not read the clock for an id with nothing recorded", () => {
      const { reporter, now, lines } = setup();

      for (let i = 0; i < 1_000; i++) reporter.succeeded("clean");

      expect(now).not.toHaveBeenCalled();
      expect(lines).toEqual([]);
    });

    it("leaves other ids alone when one recovers", () => {
      const { reporter, advance, levels } = setup();

      reporter.report("a", throwSiteA(1));
      advance(WINDOW / 2);
      reporter.report("b", throwSiteA(1));
      advance(WINDOW / 2);
      reporter.succeeded("a");
      reporter.succeeded("b");
      reporter.report("b", throwSiteA(2));

      // a recovered; b, which threw 30 s ago, did not and its next throw is a repeat.
      expect(levels()).toEqual(["error", "error", "info"]);
    });
  });

  describe("keys", () => {
    it("treats a message differing only in its digits as the same key when there is no stack", () => {
      const { reporter, levels } = setup();

      reporter.report("sub", stacklessError("index 37 out of range"));
      reporter.report("sub", stacklessError("index 4 out of range"));
      reporter.report("sub", stacklessError("index 1234 out of range"));

      expect(levels()).toEqual(["error"]);
    });

    it("treats two different stackless messages as two keys", () => {
      const { reporter, levels } = setup();

      reporter.report("sub", stacklessError("index 37 out of range"));
      reporter.report("sub", stacklessError("cannot read properties of undefined"));

      expect(levels()).toEqual(["error", "error"]);
    });

    it("keys an error with a stack on its first frame, whatever its message", () => {
      const { reporter, levels } = setup();

      reporter.report("sub", throwSiteA(1));
      reporter.report("sub", throwSiteA(2));
      reporter.report("sub", errorAt("same (s.ts:1:1)", "one message"));
      reporter.report("sub", errorAt("same (s.ts:1:1)", "a different message"));

      expect(levels()).toEqual(["error", "error"]);
    });

    it("treats two throw sites as two keys", () => {
      const { reporter, levels } = setup();

      reporter.report("sub", throwSiteA(1));
      reporter.report("sub", throwSiteB(1));

      expect(levels()).toEqual(["error", "error"]);
    });

    it("keys the same site under two ids separately", () => {
      const { reporter, levels } = setup();

      reporter.report("a", throwSiteA(1));
      reporter.report("b", throwSiteA(1));

      expect(levels()).toEqual(["error", "error"]);
    });
  });

  describe("caps", () => {
    it("counts a new key past the per-id cap as overflow, with one warn line", () => {
      const { reporter, lines, levels } = setup();

      for (let site = 0; site < DEFAULT_MAX_ERROR_KEYS_PER_ID; site++) {
        reporter.report("noisy", errorAt(`site${site} (s.ts:1:1)`));
      }

      expect(levels()).toEqual(["error", "error", "error", "error"]);

      for (let site = DEFAULT_MAX_ERROR_KEYS_PER_ID; site < 50; site++) {
        reporter.report("noisy", errorAt(`site${site} (s.ts:1:1)`));
      }

      expect(levels()).toEqual(["error", "error", "error", "error", "warn"]);
      expect(lines[4].message).toContain("noisy reached the cap of 4 error sites per id");

      // The keys it already has still repeat normally, without lines.
      reporter.report("noisy", errorAt("site0 (s.ts:1:1)"));
      expect(lines).toHaveLength(5);
    });

    it("does not let a noisy id at its cap hide another id's first error", () => {
      const { reporter, levels } = setup();

      for (let site = 0; site < 200; site++) reporter.report("noisy", errorAt(`site${site} (s.ts:1:1)`));

      reporter.report("quiet", errorAt("site0 (s.ts:1:1)"));

      expect(levels()).toEqual(["error", "error", "error", "error", "warn", "error"]);
    });

    it("summarises the overflow once per window", () => {
      const { reporter, lines, advance } = setup({ maxKeysPerId: 1 });

      reporter.report("sub", errorAt("a (a.ts:1:1)"));
      reporter.report("sub", errorAt("b (b.ts:1:1)"));

      for (let i = 0; i < 10; i++) reporter.report("sub", errorAt(`new${i} (n.ts:1:1)`));

      // A repeat of the tracked key keeps the id from counting as quiet.
      advance(WINDOW - 1);
      reporter.report("sub", errorAt("a (a.ts:1:1)"));
      advance(1);
      reporter.report("sub", errorAt("z (z.ts:1:1)"));

      expect(lines.map((line) => line.level)).toEqual(["error", "warn", "warn"]);
      expect(lines[2].message).toContain("11 more times past the cap");
    });

    it("counts a new key past the global cap as that id's overflow", () => {
      const { reporter, lines, levels } = setup();
      const fullIds = DEFAULT_MAX_ERROR_KEYS / DEFAULT_MAX_ERROR_KEYS_PER_ID;

      for (let id = 0; id < fullIds; id++) {
        for (let site = 0; site < DEFAULT_MAX_ERROR_KEYS_PER_ID; site++) {
          reporter.report(`id${id}`, errorAt(`site${site} (s.ts:1:1)`));
        }
      }

      expect(levels()).toEqual(Array(DEFAULT_MAX_ERROR_KEYS).fill("error"));

      reporter.report("late", errorAt("site0 (s.ts:1:1)"));
      reporter.report("late", errorAt("site1 (s.ts:1:1)"));

      expect(levels()).toHaveLength(DEFAULT_MAX_ERROR_KEYS + 1);
      expect(lines.at(-1)?.level).toBe("warn");
      expect(lines.at(-1)?.message).toContain("late reached the cap of 32 error sites in all");
    });

    it("frees global slots when an id recovers", () => {
      const { reporter, advance, levels } = setup({ maxKeys: 2 });

      reporter.report("a", errorAt("a1 (a.ts:1:1)"));
      reporter.report("a", errorAt("a2 (a.ts:1:1)"));
      reporter.report("b", errorAt("b1 (b.ts:1:1)"));
      expect(levels()).toEqual(["error", "error", "warn"]);

      advance(WINDOW);
      reporter.succeeded("a");
      reporter.forget("b");
      reporter.report("c", errorAt("c1 (c.ts:1:1)"));

      expect(levels()).toEqual(["error", "error", "warn", "info", "error"]);
    });
  });

  describe("forget", () => {
    it("flushes a pending count as one warn line", () => {
      const { reporter, lines, levels } = setup();

      reporter.report("sub", throwSiteA(1));
      reporter.report("sub", throwSiteA(2));
      reporter.report("sub", throwSiteB(1));
      reporter.report("sub", throwSiteB(2));
      reporter.report("sub", throwSiteB(3));
      reporter.forget("sub");

      expect(levels()).toEqual(["error", "error", "warn"]);
      expect(lines[2].message).toContain("sub forgotten with 3 times not yet reported");
      expect(lines[2].message).toContain("5 times in all");
    });

    it("includes pending overflow in the flushed count", () => {
      const { reporter, lines } = setup({ maxKeysPerId: 1 });

      reporter.report("sub", errorAt("a (a.ts:1:1)"));
      reporter.report("sub", errorAt("b (b.ts:1:1)"));
      reporter.report("sub", errorAt("c (c.ts:1:1)"));
      reporter.forget("sub");

      expect(lines.at(-1)?.message).toContain("1 time not yet reported");
    });

    it("writes nothing when nothing is pending", () => {
      const { reporter, levels } = setup();

      reporter.report("sub", throwSiteA(1));
      reporter.forget("sub");
      reporter.forget("never-seen");

      expect(levels()).toEqual(["error"]);
    });

    it("frees the id's keys, so its next throw is a first occurrence and the global slots are free", () => {
      const { reporter, levels } = setup({ maxKeys: 1 });

      reporter.report("a", throwSiteA(1));
      reporter.forget("a");
      reporter.report("b", throwSiteA(1));
      reporter.forget("b");
      reporter.report("a", throwSiteA(1));

      expect(levels()).toEqual(["error", "error", "error"]);
    });

    it("forgets only the id it names", () => {
      const { reporter, levels } = setup();

      reporter.report("a", throwSiteA(1));
      reporter.report("b", throwSiteA(1));
      reporter.forget("a");
      reporter.report("b", throwSiteA(2));

      expect(levels()).toEqual(["error", "error"]);
    });
  });

  describe("never throws", () => {
    it.each([
      ["a string", "plain string 42"],
      ["undefined", undefined],
      ["null", null],
      ["a number", 7],
      ["a symbol", Symbol("s")],
      ["an object with no stack", { code: 3 }],
      ["an error-like object", { name: "Custom", message: "custom 9" }],
      ["a null-prototype object", Object.create(null) as object],
    ])("reports %s as a first occurrence", (_label, thrown) => {
      const { reporter, levels } = setup();

      expect(() => reporter.report("sub", thrown)).not.toThrow();
      expect(levels()).toEqual(["error"]);
    });

    it("survives an object whose properties throw on access", () => {
      const { reporter, levels } = setup();
      const hostile = new Proxy(
        {},
        {
          get() {
            throw new Error("no access");
          },
          getPrototypeOf() {
            throw new Error("no prototype");
          },
        },
      );

      expect(() => reporter.report("sub", hostile)).not.toThrow();
      expect(levels()).toEqual(["error"]);
    });

    it("survives a throwing logger", () => {
      const logger: ILogger = {
        trace: () => {
          throw new Error("logger down");
        },
        debug: () => {
          throw new Error("logger down");
        },
        info: () => {
          throw new Error("logger down");
        },
        warn: () => {
          throw new Error("logger down");
        },
        error: () => {
          throw new Error("logger down");
        },
        withLevel: () => logger,
        createScope: () => logger,
      };
      let time = 0;
      const reporter = createBoundedErrorReporter({ logger, now: () => time, maxKeysPerId: 1 });

      expect(() => {
        reporter.report("sub", throwSiteA(1));
        reporter.report("sub", throwSiteB(1));
        reporter.report("sub", throwSiteB(1));
        time += WINDOW;
        reporter.report("sub", throwSiteA(1));
        time += WINDOW;
        reporter.succeeded("sub");
        reporter.report("sub", throwSiteA(1));
        reporter.report("sub", throwSiteA(1));
        reporter.forget("sub");
      }).not.toThrow();
    });

    it("survives a throwing clock", () => {
      const { logger } = recordingLogger();
      let broken = false;
      const reporter = createBoundedErrorReporter({
        logger,
        now: () => {
          if (broken) throw new Error("clock down");

          return 0;
        },
      });

      reporter.report("sub", throwSiteA(1));
      broken = true;

      expect(() => {
        reporter.report("sub", throwSiteA(1));
        reporter.succeeded("sub");
        reporter.forget("sub");
      }).not.toThrow();
    });
  });

  describe("options", () => {
    it.each([
      ["windowMs", 0],
      ["windowMs", -1],
      ["windowMs", Number.NaN],
      ["windowMs", Number.POSITIVE_INFINITY],
      ["maxKeysPerId", 0],
      ["maxKeysPerId", 1.5],
      ["maxKeys", 0],
      ["maxKeys", -4],
    ])("refuses %s = %s", (name, value) => {
      const { logger } = recordingLogger();

      expect(() => createBoundedErrorReporter({ logger, [name]: value })).toThrow(RangeError);
    });

    it("takes a custom window", () => {
      const { reporter, advance, levels } = setup({ windowMs: 1_000 });

      reporter.report("sub", throwSiteA(1));
      advance(1_000);
      reporter.succeeded("sub");

      expect(levels()).toEqual(["error", "info"]);
    });
  });
});

describe("describeThrowable", () => {
  it("keys an error on its first stack frame and keeps the full stack as detail", () => {
    const described = describeThrowable(errorAt("fn (file.ts:10:5)", "bad 12"));

    expect(described.site).toBe("at fn (file.ts:10:5)");
    expect(described.detail).toContain("deep.ts");
    expect(described.summary).toBe("Error: bad 12");
  });

  it("finds the first frame after a multi-line message", () => {
    const error = new Error("line one\nline two");
    error.stack = "Error: line one\nline two\n    at real (r.ts:1:1)";

    expect(describeThrowable(error).site).toBe("at real (r.ts:1:1)");
    expect(describeThrowable(error).summary).toBe("Error: line one");
  });

  it("falls back to the name and normalised message when the stack has no frames", () => {
    const error = new TypeError("slot 5 empty");
    error.stack = "TypeError: slot 5 empty";

    expect(describeThrowable(error).site).toBe("TypeError: slot # empty");
  });

  it("falls back to the name and normalised message when there is no stack", () => {
    expect(describeThrowable(stacklessError("index 37 out of range")).site).toBe("RangeError: index # out of range");
  });

  it("describes a thrown plain object as JSON", () => {
    expect(describeThrowable({ code: 3 }).summary).toBe('object: {"code":3}');
    expect(describeThrowable({ code: 3 }).site).toBe('object: {"code":#}');
    expect(describeThrowable(Object.create(null)).summary).toBe("object: [object Object]");
  });

  it("describes a primitive by its type and value", () => {
    expect(describeThrowable("lap 3 bad").site).toBe("string: lap # bad");
    expect(describeThrowable(undefined).summary).toBe("undefined: undefined");
  });

  it("truncates a long summary", () => {
    const described = describeThrowable(stacklessError("x".repeat(1_000)));

    expect(described.summary.length).toBeLessThanOrEqual(200);
  });
});
