import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  DIAL_BOX_BASELINE_CANVASES,
  DIAL_BOX_BASELINE_SHAPES,
  DIAL_BOX_MARK_BASELINE_SHAPES,
  dialBoxBaselineKey,
} from "./dial-box-baseline.fixture-cases.js";
import { renderDialBox } from "./dial-box.js";

vi.mock("@iracedeck/deck-core", () => ({
  applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
}));

const BASELINE = JSON.parse(
  readFileSync(new URL("./__fixtures__/dial-box-baseline.json", import.meta.url), "utf-8"),
) as Record<string, string>;

const casesOf = (shapes: typeof DIAL_BOX_BASELINE_SHAPES) =>
  DIAL_BOX_BASELINE_CANVASES.flatMap((canvas) =>
    shapes.map((shape) => [dialBoxBaselineKey(canvas.id, shape.name), canvas, shape.args] as const),
  );

const CASES = casesOf(DIAL_BOX_BASELINE_SHAPES);
const MARK_CASES = casesOf(DIAL_BOX_MARK_BASELINE_SHAPES);

it("has exactly one baseline per shape and canvas", () => {
  expect(Object.keys(BASELINE).sort()).toEqual([...CASES, ...MARK_CASES].map(([key]) => key).sort());
});

describe("a box that passes neither neighbours nor reserveCaptionLine draws what it drew before #801 grew them", () => {
  it.each(CASES)("%s", (key, canvas, args) => {
    expect(renderDialBox(canvas, args)).toBe(BASELINE[key]);
  });
});

describe("a box with the caption mark draws what the mark drew when it was tested (#1437)", () => {
  it.each(MARK_CASES)("%s", (key, canvas, args) => {
    expect(renderDialBox(canvas, args)).toBe(BASELINE[key]);
  });
});
