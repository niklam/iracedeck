import type { ILogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

    it("logs one WARN for the failed section, with its name and the reason at debug", () => {
      registerStateSection("fine", { read: () => 1 });
      registerStateSection("broken", {
        read: () => {
          throw new Error("translator not ready");
        },
      });

      collectStateSections(logger, AT);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith("Snapshot state section failed");
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
      expect(collected.headline).toEqual([]);
      // Its headline would describe state the file does not hold.
      expect(headline).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(() => JSON.stringify(collected.state)).not.toThrow();
    });

    it("reports every failed section, each with its own WARN", () => {
      const boom = (): never => {
        throw new Error("boom");
      };

      registerStateSection("a", { read: boom });
      registerStateSection("b", { read: () => 1 });
      registerStateSection("c", { read: boom });

      expect(collectStateSections(logger, AT).failed).toEqual(["a", "c"]);
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it("uses the thrown value itself as the message when it is not an Error", () => {
      registerStateSection("a", {
        read: () => {
          throw "plain string";
        },
      });

      expect(collectStateSections(logger, AT).state.a).toStrictEqual({ error: "plain string" });
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

    it("drops only its own rows when it throws: the state stays and the section has not failed", () => {
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

      expect(collectStateSections(logger, AT).headline).toEqual([]);
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
