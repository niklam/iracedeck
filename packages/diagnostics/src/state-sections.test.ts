import type { ILogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { JSON_SAFE_MAX_VALUES } from "./json-safe.js";
import {
  _resetStateSections,
  collectStateSections,
  type HeadlineRow,
  PLUGIN_STATE_SCHEMA,
  registerStateSection,
} from "./state-sections.js";

function fakeLogger(): ILogger {
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

const AT = () => 1234;

// The texts a report reader sees, pinned here as literals so a reworded one is a visible change.
const UNAVAILABLE = "unavailable (see the JSON file)";
const NO_SUMMARY = "summary unavailable";
const NO_VALUE = "n/a";
const UNKNOWN = "unknown error";
const NOT_SYNCHRONOUS = "the reader returned a promise; state readers must be synchronous";

const boom = (): never => {
  throw new Error("boom");
};

/** A headline that returns something its type does not allow, as a miswritten or miscast one would. */
const returning =
  (rows: unknown): (() => HeadlineRow[]) =>
  () =>
    rows as HeadlineRow[];

const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;

describe("state sections (#1387)", () => {
  let logger: ILogger;

  beforeEach(() => {
    _resetStateSections();
    logger = fakeLogger();
  });

  describe("collectStateSections", () => {
    it("returns the schema, the collection time and every section, in registration order", () => {
      registerStateSection("b", { read: () => ({ second: true }) });
      registerStateSection("a", { read: () => ({ first: [1, 2] }) });

      const { state, headline, failed } = collectStateSections(logger, AT);

      expect(state).toStrictEqual({ schema: 1, collectedAt: 1234, b: { second: true }, a: { first: [1, 2] } });
      expect(Object.keys(state)).toEqual(["schema", "collectedAt", "b", "a"]);
      expect(headline).toEqual([]);
      expect(failed).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("stamps the schema constant, which is 1", () => {
      expect(PLUGIN_STATE_SCHEMA).toBe(1);
      expect(collectStateSections(logger, AT).state).toStrictEqual({ schema: PLUGIN_STATE_SCHEMA, collectedAt: 1234 });
    });

    it("stamps Date.now() when no clock is passed", () => {
      const spy = vi.spyOn(Date, "now").mockReturnValue(1_791_727_391_482);

      try {
        expect(collectStateSections(logger).state.collectedAt).toBe(1_791_727_391_482);
      } finally {
        spy.mockRestore();
      }
    });

    it("passes every section through the JSON-safe encoder", () => {
      registerStateSection("sets", { read: () => ({ seen: new Set([3, 1]), worst: NaN, big: 5n }) });

      const { state } = collectStateSections(logger, AT);

      expect(state.sets).toStrictEqual({ seen: [3, 1], worst: "NaN", big: "5" });
      expect(() => JSON.stringify(state)).not.toThrow();
    });

    it("reads each section once per collection, and not at all at registration", () => {
      const read = vi.fn(() => ({ n: 1 }));

      registerStateSection("a", { read });
      expect(read).not.toHaveBeenCalled();

      collectStateSections(logger, AT);
      collectStateSections(logger, AT);

      expect(read).toHaveBeenCalledTimes(2);
    });
  });

  describe("failure isolation", () => {
    it("turns a reader that throws into an error entry and leaves the other sections intact", () => {
      registerStateSection("before", { read: () => ({ ok: 1 }) });
      registerStateSection("broken", {
        read: () => {
          throw new Error("translator not ready");
        },
      });
      registerStateSection("after", { read: () => ({ ok: 2 }) });

      const { state, failed } = collectStateSections(logger, AT);

      expect(state).toStrictEqual({
        schema: 1,
        collectedAt: 1234,
        before: { ok: 1 },
        broken: { error: "translator not ready" },
        after: { ok: 2 },
      });
      expect(failed).toEqual(["broken"]);
    });

    it("logs one WARN naming the failed section, with the reason at debug", () => {
      registerStateSection("fine", { read: () => 1 });
      registerStateSection("broken", {
        read: () => {
          throw new Error("translator not ready");
        },
      });

      collectStateSections(logger, AT);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith('Snapshot state section "broken" failed');
      expect(logger.debug).toHaveBeenCalledTimes(1);
      expect(logger.debug).toHaveBeenCalledWith('Section "broken": translator not ready');
    });

    // Review Focus 1: the reader returned, and the failure is in what it returned.
    it("turns a section whose property getter throws mid-encode into an error entry", () => {
      const headline = vi.fn(() => [["Never", "shown"]] as const);

      registerStateSection("before", { read: () => ({ ok: 1 }) });
      registerStateSection("getter", {
        read: () => ({
          fine: 1,
          nested: {
            get bad(): number {
              throw new Error("boom");
            },
          },
        }),
        headline,
      });
      registerStateSection("after", { read: () => ({ ok: 2 }) });

      const collected = collectStateSections(logger, AT);

      expect(collected.state).toStrictEqual({
        schema: 1,
        collectedAt: 1234,
        before: { ok: 1 },
        getter: { error: "boom" },
        after: { ok: 2 },
      });
      expect(collected.failed).toEqual(["getter"]);
      expect(collected.headline).toEqual([["getter", UNAVAILABLE]]);
      // Its headline would describe state the file does not hold.
      expect(headline).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(() => JSON.stringify(collected.state)).not.toThrow();
    });

    it("reports every failed section, each with its own WARN", () => {
      registerStateSection("a", { read: boom });
      registerStateSection("b", { read: () => 1 });
      registerStateSection("c", { read: boom });

      expect(collectStateSections(logger, AT).failed).toEqual(["a", "c"]);
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenNthCalledWith(1, 'Snapshot state section "a" failed');
      expect(logger.warn).toHaveBeenNthCalledWith(2, 'Snapshot state section "c" failed');
    });

    it("turns a section too large to encode into an error entry, with the others intact", () => {
      registerStateSection("before", { read: () => ({ ok: 1 }) });
      registerStateSection("huge", {
        read: () => {
          // Holes count towards the encoder's budget, so this costs no memory to build.
          const values: unknown[] = [];

          values.length = JSON_SAFE_MAX_VALUES;

          return values;
        },
      });
      registerStateSection("after", { read: () => ({ ok: 2 }) });

      const { state, failed } = collectStateSections(logger, AT);

      expect(state.before).toStrictEqual({ ok: 1 });
      expect(state.after).toStrictEqual({ ok: 2 });
      expect(state.huge).toStrictEqual({ error: expect.stringContaining("more than 2000000 values") });
      expect(failed).toEqual(["huge"]);
    });
  });

  // Whatever a reader throws, the entry is a non-empty string the file can hold and a reader can tell from state.
  describe("the reason of a failed section", () => {
    const nullPrototype: unknown = Object.create(null);

    const THROWN: ReadonlyArray<readonly [what: string, thrown: unknown, reason: string]> = [
      ["an Error's message", new Error("translator not ready"), "translator not ready"],
      ["a string that was thrown as it is", "plain string", "plain string"],
      ["a number that was thrown", 42, "42"],
      ["the message of an error-like object", { message: "from another realm" }, "from another realm"],
      ["a BigInt message as its digits", Object.assign(new Error("x"), { message: 7n }), "7"],
      ["a Symbol message as its description", Object.assign(new Error("x"), { message: Symbol("why") }), "Symbol(why)"],
      ["the name when the message is a cyclic object", Object.assign(new Error("x"), { message: cyclic }), "Error"],
      [
        "the name when the message is undefined",
        Object.assign(new TypeError("x"), { message: undefined }),
        "TypeError",
      ],
      ["the name of an Error made without a message", new RangeError(), "RangeError"],
      ["the name when the message is only white space", new Error("  \n"), "Error"],
      ["a fixed text when neither message nor name says anything", Object.assign(new Error(""), { name: "" }), UNKNOWN],
      ["a fixed text for a thrown null-prototype object", nullPrototype, UNKNOWN],
      ["a fixed text for a thrown plain object", { code: 5 }, UNKNOWN],
      ["a fixed text for a thrown undefined", undefined, UNKNOWN],
      ["a fixed text for a thrown null", null, UNKNOWN],
      ["a fixed text for a thrown empty string", "", UNKNOWN],
      [
        "a fixed text when reading the message throws",
        Object.defineProperty(new Error("x"), "message", { get: boom }),
        UNKNOWN,
      ],
    ];

    it.each(THROWN)("is %s", (_what, thrown, reason) => {
      registerStateSection("broken", {
        read: () => {
          throw thrown;
        },
      });
      registerStateSection("after", { read: () => ({ ok: 2 }) });

      const { state, failed, headline } = collectStateSections(logger, AT);

      expect(state.broken).toStrictEqual({ error: reason });
      expect(JSON.parse(JSON.stringify(state))).toStrictEqual(state);
      // The collection went on, and said what happened.
      expect(state.after).toStrictEqual({ ok: 2 });
      expect(failed).toEqual(["broken"]);
      expect(headline).toEqual([["broken", UNAVAILABLE]]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.debug).toHaveBeenCalledWith(`Section "broken": ${reason}`);
    });
  });

  describe("a reader that is not synchronous", () => {
    it("is a failed section, not a healthy one holding a promise", async () => {
      const headline = vi.fn(() => [["Never", "shown"]] as const);

      registerStateSection("before", { read: () => ({ ok: 1 }) });
      registerStateSection("async", { read: async () => ({ late: true }), headline });
      registerStateSection("after", { read: () => ({ ok: 2 }) });

      const collected = collectStateSections(logger, AT);

      expect(collected.state).toStrictEqual({
        schema: 1,
        collectedAt: 1234,
        before: { ok: 1 },
        async: { error: NOT_SYNCHRONOUS },
        after: { ok: 2 },
      });
      expect(collected.failed).toEqual(["async"]);
      expect(collected.headline).toEqual([["async", UNAVAILABLE]]);
      expect(headline).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith('Snapshot state section "async" failed');
    });

    it("treats any thenable the same way", () => {
      registerStateSection("thenable", { read: () => ({ then: () => undefined }) });

      const { state, failed } = collectStateSections(logger, AT);

      expect(state.thenable).toStrictEqual({ error: NOT_SYNCHRONOUS });
      expect(failed).toEqual(["thenable"]);
    });

    it("leaves state alone that merely has a key called then", () => {
      registerStateSection("plain", { read: () => ({ then: 5, now: 1 }) });

      const { state, failed } = collectStateSections(logger, AT);

      expect(state.plain).toStrictEqual({ then: 5, now: 1 });
      expect(failed).toEqual([]);
    });

    it("handles the promise's later rejection, so it is not an unhandled rejection", async () => {
      const unhandled = vi.fn();

      process.on("unhandledRejection", unhandled);

      try {
        registerStateSection("async", { read: () => Promise.reject(new Error("rejected after the collection")) });

        expect(collectStateSections(logger, AT).failed).toEqual(["async"]);

        // Node reports an unhandled rejection once the microtask queue has drained.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });
  });

  describe("headline", () => {
    it("gathers the rows of every section that has one, in registration order", () => {
      registerStateSection("b", { read: () => ({ v: 2 }), headline: (s) => [["B", String(s.v)]] });
      registerStateSection("silent", { read: () => ({ v: 0 }) });
      registerStateSection("a", {
        read: () => ({ v: 1 }),
        headline: (s) => [
          ["A", String(s.v)],
          ["A again", "x"],
        ],
      });

      expect(collectStateSections(logger, AT).headline).toEqual([
        ["B", "2"],
        ["A", "1"],
        ["A again", "x"],
      ]);
    });

    it("hands the headline the object the reader returned, not the encoded copy", () => {
      const raw = { seen: new Set([1]) };
      const headline = vi.fn((_state: typeof raw): HeadlineRow[] => []);

      registerStateSection("a", { read: () => raw, headline });

      const { state } = collectStateSections(logger, AT);

      expect(headline).toHaveBeenCalledTimes(1);
      expect(headline.mock.calls[0][0]).toBe(raw);
      expect(state.a).not.toBe(raw);
    });

    it("puts one row in the place of a section that failed, whether or not it has a headline", () => {
      registerStateSection("a", { read: () => 1, headline: () => [["A", "1"]] });
      registerStateSection("b", { read: boom, headline: () => [["B", "never"]] });
      registerStateSection("c", { read: boom });
      registerStateSection("d", { read: () => 4 });
      registerStateSection("e", { read: () => 5, headline: () => [["E", "5"]] });

      const { headline, failed } = collectStateSections(logger, AT);

      expect(headline).toEqual([
        ["A", "1"],
        ["b", UNAVAILABLE],
        ["c", UNAVAILABLE],
        ["E", "5"],
      ]);
      expect(failed).toEqual(["b", "c"]);
    });

    it("puts one row in the place of a headline that throws: the state stays and the section has not failed", () => {
      registerStateSection("a", { read: () => ({ v: 1 }), headline: () => [["A", "1"]] });
      registerStateSection("b", {
        read: () => ({ v: 2 }),
        headline: () => {
          throw new Error("no fuel yet");
        },
      });
      registerStateSection("c", { read: () => ({ v: 3 }), headline: () => [["C", "3"]] });

      const { state, headline, failed } = collectStateSections(logger, AT);

      expect(headline).toEqual([
        ["A", "1"],
        ["b", NO_SUMMARY],
        ["C", "3"],
      ]);
      expect(state.b).toStrictEqual({ v: 2 });
      expect(failed).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith('Section "b" headline failed: no fuel yet');
    });

    it("keeps none of a section's rows when its headline fails part-way through producing them", () => {
      registerStateSection("a", {
        read: () => ({ v: 1 }),
        headline: function* (): Generator<HeadlineRow> {
          yield ["A", "1"];

          throw new Error("second row failed");
        } as unknown as () => HeadlineRow[],
      });

      expect(collectStateSections(logger, AT).headline).toEqual([["a", NO_SUMMARY]]);
    });

    it("turns number, BigInt and boolean cells into their text, and a missing one into a placeholder", () => {
      registerStateSection("a", {
        read: () => 1,
        headline: returning([
          ["Count", 3],
          ["Ratio", NaN],
          ["Big", 5n],
          ["Flag", false],
          ["Missing", undefined],
          ["Null", null],
          ["Empty", ""],
        ]),
      });

      const { headline } = collectStateSections(logger, AT);

      expect(headline).toStrictEqual([
        ["Count", "3"],
        ["Ratio", "NaN"],
        ["Big", "5"],
        ["Flag", "false"],
        ["Missing", NO_VALUE],
        ["Null", NO_VALUE],
        ["Empty", ""],
      ]);
    });

    it("returns rows of its own, not the arrays the headline produced", () => {
      const row: HeadlineRow = ["A", "1"];

      registerStateSection("a", { read: () => 1, headline: () => [row] });

      const { headline } = collectStateSections(logger, AT);

      expect(headline).toStrictEqual([["A", "1"]]);
      expect(headline[0]).not.toBe(row);
    });

    // Each of these went through untouched before, and threw later in the report's table builder.
    it.each<readonly [what: string, produced: unknown]>([
      ["a row of one cell", [["Fine", "1"], ["OneCell"]]],
      [
        "a row of three cells",
        [
          ["Fine", "1"],
          ["A", "B", "C"],
        ],
      ],
      ["a row that is a two-character string", [["Fine", "1"], "ab"]],
      ["a row that is an object", [["Fine", "1"], { label: "A", value: "B" }]],
      ["a string instead of rows", "Fuel: 2 laps"],
      ["one row instead of a list of rows", ["Fuel", "2 laps"]],
      ["a number", 5],
      ["a plain object", { Fuel: "2 laps" }],
      ["nothing", undefined],
      ["null", null],
      [
        "an object as a cell",
        [
          ["Fine", "1"],
          ["State", { v: 1 }],
        ],
      ],
      [
        "an array as a cell",
        [
          ["Fine", "1"],
          ["Gaps", [1, 2]],
        ],
      ],
      [
        "a symbol as a cell",
        [
          ["Fine", "1"],
          ["Kind", Symbol("s")],
        ],
      ],
      [
        "a function as a cell",
        [
          ["Fine", "1"],
          ["Count", () => 3],
        ],
      ],
    ])("treats a headline that returns %s as a failed headline", (_what, produced) => {
      registerStateSection("before", { read: () => 1, headline: () => [["Before", "1"]] });
      registerStateSection("odd", { read: () => ({ v: 2 }), headline: returning(produced) });
      registerStateSection("after", { read: () => 3, headline: () => [["After", "3"]] });

      const { state, headline, failed } = collectStateSections(logger, AT);

      // No partial rows: "Fine" is not there.
      expect(headline).toStrictEqual([
        ["Before", "1"],
        ["odd", NO_SUMMARY],
        ["After", "3"],
      ]);
      expect(state.odd).toStrictEqual({ v: 2 });
      expect(failed).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledTimes(1);
      expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/^Section "odd" headline failed: \S/));
    });

    it("gives every cell as a string, so a table builder never meets anything else", () => {
      registerStateSection("a", { read: () => 1, headline: returning([["Count", 3]]) });
      registerStateSection("b", { read: boom });
      registerStateSection("c", { read: () => 1, headline: returning(7) });

      for (const row of collectStateSections(logger, AT).headline) {
        expect(row).toHaveLength(2);
        expect(row.map((cell) => typeof cell)).toEqual(["string", "string"]);
      }
    });
  });

  describe("registerStateSection", () => {
    it("refuses a name that is already registered, and keeps the first owner", () => {
      registerStateSection("sim", { read: () => "first" });

      expect(() => registerStateSection("sim", { read: () => "second" })).toThrow(
        'State section "sim" is already registered',
      );
      expect(collectStateSections(logger, AT).state.sim).toBe("first");
    });

    it.each(["schema", "collectedAt", "error"])("refuses the reserved name %s", (name) => {
      expect(() => registerStateSection(name, { read: () => 1 })).toThrow(`Invalid state section name: "${name}"`);
    });

    it("refuses an empty name", () => {
      expect(() => registerStateSection("", { read: () => 1 })).toThrow('Invalid state section name: ""');
    });
  });

  describe("_resetStateSections", () => {
    it("forgets every section", () => {
      registerStateSection("a", { read: () => 1 });
      _resetStateSections();

      expect(collectStateSections(logger, AT).state).toStrictEqual({ schema: 1, collectedAt: 1234 });
      expect(() => registerStateSection("a", { read: () => 2 })).not.toThrow();
    });
  });
});
