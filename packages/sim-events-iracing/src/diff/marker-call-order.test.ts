import { describe, expect, it } from "vitest";

import { lapFractionBehind, orderMarkerCalls } from "./marker-call-order.js";
import type { PendingEvent } from "./types.js";

const EARLIER: PendingEvent = { event: "session.changed", data: { from: 0, to: 1 } };
const SECTOR: PendingEvent = { event: "sectorStart.approaching", data: { sector: 3, sectorCount: 5 } };
const CORNER: PendingEvent = { event: "cornerName.approaching", data: { name: "Test Corner", slug: "test-corner" } };

/** A tick's pending list with one earlier step's event before the two marker calls. */
function pendingOf(...markerCalls: PendingEvent[]): PendingEvent[] {
  return [EARLIER, ...markerCalls];
}

describe("lapFractionBehind", () => {
  it("is how far the lead point has passed the start", () => {
    expect(lapFractionBehind(0.75, 0.5)).toBe(0.25);
  });

  it("is 0 for a start at the lead point", () => {
    expect(lapFractionBehind(0.2, 0.2)).toBe(0);
  });

  it("measures across the start/finish line", () => {
    expect(lapFractionBehind(0.0078125, 0.9921875)).toBe(0.015625);
  });
});

describe("orderMarkerCalls", () => {
  it("puts the corner first when its marker was crossed first", () => {
    const pending = pendingOf(SECTOR, CORNER);

    orderMarkerCalls(pending, 1, 0.01, 0.02);

    expect(pending).toEqual([EARLIER, CORNER, SECTOR]);
  });

  it("keeps the sector first when its start was crossed first", () => {
    const pending = pendingOf(SECTOR, CORNER);

    orderMarkerCalls(pending, 1, 0.02, 0.01);

    expect(pending).toEqual([EARLIER, SECTOR, CORNER]);
  });

  it("gives a tie, a corner at the sector line, to the sector call", () => {
    const pending = pendingOf(SECTOR, CORNER);

    orderMarkerCalls(pending, 1, 0.01, 0.01);

    expect(pending).toEqual([EARLIER, SECTOR, CORNER]);
  });

  it.each([
    ["only the sector call published", [SECTOR], 0.01, null],
    ["only the corner name published", [CORNER], null, 0.02],
    ["neither published", [], null, null],
  ])("leaves the list alone when %s", (_label, calls, sectorBehind, cornerBehind) => {
    const pending = pendingOf(...calls);

    orderMarkerCalls(pending, 1, sectorBehind, cornerBehind);

    expect(pending).toEqual(pendingOf(...calls));
  });

  // A step that throws is truncated out of `pending` by the step boundary and
  // never returns, so its value stays null; the corner keeps its place.
  it("leaves the corner alone when the sector step threw", () => {
    const pending = pendingOf(CORNER);

    orderMarkerCalls(pending, 1, null, 0.02);

    expect(pending).toEqual([EARLIER, CORNER]);
  });

  // Defence in depth: values that say both published, over a slice that does
  // not hold exactly the two calls in the steps' order, never move anything.
  it.each([
    ["the corner step's events are missing", [SECTOR]],
    ["a third event follows", [SECTOR, CORNER, EARLIER]],
    ["the slice is not the sector then the corner", [CORNER, SECTOR]],
  ])("leaves the list alone when %s", (_label, calls) => {
    const pending = pendingOf(...calls);

    orderMarkerCalls(pending, 1, 0.01, 0.02);

    expect(pending).toEqual(pendingOf(...calls));
  });

  it("reorders only from the mark, never an earlier step's event", () => {
    const pending = [SECTOR, CORNER, SECTOR, CORNER];

    orderMarkerCalls(pending, 2, 0.01, 0.02);

    expect(pending).toEqual([SECTOR, CORNER, CORNER, SECTOR]);
  });
});
