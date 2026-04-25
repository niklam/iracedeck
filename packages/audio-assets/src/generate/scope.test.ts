import { describe, expect, it } from "vitest";

import type { Config } from "./config.ts";
import { formatScope, parseScopeArgs, validateScope } from "./scope.ts";

// Minimal Config shape — validateScope only reads keys of voices/groups.
const config = {
  voices: { luca: {}, titan: {} },
  groups: { acknowledgment: [], numbers: [], flags: [] },
} as unknown as Config;

describe("parseScopeArgs", () => {
  it("returns a null scope when no flags are present", () => {
    const { scope, remaining } = parseScopeArgs(["--dry-run"]);

    expect(scope).toEqual({ voices: null, groups: null });
    expect(remaining).toEqual(["--dry-run"]);
  });

  it("parses --group with a value as the next token", () => {
    const { scope, remaining } = parseScopeArgs(["--group", "acknowledgment", "--dry-run"]);

    expect(scope).toEqual({ voices: null, groups: ["acknowledgment"] });
    expect(remaining).toEqual(["--dry-run"]);
  });

  it("parses the --group=value (equals) form", () => {
    const { scope, remaining } = parseScopeArgs(["--group=acknowledgment", "--dry-run"]);

    expect(scope.groups).toEqual(["acknowledgment"]);
    expect(remaining).toEqual(["--dry-run"]);
  });

  it("splits comma-separated values and trims whitespace", () => {
    const { scope } = parseScopeArgs(["--group", "acknowledgment, numbers ,flags"]);

    expect(scope.groups).toEqual(["acknowledgment", "numbers", "flags"]);
  });

  it("unions repeated flags and dedupes", () => {
    const { scope } = parseScopeArgs(["--group", "a", "--group=b,a", "--group", "c"]);

    expect(scope.groups).toEqual(["a", "b", "c"]);
  });

  it("composes --voice and --group", () => {
    const { scope } = parseScopeArgs(["--voice", "luca", "--group", "numbers"]);

    expect(scope).toEqual({ voices: ["luca"], groups: ["numbers"] });
  });

  it("leaves unknown args in remaining", () => {
    const { remaining } = parseScopeArgs(["--dry-run", "--voice", "luca", "--other", "value"]);

    expect(remaining).toEqual(["--dry-run", "--other", "value"]);
  });

  it("throws when --group has no value (last token)", () => {
    expect(() => parseScopeArgs(["--group"])).toThrow(/--group: expected a name/);
  });

  it("throws when --group=<empty> is supplied", () => {
    expect(() => parseScopeArgs(["--group="])).toThrow(/--group: expected a name/);
  });

  it("throws when --group is followed by only commas/whitespace", () => {
    expect(() => parseScopeArgs(["--group", " , , "])).toThrow(/--group: expected a name/);
  });

  it("throws when --group is followed by another flag (does not swallow it)", () => {
    expect(() => parseScopeArgs(["--group", "--dry-run"])).toThrow(/--group: expected a name.*looks like a flag/);
  });

  it("throws when a comma list contains an empty entry", () => {
    expect(() => parseScopeArgs(["--group", "a,,b"])).toThrow(/--group: expected a name/);
  });

  it("does not consume tokens that merely start with --group (e.g. --groups)", () => {
    const { scope, remaining } = parseScopeArgs(["--groups", "ack"]);

    expect(scope.groups).toBeNull();
    expect(remaining).toEqual(["--groups", "ack"]);
  });
});

describe("validateScope", () => {
  it("accepts a null scope", () => {
    expect(() => validateScope({ voices: null, groups: null }, config)).not.toThrow();
  });

  it("accepts known voice and group keys", () => {
    expect(() => validateScope({ voices: ["luca"], groups: ["acknowledgment", "numbers"] }, config)).not.toThrow();
  });

  it("throws on an unknown group with a helpful message", () => {
    expect(() => validateScope({ voices: null, groups: ["nope"] }, config)).toThrow(
      /--group: unknown name "nope"\.\n {2}Valid: acknowledgment, numbers, flags/,
    );
  });

  it("throws on an unknown voice with a helpful message", () => {
    expect(() => validateScope({ voices: ["mystery"], groups: null }, config)).toThrow(
      /--voice: unknown name "mystery"\.\n {2}Valid: luca, titan/,
    );
  });

  it("lists multiple unknowns in one error", () => {
    expect(() => validateScope({ voices: null, groups: ["foo", "bar"] }, config)).toThrow(/unknown names "foo", "bar"/);
  });
});

describe("formatScope", () => {
  it("returns null when no filter is active", () => {
    expect(formatScope({ voices: null, groups: null })).toBeNull();
  });

  it("includes only the populated axes", () => {
    expect(formatScope({ voices: ["luca"], groups: null })).toBe("voices=luca");
    expect(formatScope({ voices: null, groups: ["a", "b"] })).toBe("groups=a,b");
    expect(formatScope({ voices: ["luca"], groups: ["numbers"] })).toBe("voices=luca, groups=numbers");
  });
});
