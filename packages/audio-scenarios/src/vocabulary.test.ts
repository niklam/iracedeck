import type { ILogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedStep, ScenarioContext } from "./dsl.js";
import { OnceWarnings } from "./once-warnings.js";
import { Vocabulary } from "./vocabulary.js";

const logger: ILogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
} as unknown as ILogger;

const ctx: ScenarioContext = { event: null, telemetry: null, data: null, now: 0, vars: {} };

const caseStep = (name: string): Extract<ResolvedStep, { kind: "case" }> => ({
  kind: "case",
  name,
  of: new Map<string, ResolvedStep[]>([["race", [{ kind: "clip", path: "race.mp3" }]]]),
  fallback: [{ kind: "clip", path: "default.mp3" }],
});

let vocab: Vocabulary;

beforeEach(() => {
  vi.clearAllMocks();
  vocab = new Vocabulary(logger, new OnceWarnings());
});

describe("Vocabulary", () => {
  it("reports every var, condition and case sorted by name in code-point order", () => {
    vocab.defineVar("b.var", () => null, "second");
    vocab.defineVar("a.var", () => null);
    vocab.defineCond("Z.cond", () => true, "upper sorts first");
    vocab.defineCond("a.cond", () => true, "lower");
    vocab.defineCase("s.type", () => "race", { race: "a race", practice: "practice" }, "the session type");

    expect(vocab.vocabulary()).toEqual({
      vars: [
        { name: "a.var", description: "" },
        { name: "b.var", description: "second" },
      ],
      conds: [
        { name: "Z.cond", description: "upper sorts first" },
        { name: "a.cond", description: "lower" },
      ],
      cases: [{ name: "s.type", description: "the session type", keys: { race: "a race", practice: "practice" } }],
    });
  });

  describe("declared draws (#1718)", () => {
    it("reports `draws` on a var that declared it and omits the key on one that did not", () => {
      vocab.defineVar("closed", () => null, "a closed set", { draws: [{ group: "spotter", base: "clear" }] });
      vocab.defineVar("open", () => null, "open-ended");
      vocab.defineVar("bare", () => null);

      const vars = vocab.vocabulary().vars;

      expect(vars).toEqual([
        { name: "bare", description: "" },
        { name: "closed", description: "a closed set", draws: [{ group: "spotter", base: "clear" }] },
        { name: "open", description: "open-ended" },
      ]);
      // `toEqual` treats an `undefined` property as absent; the generated
      // reference serialises the report, so the key itself must be missing.
      expect(Object.hasOwn(vars[0], "draws")).toBe(false);
      expect(Object.hasOwn(vars[2], "draws")).toBe(false);
    });

    it("reports an empty declaration as declared — a var that can return no pool still has a closed set", () => {
      vocab.defineVar("never", () => null, "", { draws: [] });

      expect(vocab.vocabulary().vars).toEqual([{ name: "never", description: "", draws: [] }]);
    });

    it("copies the declaration at registration and on every report", () => {
      const draws = [{ group: "spotter", base: "clear" }];
      vocab.defineVar("closed", () => null, "", { draws });
      draws.push({ group: "spotter", base: "added-later" });
      draws[0].base = "mutated";

      const first = vocab.vocabulary().vars[0].draws as { group: string; base: string }[];
      first.push({ group: "spotter", base: "pushed-into-report" });

      expect(vocab.vocabulary().vars[0].draws).toEqual([{ group: "spotter", base: "clear" }]);
    });

    it("a re-registration replaces the declaration whole — one without draws drops the earlier set", () => {
      vocab.defineVar("closed", () => null, "", { draws: [{ group: "spotter", base: "clear" }] });
      vocab.defineVar("closed", () => null, "now open");

      expect(vocab.vocabulary().vars).toEqual([{ name: "closed", description: "now open" }]);
      expect(Object.hasOwn(vocab.vocabulary().vars[0], "draws")).toBe(false);
    });
  });

  it("exposes the registries read-only, with the case keys copied at registration", () => {
    const keys: Record<string, string> = { race: "a race" };
    vocab.defineCase("s.type", () => "race", keys, "d");
    keys.added = "later";

    expect(vocab.cases.get("s.type")?.keys).toEqual({ race: "a race" });
    expect(vocab.vars.size).toBe(0);
    expect(vocab.conds.size).toBe(0);
  });

  describe("pickCaseBranch", () => {
    it("takes the branch of a declared key", () => {
      vocab.defineCase("s.type", () => "race", { race: "a race" }, "d");

      expect(vocab.pickCaseBranch(caseStep("s.type"), ctx)).toEqual([{ kind: "clip", path: "race.mp3" }]);
    });

    it("takes the fallback for a null key, a declared key the script does not map, and an unregistered case", () => {
      vocab.defineCase("s.null", () => null, { race: "a race" }, "d");
      vocab.defineCase("s.unmapped", () => "practice", { race: "a race", practice: "p" }, "d");

      expect(vocab.pickCaseBranch(caseStep("s.null"), ctx)).toEqual([{ kind: "clip", path: "default.mp3" }]);
      expect(vocab.pickCaseBranch(caseStep("s.unmapped"), ctx)).toEqual([{ kind: "clip", path: "default.mp3" }]);
      expect(vocab.pickCaseBranch(caseStep("s.missing"), ctx)).toEqual([{ kind: "clip", path: "default.mp3" }]);
      expect(logger.error).toHaveBeenCalledWith('case "s.missing" is not registered — taking the default branch');
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("warns once per (case, key) for an undeclared key and takes the fallback", () => {
      vocab.defineCase("s.type", () => "qualifying", { race: "a race" }, "d");

      expect(vocab.pickCaseBranch(caseStep("s.type"), ctx)).toEqual([{ kind: "clip", path: "default.mp3" }]);
      expect(vocab.pickCaseBranch(caseStep("s.type"), ctx)).toEqual([{ kind: "clip", path: "default.mp3" }]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'case "s.type" resolved to undeclared key "qualifying" — taking the default branch',
      );
    });

    it("logs a throwing resolver at error and takes the fallback", () => {
      vocab.defineCase(
        "s.type",
        () => {
          throw new Error("boom");
        },
        { race: "a race" },
        "d",
      );

      expect(vocab.pickCaseBranch(caseStep("s.type"), ctx)).toEqual([{ kind: "clip", path: "default.mp3" }]);
      expect(logger.error).toHaveBeenCalledWith('case "s.type" resolver threw: boom');
    });
  });
});
