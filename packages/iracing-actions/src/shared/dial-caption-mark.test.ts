import { describe, expect, it } from "vitest";

import { type CaptionLine, DIAL_NOT_DONE_COLOR, placeMarkedCaption, replayBusyDialMark } from "./dial-caption-mark.js";

// The strip's caption line at 200×100: baseline 88, 13 px, the mark 15 px in.
const LINE: CaptionLine = { width: 200, baselineY: 88, fontSize: 13, left: 15, color: "#3498db" };

// Loaded at collection rather than inside a test: the real deck-core barrel is slow to import.
const { BUSY_NOT_DONE_COLOR } = await import("@iracedeck/deck-core");

function circles(svg: string): string[] {
  return svg.match(/<circle [^>]*\/>/g) ?? [];
}

describe("replayBusyDialMark (#1437)", () => {
  it("is no mark at rest, and the still marks as they are", () => {
    expect(replayBusyDialMark({ kind: "rest" })).toBeUndefined();
    expect(replayBusyDialMark({ kind: "waiting" })).toEqual({ kind: "waiting" });
    expect(replayBusyDialMark({ kind: "not-done" })).toEqual({ kind: "not-done" });
  });

  it("steps the working mark on every second tick of the indicator: 0, 0, 1, 1, 2, 2, 0", () => {
    const positions = Array.from({ length: 13 }, (_, tick) => {
      const mark = replayBusyDialMark({ kind: "working", tick });

      return mark?.kind === "working" ? mark.position : -1;
    });

    expect(positions).toEqual([0, 0, 1, 1, 2, 2, 0, 0, 1, 1, 2, 2, 0]);
  });
});

describe("placeMarkedCaption (#1437)", () => {
  it("draws working as three dots in the caption colour with only the one at `position` bright", () => {
    for (const position of [0, 1, 2] as const) {
      const dots = circles(placeMarkedCaption({ kind: "working", position }, "", LINE).mark);

      expect(dots).toHaveLength(3);
      dots.forEach((dot, i) => {
        expect(dot).toContain('fill="#3498db"');
        expect(dot.includes("opacity")).toBe(i !== position);
      });
    }
  });

  it("draws each working position differently, so every step is a new frame", () => {
    const frames = new Set(
      ([0, 1, 2] as const).map((position) => placeMarkedCaption({ kind: "working", position }, "", LINE).mark),
    );

    expect(frames.size).toBe(3);
  });

  it("draws waiting as three even, still dots", () => {
    const dots = circles(placeMarkedCaption({ kind: "waiting" }, "", LINE).mark);

    expect(dots).toHaveLength(3);
    expect(dots.every((dot) => !dot.includes("opacity") && dot.includes('fill="#3498db"'))).toBe(true);
  });

  it("draws not done as a small cross in the fixed red, whatever the caption colour", () => {
    const svg = placeMarkedCaption({ kind: "not-done" }, "", LINE).mark;

    expect(circles(svg)).toHaveLength(0);
    expect(svg.match(/<line /g)).toHaveLength(2);
    expect(svg.split(`stroke="${DIAL_NOT_DONE_COLOR}"`).length - 1).toBe(2);
    expect(svg).not.toContain("#3498db");
  });

  it("uses deck-core's not-done red", () => {
    expect(DIAL_NOT_DONE_COLOR).toBe(BUSY_NOT_DONE_COLOR);
  });

  it("sits at the caption's height, from the line's left end", () => {
    const svg = placeMarkedCaption({ kind: "waiting" }, "", LINE).mark;
    // Visual centre: baseline 88 less round(13 × 0.36) = 5.
    const ys = circles(svg).map((dot) => Number(/cy="([\d.]+)"/.exec(dot)![1]));
    const xs = circles(svg).map((dot) => Number(/cx="([\d.]+)"/.exec(dot)![1]));
    const r = Number(/ r="([\d.]+)"/.exec(svg)![1]);

    expect(new Set(ys)).toEqual(new Set([83]));
    expect(Math.min(...xs) - r).toBe(15);
  });

  it("uses only circles, lines and opacity", () => {
    const looks = [{ kind: "working", position: 1 }, { kind: "waiting" }, { kind: "not-done" }] as const;

    for (const look of looks) {
      const svg = placeMarkedCaption(look, "", LINE).mark;

      expect(svg).not.toMatch(/filter|mask|clipPath|style=|<style/);
      expect(svg.match(/<(\w+)/g)?.every((tag) => ["<g", "<circle", "<line"].includes(tag))).toBe(true);
    }
  });

  describe("the caption's text beside the mark", () => {
    /** The mark's right edge: left + two spacings + a dot's diameter (13 px: r 2.5, spacing 7). */
    const markRight = 15 + 2 * 7 + 2 * 2.5;

    it("keeps a short text centred, where it was without the mark", () => {
      expect(placeMarkedCaption({ kind: "waiting" }, "+3", LINE)).toMatchObject({ textX: 100, textFontSize: 13 });
    });

    it("moves a wider text right just far enough to clear the mark, at its own size", () => {
      // 17 × 0.6 × 13 = 132.6 wide: centred, its left edge (33.7) would be inside the mark's room.
      const text = "ABCDEFGHIJKLMNOPQ";
      const placed = placeMarkedCaption({ kind: "waiting" }, text, LINE);
      const width = text.length * 0.6 * 13;

      expect(placed.textFontSize).toBe(13);
      expect(placed.textX).toBeGreaterThan(100);
      expect(placed.textX - width / 2).toBeGreaterThan(markRight);
      expect(placed.textX + width / 2).toBeLessThanOrEqual(200 - 15);
    });

    it("shrinks a text too wide for the room beside the mark, and keeps it clear of it", () => {
      const text = "ABCDEFGHIJKLMNOPQRSTU";
      const placed = placeMarkedCaption({ kind: "working", position: 0 }, text, LINE);
      const width = text.length * 0.6 * placed.textFontSize;

      expect(placed.textFontSize).toBeLessThan(13);
      expect(placed.textX - width / 2).toBeGreaterThan(markRight);
      expect(placed.textX + width / 2).toBeLessThanOrEqual(200 - 15);
    });
  });
});
