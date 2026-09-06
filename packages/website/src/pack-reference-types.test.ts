import { describe, expect, it } from "vitest";

import reference from "./data/pack-reference.json";
import {
  PackReferenceShapeError,
  parseCallouts,
  parsePackReference,
  parseRecordingScript,
  parseVocabulary,
} from "./pack-reference-types.js";

/** A deep copy the tests can mutate without touching the imported module's object. */
function copy(): Record<string, any> {
  return structuredClone(reference) as Record<string, any>;
}

describe("the committed artifact", () => {
  it("has the shape the reference pages render", () => {
    const parsed = parsePackReference(reference);

    expect(parsed.generatedFrom.catalogVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(parsed.callouts.length).toBeGreaterThan(100);
    expect(parsed.vocabulary.vars.length).toBeGreaterThan(0);
    expect(parsed.vocabulary.conds.length).toBeGreaterThan(0);
    expect(parsed.vocabulary.cases.length).toBeGreaterThan(0);
    expect(parsed.recordingScript.length).toBeGreaterThan(0);
  });

  it("returns the values it was given, not a re-shaped copy", () => {
    const parsed = parsePackReference(reference);

    expect(parsed).toEqual(reference);
  });

  // The three pages each parse only the slice they render, so the slice
  // parsers have to accept exactly what the whole-document parser accepts.
  it("parses slice by slice the same as whole", () => {
    const whole = parsePackReference(reference);

    expect(parseCallouts(reference.callouts)).toEqual(whole.callouts);
    expect(parseVocabulary(reference.vocabulary)).toEqual(whole.vocabulary);
    expect(parseRecordingScript(reference.recordingScript)).toEqual(whole.recordingScript);
  });

  it("carries every take's text on every recording line", () => {
    for (const group of parsePackReference(reference).recordingScript) {
      for (const line of group.lines) {
        expect(line.texts.length, `${group.group}/${line.base}`).toBeLessThanOrEqual(line.takes);
      }
    }
  });

  it("names a case's declared keys with a description each", () => {
    for (const item of parsePackReference(reference).vocabulary.cases) {
      expect(Object.keys(item.keys).length, item.name).toBeGreaterThan(0);

      for (const [key, description] of Object.entries(item.keys)) {
        expect(description.length, `${item.name}.${key}`).toBeGreaterThan(0);
      }
    }
  });
});

// Positive controls: the parser has to FAIL on the drifts it exists to catch,
// naming the path — a validator that accepts everything would pass the tests
// above just as well.
describe("parsePackReference", () => {
  it("refuses a recording line in the old shape, naming the key that no longer exists", () => {
    const drifted = copy();
    const line = drifted.recordingScript[0].lines[0];
    line.text = line.texts[0] ?? null;
    delete line.texts;

    expect(() => parsePackReference(drifted)).toThrow(PackReferenceShapeError);
    expect(() => parsePackReference(drifted)).toThrow("recordingScript[0].lines[0].text: unrecognized key");
  });

  it("refuses a recording line with no take texts", () => {
    const drifted = copy();
    delete drifted.recordingScript[0].lines[0].texts;

    expect(() => parsePackReference(drifted)).toThrow("recordingScript[0].lines[0].texts: expected an array");
  });

  it("refuses a key the type does not declare, at its own path", () => {
    const drifted = copy();
    drifted.callouts[0].extra = "stray";

    expect(() => parsePackReference(drifted)).toThrow("callouts[0].extra: unrecognized key");
  });

  it("refuses a callout whose family is neither a string nor null", () => {
    const drifted = copy();
    drifted.callouts[2].family = 7;

    expect(() => parsePackReference(drifted)).toThrow("callouts[2].family: expected a string");
  });

  it("refuses a case key whose description is not a string", () => {
    const drifted = copy();
    const item = drifted.vocabulary.cases[0];
    const key = Object.keys(item.keys)[0];
    item.keys[key] = null;

    expect(() => parsePackReference(drifted)).toThrow(`vocabulary.cases[0].keys.${key}: expected a string`);
  });

  it("refuses a weight that is not an integer", () => {
    const drifted = copy();
    drifted.callouts[0].weight = "70";

    expect(() => parsePackReference(drifted)).toThrow("callouts[0].weight: expected an integer");
  });

  it("refuses a document that is not an object", () => {
    expect(() => parsePackReference(null)).toThrow("(document): expected an object");
    expect(() => parsePackReference([])).toThrow("(document): expected an object");
  });

  it("refuses a missing top-level slice", () => {
    const drifted = copy();
    delete drifted.vocabulary;

    expect(() => parsePackReference(drifted)).toThrow("vocabulary: expected an object");
  });
});
