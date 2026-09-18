import { describe, expect, it } from "vitest";

import type { VoiceConfig } from "./config.ts";
import { formatScope, parseScopeArgs, validateScope } from "./scope.ts";

// Minimal VoiceConfig shape — validateScope reads `groups` keys per voice,
// each group's entry `name`s, and the map's voice ids.
function fakeVoice(groups: Record<string, string[]>): VoiceConfig {
  const shaped = Object.fromEntries(
    Object.entries(groups).map(([group, names]) => [group, names.map((name) => ({ name, text: name }))]),
  );

  return { groups: shaped } as unknown as VoiceConfig;
}

const voiceConfigs = new Map<string, VoiceConfig>([
  ["default", fakeVoice({ acknowledgment: ["got-it"], numbers: ["1", "2"], flags: ["yellow"] })],
  ["titan", fakeVoice({ acknowledgment: ["got-it"], numbers: ["1", "2", "3"], flags: ["yellow"] })],
]);

const unscoped = { voices: null, groups: null, entries: null };

describe("parseScopeArgs", () => {
  it("returns a null scope when no flags are present", () => {
    const { scope, remaining } = parseScopeArgs(["--dry-run"]);

    expect(scope).toEqual(unscoped);
    expect(remaining).toEqual(["--dry-run"]);
  });

  it("parses --group with a value as the next token", () => {
    const { scope, remaining } = parseScopeArgs(["--group", "acknowledgment", "--dry-run"]);

    expect(scope).toEqual({ ...unscoped, groups: ["acknowledgment"] });
    expect(remaining).toEqual(["--dry-run"]);
  });

  // The entry axis (#1127): a slice of one large group, so 21 of 1,110 car
  // numbers can be cut without a temporary config edit or a four-figure run.
  it("parses --entry in both forms, comma-split, repeated and deduped", () => {
    const { scope, remaining } = parseScopeArgs(["--entry", "0,1", "--entry=09, 1", "--dry-run"]);

    expect(scope).toEqual({ ...unscoped, entries: ["0", "1", "09"] });
    expect(remaining).toEqual(["--dry-run"]);
  });

  it("composes --voice, --group and --entry", () => {
    const { scope } = parseScopeArgs(["--voice", "default", "--group", "numbers", "--entry", "1"]);

    expect(scope).toEqual({ voices: ["default"], groups: ["numbers"], entries: ["1"] });
  });

  it("throws when --entry is followed by another flag (does not swallow it)", () => {
    expect(() => parseScopeArgs(["--entry", "--dry-run"])).toThrow(/--entry: expected a name.*looks like a flag/);
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

    expect(scope).toEqual({ voices: ["luca"], groups: ["numbers"], entries: null });
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
    expect(() => validateScope(unscoped, voiceConfigs)).not.toThrow();
  });

  it("accepts known voice and group keys", () => {
    expect(() =>
      validateScope({ ...unscoped, voices: ["default"], groups: ["acknowledgment", "numbers"] }, voiceConfigs),
    ).not.toThrow();
  });

  it("throws on an unknown group with a helpful message", () => {
    expect(() => validateScope({ ...unscoped, groups: ["nope"] }, voiceConfigs)).toThrow(
      /--group: unknown name "nope"\.\n {2}Valid: acknowledgment, flags, numbers/,
    );
  });

  it("throws on an unknown voice with a helpful message", () => {
    expect(() => validateScope({ ...unscoped, voices: ["mystery"] }, voiceConfigs)).toThrow(
      /--voice: unknown name "mystery"\.\n {2}Valid: default, titan/,
    );
  });

  it("lists multiple unknowns in one error", () => {
    expect(() => validateScope({ ...unscoped, groups: ["foo", "bar"] }, voiceConfigs)).toThrow(
      /unknown names "foo", "bar"/,
    );
  });

  // An entry name is checked against the groups the scope would iterate, so
  // a slice that would match nothing is refused up front — on a paid API a
  // run that quietly reports "0 generated" is the failure mode to avoid.
  it("accepts an entry name found in an iterated group", () => {
    expect(() => validateScope({ ...unscoped, entries: ["got-it", "1"] }, voiceConfigs)).not.toThrow();
    expect(() => validateScope({ ...unscoped, groups: ["numbers"], entries: ["1"] }, voiceConfigs)).not.toThrow();
  });

  it("throws on an entry name absent from every iterated group, listing what is there", () => {
    expect(() => validateScope({ ...unscoped, groups: ["flags"], entries: ["1"] }, voiceConfigs)).toThrow(
      /--entry: unknown name "1"\.\n {2}Valid: yellow/,
    );
  });

  it("only counts the entries of the scoped voices", () => {
    // "3" exists in titan's numbers only.
    expect(() => validateScope({ ...unscoped, voices: ["titan"], entries: ["3"] }, voiceConfigs)).not.toThrow();
    expect(() => validateScope({ ...unscoped, voices: ["default"], entries: ["3"] }, voiceConfigs)).toThrow(
      /--entry: unknown name "3"/,
    );
  });
});

describe("formatScope", () => {
  it("returns null when no filter is active", () => {
    expect(formatScope(unscoped)).toBeNull();
  });

  it("includes only the populated axes", () => {
    expect(formatScope({ ...unscoped, voices: ["default"] })).toBe("voices=default");
    expect(formatScope({ ...unscoped, groups: ["a", "b"] })).toBe("groups=a,b");
    expect(formatScope({ ...unscoped, voices: ["default"], groups: ["numbers"] })).toBe(
      "voices=default, groups=numbers",
    );
    expect(formatScope({ voices: ["default"], groups: ["car-number"], entries: ["0", "09"] })).toBe(
      "voices=default, groups=car-number, entries=0,09",
    );
  });
});
