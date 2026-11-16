import { describe, expect, it } from "vitest";

import { parseGenerateArgs } from "./cli-args.ts";

const UNSCOPED = { voices: null, groups: null, entries: null };

describe("parseGenerateArgs", () => {
  it("reads no flags as a live, unscoped run", () => {
    expect(parseGenerateArgs([])).toEqual({ scope: UNSCOPED, dryRun: false, importDir: null });
  });

  it("reads --dry-run, the scope flags and --import together", () => {
    expect(parseGenerateArgs(["--voice", "default", "--dry-run", "--group=numbers", "--entry", "0,1"])).toEqual({
      scope: { voices: ["default"], groups: ["numbers"], entries: ["0", "1"] },
      dryRun: true,
      importDir: null,
    });
    expect(parseGenerateArgs(["--import", "../trial", "--dry-run"])).toEqual({
      scope: UNSCOPED,
      dryRun: true,
      importDir: "../trial",
    });
  });

  it("accepts --dry-run given twice", () => {
    expect(parseGenerateArgs(["--dry-run", "--dry-run"]).dryRun).toBe(true);
  });

  // A typo of --dry-run that was ignored would start a paid run.
  it.each([["--dryrun"], ["--dry_run"], ["-dry-run"], ["--dry-run=true"], ["--Dry-Run"], ["dry-run"]])(
    "refuses %s, naming it and the valid flags",
    (arg) => {
      expect(() => parseGenerateArgs(["--group", "numbers", arg])).toThrow(
        new RegExp(
          `^Unknown argument ${JSON.stringify(arg).replace(/[-[\]]/g, "\\$&")}; nothing was run\\.\\n  Valid flags: --dry-run, --voice`,
        ),
      );
    },
  );

  it("refuses a stray value and a pnpm `--` separator, naming each", () => {
    expect(() => parseGenerateArgs(["--", "--dry-run", "numbers"])).toThrow(/^Unknown arguments "--", "numbers";/);
  });

  it("lists every flag the generator reads", () => {
    expect(() => parseGenerateArgs(["--force"])).toThrow(
      "Valid flags: --dry-run, --voice <name>[,<name>...], --group <name>[,<name>...], --entry <name>[,<name>...], --import <dir>",
    );
  });

  it("still reports a scope or import value error first", () => {
    expect(() => parseGenerateArgs(["--group"])).toThrow(/--group: expected a name/);
    expect(() => parseGenerateArgs(["--import"])).toThrow(/--import: expected a directory/);
  });
});
