import { describe, expect, it } from "vitest";

import {
  CALLOUT_SCRIPT_SCHEMA_VERSION,
  NO_FRAME,
  parseCondReference,
  parseStringStep,
  POOL_DEFINITION_NAME_PATTERN,
  POOL_NAME_PATTERN,
  SCENARIO_ID_PATTERN,
} from "./grammar.js";

describe("constants", () => {
  it("pins the schema version and the reserved frame name", () => {
    expect(CALLOUT_SCRIPT_SCHEMA_VERSION).toBe(1);
    expect(NO_FRAME).toBe("none");
  });
});

describe("POOL_NAME_PATTERN", () => {
  it.each(["flag-blue", "a", "0", "fuel-laps-left-10", "flags/blue", "a1/b2-c3"])("accepts %j", (name) => {
    expect(POOL_NAME_PATTERN.test(name)).toBe(true);
  });

  // The pattern is the brief's, verbatim: it anchors the FIRST character only,
  // so a trailing dash (`a-`) is admitted. Pinned here so a tightening is a
  // deliberate change rather than a drift.
  it("admits a trailing dash", () => {
    expect(POOL_NAME_PATTERN.test("a-")).toBe(true);
  });

  it.each(["", "-a", "A", "a b", "a/", "/a", "a/b/c", "a//b", "pool:a", "a_b"])("rejects %j", (name) => {
    expect(POOL_NAME_PATTERN.test(name)).toBe(false);
  });
});

describe("POOL_DEFINITION_NAME_PATTERN", () => {
  it("is the reference pattern without the slash form", () => {
    expect(POOL_DEFINITION_NAME_PATTERN.test("flag-blue")).toBe(true);
    expect(POOL_DEFINITION_NAME_PATTERN.test("flags/blue")).toBe(false);
  });
});

describe("SCENARIO_ID_PATTERN", () => {
  it("wants something non-empty with no whitespace", () => {
    expect(SCENARIO_ID_PATTERN.test("pit-crew.flag-blue")).toBe(true);
    expect(SCENARIO_ID_PATTERN.test("")).toBe(false);
    expect(SCENARIO_ID_PATTERN.test("flag blue")).toBe(false);
    expect(SCENARIO_ID_PATTERN.test(" x")).toBe(false);
  });
});

describe("parseStringStep", () => {
  it("mirrors the DSL shorthand rules exactly", () => {
    expect(parseStringStep("pool:flag-blue")).toEqual({ kind: "pool", name: "flag-blue" });
    expect(parseStringStep("pause:250")).toEqual({ kind: "pause", ms: 250 });
    expect(parseStringStep("@pit-crew.radio-open")).toEqual({ kind: "include", id: "pit-crew.radio-open" });
    expect(parseStringStep("{{position.number}}")).toEqual({ kind: "var", name: "position.number" });
    expect(parseStringStep("flags/blue-1.mp3")).toEqual({ kind: "clip", path: "flags/blue-1.mp3" });
  });

  it("keeps a malformed prefixed form as that form so the schema can name it", () => {
    expect(parseStringStep("pool:")).toEqual({ kind: "pool", name: "" });
    expect(parseStringStep("pause:abc")).toEqual({ kind: "pause", ms: Number.NaN });
    expect(parseStringStep("pause:")).toEqual({ kind: "pause", ms: Number.NaN });
    expect(parseStringStep("@")).toEqual({ kind: "include", id: "" });
    expect(parseStringStep("{{}}")).toEqual({ kind: "var", name: "" });
  });

  it("treats a lone brace pair inside a path as a clip, like the DSL does", () => {
    expect(parseStringStep("{{x}}.mp3")).toEqual({ kind: "clip", path: "{{x}}.mp3" });
  });
});

describe("parseCondReference", () => {
  it("splits the negation off the name", () => {
    expect(parseCondReference("session.isRace")).toEqual({ name: "session.isRace", negated: false });
    expect(parseCondReference("!session.isRace")).toEqual({ name: "session.isRace", negated: true });
  });

  it("strips exactly one bang — `!` is the only operator", () => {
    expect(parseCondReference("!!x")).toEqual({ name: "!x", negated: true });
    expect(parseCondReference("!")).toEqual({ name: "", negated: true });
  });
});
