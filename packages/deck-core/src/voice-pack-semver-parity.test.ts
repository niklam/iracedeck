import { isSemverVersion } from "@iracedeck/callout-script";
import { valid as semverValid } from "semver";
import { describe, expect, it } from "vitest";

/**
 * The pin behind `isSemverVersion` (#1134).
 *
 * The manifest's version rule used to be `semver.valid(v) !== null` here in
 * deck-core. It moved into `@iracedeck/callout-script` so `lint:pack` could
 * share it, and that leaf stays zod-only, so the rule became a hand-written
 * predicate. It must accept EXACTLY what `semver.valid` accepts — no tighter,
 * or a pack that installs today would be refused; no looser, or the linter
 * would pass a manifest the scanner never did. This file is where that
 * equality is checked, against the real `semver` at the version deck-core
 * pins, over every input whose verdict is not obvious from the semver.org
 * grammar alone: the trim, the `v`, the length cap, the safe-integer ceiling.
 *
 * A `semver` bump that changes a verdict fails here and nowhere else, which
 * is the point: the leaf cannot see `semver`, so deck-core watches it.
 */

/** The measured `semver.valid` behaviour the predicate reproduces beyond the semver.org grammar. */
const SEMVER_QUIRKS = [
  // The input is trimmed first — JS `trim`, so every ECMAScript WhiteSpace
  // and LineTerminator goes, the no-break space and the BOM among them.
  " 1.2.3 ",
  "1.2.3\n",
  "\t1.2.3",
  " 1.2.3",
  "﻿1.2.3",
  "1.2.3 ",
  // One optional leading lowercase `v`, and nothing else in front.
  "v1.2.3",
  "V1.2.3",
  "vv1.2.3",
  "=1.2.3",
  " v1.2.3",
  "v 1.2.3",
  // No leading zeros in the numeric parts, or in a numeric prerelease id; a
  // prerelease id with a letter in it may start with a zero, and build
  // metadata may start with anything.
  "01.2.3",
  "1.02.3",
  "1.2.03",
  "1.2.3-01",
  "1.2.3-0a",
  "1.2.3-0",
  "1.2.3+01",
  "1.2.3+0",
  // Empty identifiers.
  "1.2.3-a..b",
  "1.2.3-",
  "1.2.3+",
  "1.2.3-.a",
  "1.2.3+a.",
  // Major, minor and patch are each at most Number.MAX_SAFE_INTEGER; a
  // prerelease number is not bounded.
  "9007199254740991.0.0",
  "9007199254740992.0.0",
  "0.9007199254740991.0",
  "0.9007199254740992.0",
  "0.0.9007199254740991",
  "0.0.9007199254740992",
  "1.2.3-9007199254740992",
  "99999999999999999999999.999999999999999999.99999999999999999",
  // The 256-character cap, applied BEFORE the trim.
  `1.0.0+${"a".repeat(250)}`,
  `1.0.0+${"a".repeat(251)}`,
  `1.0.0-${"a".repeat(250)}`,
  `1.0.0-${"a".repeat(251)}`,
  `1.2.3${" ".repeat(251)}`,
  `1.2.3${" ".repeat(252)}`,
  `${" ".repeat(252)}1.2.3`,
  // Not versions at all.
  "",
  " ",
  "1",
  "1.2",
  "1.2.3.4",
  "one",
  "1.2.3 beta",
  "1.2.3-beta 1",
  "1.2.3-bétá",
  "1.2.3-a_b",
  "1.2.3+a_b",
  "-1.2.3",
  "1.-2.3",
  "1.2.3-",
  "1.2.3+-",
  "1.2.3-+",
  "1.2.3+a+b",
  "1.2.3-a+b+c",
];

/** The examples semver.org's regex page lists as valid. */
const SEMVER_ORG_VALID = [
  "0.0.4",
  "1.2.3",
  "10.20.30",
  "1.1.2-prerelease+meta",
  "1.1.2+meta",
  "1.1.2+meta-valid",
  "1.0.0-alpha",
  "1.0.0-beta",
  "1.0.0-alpha.beta",
  "1.0.0-alpha.beta.1",
  "1.0.0-alpha.1",
  "1.0.0-alpha0.valid",
  "1.0.0-alpha.0valid",
  "1.0.0-alpha-a.b-c-somethinglong+build.1-aef.1-its-okay",
  "1.0.0-rc.1+build.1",
  "2.0.0-rc.1+build.123",
  "1.2.3-beta",
  "10.2.3-DEV-SNAPSHOT",
  "1.2.3-SNAPSHOT-123",
  "1.0.0",
  "2.0.0",
  "1.1.7",
  "2.0.0+build.1848",
  "2.0.1-alpha.1227",
  "1.0.0-alpha+beta",
  "1.2.3----RC-SNAPSHOT.12.9.1--.12+788",
  "1.2.3----R-S.12.9.1--.12+meta",
  "1.2.3----RC-SNAPSHOT.12.9.1--.12",
  "1.0.0+0.build.1-rc.10000aaa-kk-0.1",
  // Valid per semver.org, refused by `semver` (the safe-integer ceiling) —
  // listed as an input to agree on, not as a verdict.
  "99999999999999999999999.999999999999999999.99999999999999999",
  "1.0.0-0A.is.legal",
];

/** The examples semver.org's regex page lists as invalid. */
const SEMVER_ORG_INVALID = [
  "1",
  "1.2",
  "1.2.3-0123",
  "1.2.3-0123.0123",
  "1.1.2+.123",
  "+invalid",
  "-invalid",
  "-invalid+invalid",
  "-invalid.01",
  "alpha",
  "alpha.beta",
  "alpha.beta.1",
  "alpha.1",
  "alpha+beta",
  "alpha_beta",
  "alpha.",
  "alpha..",
  "beta",
  "1.0.0-alpha_beta",
  "-alpha.",
  "1.0.0-alpha..",
  "1.0.0-alpha..1",
  "1.0.0-alpha...1",
  "1.0.0-alpha....1",
  "1.0.0-alpha.....1",
  "1.0.0-alpha......1",
  "1.0.0-alpha.......1",
  "01.1.1",
  "1.01.1",
  "1.1.01",
  "1.2.3.DEV",
  "1.2-SNAPSHOT",
  "1.2.31.2.3----RC-SNAPSHOT.12.09.1--..12+788",
  "1.2-RC-SNAPSHOT",
  "-1.0.3-gamma+b7718",
  "+justmeta",
  "9.8.7+meta+meta",
  "9.8.7-whatever+meta+meta",
  "99999999999999999999999.999999999999999999.99999999999999999----RC-SNAPSHOT.12.09.1--------------------------------..12",
];

describe("isSemverVersion agrees with semver.valid", () => {
  const inputs = [...new Set([...SEMVER_QUIRKS, ...SEMVER_ORG_VALID, ...SEMVER_ORG_INVALID])];

  it.each(inputs.map((input) => [JSON.stringify(input), input]))("on %s", (_shown, input) => {
    expect(isSemverVersion(input)).toBe(semverValid(input) !== null);
  });

  it("covers both verdicts, so agreement is not vacuous", () => {
    const verdicts = new Set(inputs.map((input) => semverValid(input) !== null));

    expect(verdicts).toEqual(new Set([true, false]));
  });

  it("still refuses what semver.org refuses", () => {
    // semver.org's invalid list is a subset of what `semver` refuses; if a
    // future `semver` accepted one of these, the pin above would move the
    // predicate with it, and this is where that would show.
    for (const input of SEMVER_ORG_INVALID) expect(semverValid(input), input).toBeNull();
  });
});
