import { describe, expect, it } from "vitest";

import {
  allCarNumbers,
  buildCarNumberGroup,
  CAR_NUMBER_LEAD_IN_REF,
  readCarNumber,
  spliceGroupIntoConfig,
} from "../scripts/generate-car-numbers.mjs";

// The reading rules are the maintainer's ruling for issue #1127 (2026-09-17),
// one case per row of the spec's table — every number iRacing can put on a
// car is read exactly as the sim spells it, so "09" and "9" (and "009") are
// different clips with different readings.
describe("readCarNumber", () => {
  it.each([
    // One digit
    ["5", "five"],
    ["0", "zero"],
    // Two digits
    ["49", "forty-nine"],
    ["10", "ten"],
    // Leading zero (two digits)
    ["09", "oh nine"],
    ["00", "double oh"],
    // Three digits
    ["119", "one nineteen"],
    ["275", "two seventy-five"],
    ["105", "one oh five"],
    ["100", "one hundred"],
    ["110", "one ten"],
    // Zero + two digits (three digits, leading zero, non-zero tens digit)
    ["099", "oh ninety-nine"],
    ["050", "oh fifty"],
    // Double zero + digit (three digits, two leading zeros)
    ["009", "double oh nine"],
    ["000", "triple oh"],
  ])("reads %s as %s", (numStr, expected) => {
    expect(readCarNumber(numStr)).toBe(expected);
  });

  it("throws on a number string of the wrong width", () => {
    expect(() => readCarNumber("1234")).toThrow(/unsupported/);
    expect(() => readCarNumber("")).toThrow(/unsupported/);
  });
});

describe("allCarNumbers", () => {
  const numbers = allCarNumbers();

  // 0-9 (10) + 00-99 (100) + 000-999 (1000) = 1,110 — every number iRacing
  // can produce, in every width it can be padded to.
  it("produces exactly 1,110 numbers", () => {
    expect(numbers).toHaveLength(1110);
  });

  it("produces unique numbers", () => {
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("includes every width", () => {
    expect(numbers).toContain("5");
    expect(numbers).toContain("09");
    expect(numbers).toContain("099");
  });
});

describe("buildCarNumberGroup", () => {
  const group = buildCarNumberGroup();

  it("produces exactly 1,110 entries", () => {
    expect(group).toHaveLength(1110);
  });

  it("names each entry the number string exactly", () => {
    for (const entry of group) {
      expect(entry.name).toMatch(/^\d{1,3}$/);
      expect(entry.text.length).toBeGreaterThan(0);
    }
  });

  it("produces unique names", () => {
    const names = group.map((entry) => entry.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it("carries no leftover 'car'/'number' wording — the number alone", () => {
    for (const entry of group) {
      expect(entry.text).not.toMatch(/\bcar\b/i);
      expect(entry.text).not.toMatch(/\bnumber\b/i);
    }
  });

  // A number is only ever spliced onto the end of a caution lead-in, so every
  // entry is conditioned on that lead-in through its request-id — and ONLY
  // the request-id: no `previous_text` beside it (redundant with the real
  // preceding audio), and the lead-in must not point back with a
  // `next_request_ids`, which would close a reference cycle the generator
  // refuses. The reference is the `<group>/<entry-name>` form the generator
  // resolves per voice.
  it("conditions every entry on the caution lead-in by request-id reference, and nothing else", () => {
    expect(CAR_NUMBER_LEAD_IN_REF).toBe("caution/one-to-go-outside-01");

    for (const entry of group) {
      expect(entry.previous_request_ids).toEqual([CAR_NUMBER_LEAD_IN_REF]);
      expect(entry).not.toHaveProperty("previous_text");
      expect(entry).not.toHaveProperty("next_request_ids");
      expect(entry).not.toHaveProperty("next_text");
    }
  });
});

// Issue #1127 fix round 1: `main()` used to `JSON.parse` the whole config,
// mutate it, and `JSON.stringify` it back out — which re-expanded 211
// unrelated hand-authored compact arrays elsewhere in the file (e.g.
// `"sequence": ["pool:flags/yellow-local"]` under `scenarios`), because
// `JSON.stringify` has no notion of "this array was already on one line".
// `spliceGroupIntoConfig` is the format-preserving replacement: it edits only
// the `groups.<name>` text and must never touch a single byte outside it.
describe("spliceGroupIntoConfig", () => {
  // A minimal fixture with the two shapes that matter: a `groups` object
  // with an existing group (to prove insertion doesn't disturb it) and a
  // hand-authored COMPACT array in `scenarios` (to prove it survives).
  const fixture = [
    "{",
    '  "groups": {',
    '    "acknowledgment": [',
    "      {",
    '        "name": "got-it",',
    '        "text": "Got it."',
    "      }",
    "    ]",
    "  },",
    '  "scenarios": {',
    '    "pit-crew.flag-green": {',
    '      "sequence": ["pool:flags/yellow-local"]',
    "    }",
    "  }",
    "}",
  ].join("\n");

  const carNumberEntries = [
    { name: "0", text: "zero", seed: 1 },
    { name: "1", text: "one", seed: 1 },
  ];

  it("inserts a new group as valid JSON with exactly the given entries", () => {
    const result = spliceGroupIntoConfig(fixture, "car-number", carNumberEntries);
    const parsed = JSON.parse(result);

    expect(parsed.groups["car-number"]).toEqual(carNumberEntries);
  });

  it("leaves every other group untouched when inserting", () => {
    const result = spliceGroupIntoConfig(fixture, "car-number", carNumberEntries);
    const parsed = JSON.parse(result);

    expect(parsed.groups.acknowledgment).toEqual([{ name: "got-it", text: "Got it." }]);
  });

  it("never touches a hand-authored compact array elsewhere in the document", () => {
    const result = spliceGroupIntoConfig(fixture, "car-number", carNumberEntries);

    // Byte-for-byte survival, not just equivalent JSON — a round-trip
    // through JSON.stringify would still parse to the same VALUE while
    // silently expanding this exact line to three.
    expect(result).toContain('"sequence": ["pool:flags/yellow-local"]');
  });

  it("touches nothing outside the groups object at all", () => {
    const result = spliceGroupIntoConfig(fixture, "car-number", carNumberEntries);
    const scenariosText = fixture.slice(fixture.indexOf('"scenarios"'));

    expect(result.slice(result.indexOf('"scenarios"'))).toBe(scenariosText);
  });

  it("replaces an existing group's value in place on a second run, still leaving scenarios untouched", () => {
    const firstPass = spliceGroupIntoConfig(fixture, "car-number", carNumberEntries);
    const updatedEntries = [{ name: "0", text: "oh-zero (retagged)", seed: 1 }];
    const secondPass = spliceGroupIntoConfig(firstPass, "car-number", updatedEntries);
    const parsed = JSON.parse(secondPass);

    expect(parsed.groups["car-number"]).toEqual(updatedEntries);
    expect(parsed.groups.acknowledgment).toEqual([{ name: "got-it", text: "Got it." }]);
    expect(secondPass).toContain('"sequence": ["pool:flags/yellow-local"]');
  });

  it("round-trips the real config's car-number group without touching anything outside groups", () => {
    // The end-to-end case: splice the actual 1,110-entry group into a
    // snapshot of the real (pre-car-number) config text and prove the
    // "scenarios" section — where the compact-array regression actually
    // happened — is untouched byte-for-byte.
    const before = [
      "{",
      '  "groups": {',
      '    "corner-names": [',
      '      { "name": "turn-1", "text": "Turn one." }',
      "    ]",
      "  },",
      '  "scenarios": {',
      '    "pit-crew.flag-green": { "sequence": ["pool:flags/yellow-local"] },',
      '    "pit-crew.flag-checkered": { "skip": true }',
      "  },",
      '  "frames": { "radio": { "open": ["sfx/IRD-tick-open.mp3"] } }',
      "}",
    ].join("\n");

    const group = buildCarNumberGroup();
    const after = spliceGroupIntoConfig(before, "car-number", group);
    const parsed = JSON.parse(after);

    expect(parsed.groups["car-number"]).toEqual(group);
    expect(after.slice(after.indexOf('"scenarios"'))).toBe(before.slice(before.indexOf('"scenarios"')));
  });
});
