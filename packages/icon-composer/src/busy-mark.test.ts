import { describe, expect, it } from "vitest";

import { BUSY_MARK_FRAMES, BUSY_NOT_DONE_COLOR, type BusyMark, busyMarkSvg } from "./busy-mark.js";
import type { GraphicArea } from "./title-settings.js";

/** The whole 144-unit canvas less its padding: a key with no title. */
const FULL: GraphicArea = { x: 8, y: 8, width: 128, height: 128 };
/** A one-line bottom title at the default font. */
const ONE_LINE: GraphicArea = { x: 8, y: 8, width: 128, height: 105 };
/** Two title lines at a large font: little room left. */
const CRAMPED: GraphicArea = { x: 8, y: 8, width: 128, height: 46 };

const MARKS: BusyMark[] = [{ kind: "working", step: 0 }, { kind: "waiting" }, { kind: "not-done" }];

interface Circle {
  cx: number;
  cy: number;
  r: number;
  opacity?: number;
}

function circles(svg: string): Circle[] {
  return [...svg.matchAll(/<circle ([^>]*)\/>/g)].map(([, attrs]) => {
    const read = (name: string) => {
      const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));

      return m ? Number(m[1]) : undefined;
    };

    return { cx: read("cx")!, cy: read("cy")!, r: read("r")!, opacity: read("opacity") };
  });
}

function newest(svg: string): number {
  return circles(svg).findIndex((c) => c.opacity === 1);
}

describe("busyMarkSvg", () => {
  describe("the safe SVG feature set", () => {
    it.each(MARKS)("draws $kind from circles, lines and groups only", (mark) => {
      for (const area of [FULL, ONE_LINE, CRAMPED]) {
        const svg = busyMarkSvg(mark, area, "#ffffff");

        expect(svg).not.toMatch(/filter|mask|clip-?path|style|class=/i);
        expect([...svg.matchAll(/<([a-zA-Z]+)/g)].map((m) => m[1]).every((tag) => /^(g|circle|line)$/.test(tag))).toBe(
          true,
        );
      }
    });
  });

  describe("working", () => {
    it("draws eight dots with one newest dot one unit larger", () => {
      const dots = circles(busyMarkSvg({ kind: "working", step: 0 }, FULL, "#fff"));

      expect(dots).toHaveLength(BUSY_MARK_FRAMES);
      expect(dots[0]).toMatchObject({ r: 8, opacity: 1 });
      expect(dots.slice(1).every((d) => d.r === 7)).toBe(true);
      expect(dots.map((d) => d.opacity)).toEqual([1, 0.2, 0.2, 0.2, 0.2, 0.3, 0.45, 0.7]);
    });

    it("puts dot 0 at the top and goes clockwise around the area's centre", () => {
      const dots = circles(busyMarkSvg({ kind: "working", step: 0 }, FULL, "#fff"));

      // radius = 128 / 2 - 7 - 1 = 56 around (72, 72)
      expect(dots[0]).toMatchObject({ cx: 72, cy: 16 });
      expect(dots[2]).toMatchObject({ cx: 128, cy: 72 });
      expect(dots[4]).toMatchObject({ cx: 72, cy: 128 });
      expect(dots[6]).toMatchObject({ cx: 16, cy: 72 });
      expect(dots[1].cx).toBeCloseTo(72 + 56 * Math.SQRT1_2, 1);
      expect(dots[1].cy).toBeCloseTo(72 - 56 * Math.SQRT1_2, 1);
    });

    it("moves the newest dot with the step", () => {
      for (let step = 0; step < BUSY_MARK_FRAMES; step++) {
        expect(newest(busyMarkSvg({ kind: "working", step }, FULL, "#fff"))).toBe(step);
      }
    });

    it("draws step n and step n + 8 as the same text, negative steps included", () => {
      const draw = (step: number) => busyMarkSvg({ kind: "working", step }, ONE_LINE, "#fff");

      for (let step = 0; step < BUSY_MARK_FRAMES; step++) {
        expect(draw(step + BUSY_MARK_FRAMES)).toBe(draw(step));
        expect(draw(step + 3 * BUSY_MARK_FRAMES)).toBe(draw(step));
      }

      expect(draw(-1)).toBe(draw(7));
      expect(draw(-9)).toBe(draw(7));
      expect(draw(-0)).toBe(draw(0));
    });

    it("gives every frame a different text", () => {
      const frames = new Set(
        Array.from({ length: BUSY_MARK_FRAMES }, (_, step) => busyMarkSvg({ kind: "working", step }, FULL, "#fff")),
      );

      expect(frames.size).toBe(BUSY_MARK_FRAMES);
    });

    it("fills the dots with the colour given", () => {
      const svg = busyMarkSvg({ kind: "working", step: 2 }, FULL, "#12ab34");

      expect(svg.split('fill="#12ab34"').length - 1).toBe(BUSY_MARK_FRAMES);
    });

    it("rounds coordinates to two decimals", () => {
      const svg = busyMarkSvg(
        { kind: "working", step: 0 },
        { x: 8, y: 8, width: 128, height: 61.80000000000001 },
        "#f",
      );

      for (const n of svg.match(/-?\d+\.\d+/g) ?? []) {
        expect(n.split(".")[1].length).toBeLessThanOrEqual(2);
      }
    });
  });

  describe("waiting", () => {
    it("draws three still dots of r=9 in a row, centred", () => {
      const dots = circles(busyMarkSvg({ kind: "waiting" }, ONE_LINE, "#abcdef"));

      expect(dots).toEqual([
        { cx: 46, cy: 60.5, r: 9, opacity: undefined },
        { cx: 72, cy: 60.5, r: 9, opacity: undefined },
        { cx: 98, cy: 60.5, r: 9, opacity: undefined },
      ]);
      expect(busyMarkSvg({ kind: "waiting" }, ONE_LINE, "#abcdef").split('fill="#abcdef"').length - 1).toBe(3);
    });
  });

  describe("not done", () => {
    it("draws a round-capped red cross whatever the colour given", () => {
      const svg = busyMarkSvg({ kind: "not-done" }, FULL, "#00ff00");

      expect(svg).not.toContain("#00ff00");
      expect(svg.match(/<line /g)).toHaveLength(2);
      expect(svg.split(`stroke="${BUSY_NOT_DONE_COLOR}"`).length - 1).toBe(2);
      expect(BUSY_NOT_DONE_COLOR).toBe("#e74c3c");
      expect(svg).toContain('stroke-width="12"');
      expect(svg).toContain('stroke-linecap="round"');
      // half-size = 128 / 2 - 10 = 54 around (72, 72)
      expect(svg).toContain('<line x1="18" y1="18" x2="126" y2="126"');
      expect(svg).toContain('<line x1="18" y1="126" x2="126" y2="18"');
    });
  });

  describe("small areas", () => {
    /** The extent of a mark's drawing, stroke and dot radii included. */
    function extent(svg: string): { minX: number; maxX: number; minY: number; maxY: number } {
      const xs: number[] = [];
      const ys: number[] = [];

      for (const c of circles(svg)) {
        xs.push(c.cx - c.r, c.cx + c.r);
        ys.push(c.cy - c.r, c.cy + c.r);
      }

      for (const [, attrs] of svg.matchAll(/<line ([^>]*)\/>/g)) {
        const n = (name: string) => Number(attrs.match(new RegExp(`\\b${name}="([^"]*)"`))![1]);
        const half = n("stroke-width") / 2;

        xs.push(n("x1") - half, n("x1") + half, n("x2") - half, n("x2") + half);
        ys.push(n("y1") - half, n("y1") + half, n("y2") - half, n("y2") + half);
      }

      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    }

    const areas: GraphicArea[] = [
      FULL,
      ONE_LINE,
      { x: 8, y: 8, width: 128, height: 72 },
      { x: 8, y: 8, width: 128, height: 61.8 },
      CRAMPED,
      { x: 8, y: 8, width: 128, height: 20 },
      { x: 30, y: 40, width: 40, height: 40 },
    ];

    it.each(MARKS)("keeps $kind inside the area", (mark) => {
      for (const area of areas) {
        const box = extent(busyMarkSvg(mark, area, "#fff"));

        expect(box.minX).toBeGreaterThanOrEqual(area.x - 0.01);
        expect(box.maxX).toBeLessThanOrEqual(area.x + area.width + 0.01);
        expect(box.minY).toBeGreaterThanOrEqual(area.y - 0.01);
        expect(box.maxY).toBeLessThanOrEqual(area.y + area.height + 0.01);
      }
    });

    it("keeps the authored sizes while the smaller side is at least 72", () => {
      for (const area of [FULL, ONE_LINE, { x: 8, y: 8, width: 128, height: 72 }]) {
        expect(circles(busyMarkSvg({ kind: "working", step: 0 }, area, "#fff")).map((d) => d.r)).toEqual([
          8,
          7,
          7,
          7,
          7,
          7,
          7,
          7,
        ]);
        expect(circles(busyMarkSvg({ kind: "waiting" }, area, "#fff")).map((d) => d.r)).toEqual([9, 9, 9]);
        expect(busyMarkSvg({ kind: "not-done" }, area, "#fff")).toContain('stroke-width="12"');
      }
    });

    it("shrinks every length in proportion below that", () => {
      // side 36 is half of 72: every length halves
      const area = { x: 8, y: 8, width: 128, height: 36 };
      const ring = circles(busyMarkSvg({ kind: "working", step: 0 }, area, "#fff"));

      expect(ring.map((d) => d.r)).toEqual([4, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5]);
      // radius = 36 / 2 - 3.5 - 0.5 = 14 around (72, 26)
      expect(ring[0]).toMatchObject({ cx: 72, cy: 12 });
      expect(circles(busyMarkSvg({ kind: "waiting" }, area, "#fff"))).toEqual([
        { cx: 59, cy: 26, r: 4.5, opacity: undefined },
        { cx: 72, cy: 26, r: 4.5, opacity: undefined },
        { cx: 85, cy: 26, r: 4.5, opacity: undefined },
      ]);
      expect(busyMarkSvg({ kind: "not-done" }, area, "#fff")).toContain('stroke-width="6"');
    });

    it("draws nothing in an area with no room", () => {
      for (const mark of MARKS) {
        expect(busyMarkSvg(mark, { x: 8, y: 8, width: 128, height: 0 }, "#fff")).toBe("");
        expect(busyMarkSvg(mark, { x: 8, y: 8, width: 128, height: -4 }, "#fff")).toBe("");
      }
    });
  });
});
