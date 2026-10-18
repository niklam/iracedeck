import { describe, expect, it, vi } from "vitest";

import {
  labelClearsSideMarks,
  MIN_SIDE_MARK_LABEL_MARGIN,
  sideMarkLabelMargin,
  STRIP_BOX_HEIGHT,
  STRIP_BOX_WIDTH,
} from "./dial-label-fit.js";

vi.mock("@iracedeck/deck-core", () => ({
  applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
}));

// Loaded at collection rather than inside the test: the real deck-core barrel is slow to import.
const { SD_PLUS_STRIP_CANVAS } = await vi.importActual<typeof import("@iracedeck/deck-core")>("@iracedeck/deck-core");

describe("labelClearsSideMarks (#801)", () => {
  it("measures the strip at the size of deck-core's sd-plus-strip profile", () => {
    expect({ width: STRIP_BOX_WIDTH, height: STRIP_BOX_HEIGHT }).toEqual({
      width: SD_PLUS_STRIP_CANVAS.width,
      height: SD_PLUS_STRIP_CANVAS.height,
    });
  });

  it("takes INCIDENT's room on the knob as the least a label may leave, about 10 px", () => {
    // 96 px between the knob's markers (2 × (53 − 5)), INCIDENT 75.55 px at 16 px.
    expect(MIN_SIDE_MARK_LABEL_MARGIN).toBeCloseTo(10.224, 3);
    expect(sideMarkLabelMargin("INCIDENT", "knob")).toBe(MIN_SIDE_MARK_LABEL_MARGIN);
    expect(labelClearsSideMarks("INCIDENT", "knob")).toBe(true);
  });

  it("leaves 110 px between the strip's markers and 96 px between the knob's", () => {
    expect(2 * sideMarkLabelMargin("", "strip")).toBe(110);
    expect(2 * sideMarkLabelMargin("", "knob")).toBe(96);
  });

  it("refuses the long Track Order labels on the knob, and passes TRK ORD", () => {
    // TRACK ORDER runs into the markers; TRK ORDER and TRACK ORD touch them.
    expect(sideMarkLabelMargin("TRACK ORDER", "knob")).toBeLessThan(0);
    expect(labelClearsSideMarks("TRACK ORDER", "knob")).toBe(false);
    expect(labelClearsSideMarks("TRK ORDER", "knob")).toBe(false);
    expect(labelClearsSideMarks("TRACK ORD", "knob")).toBe(false);
    expect(labelClearsSideMarks("TRK ORD", "knob")).toBe(true);
    expect(labelClearsSideMarks("TRK ORD", "strip")).toBe(true);
  });

  it("gives every label the same verdict it measures, a little wider failing where a little narrower passes", () => {
    expect(labelClearsSideMarks("INCIDENTS", "knob")).toBe(false);
    expect(labelClearsSideMarks("INCIDENTS", "strip")).toBe(true);
  });
});
