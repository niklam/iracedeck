import { describe, expect, it } from "vitest";

import { boldTextWidth } from "./dial-text-width.js";
import { renderValueNeighbours } from "./dial-value-neighbours.js";

/** A strip-shaped call: a value centred on 100, the room 14..186. */
function render(neighbours: { left: string; right: string }, value = "#12", valueFontSize = 40): string {
  return renderValueNeighbours({
    neighbours,
    value,
    valueFontSize,
    centerX: 100,
    baselineY: 66,
    contentLeft: 14,
    contentRight: 186,
    cap: 18,
    color: "#abcdef",
  });
}

interface Drawn {
  side: string;
  x: number;
  y: number;
  size: number;
  text: string;
}

function drawn(svg: string): Drawn[] {
  return [
    ...svg.matchAll(/<text data-neighbour="(\w+)" x="([\d.]+)" y="(\d+)"[^>]*font-size="(\d+)"[^>]*>([^<]*)<\/text>/g),
  ].map((m) => ({ side: m[1], x: Number(m[2]), y: Number(m[3]), size: Number(m[4]), text: m[5] }));
}

describe("renderValueNeighbours (#801)", () => {
  it("draws the left and right texts on the value's baseline, dimmed in the given colour", () => {
    const svg = render({ left: "#5", right: "#42" });

    expect(drawn(svg)).toMatchObject([
      { side: "left", y: 66, size: 18, text: "#5" },
      { side: "right", y: 66, size: 18, text: "#42" },
    ]);
    expect(svg.match(/fill="#abcdef"/g)).toHaveLength(2);
    expect(svg.match(/opacity="0.45"/g)).toHaveLength(2);
  });

  it("centres each side in the room between the panel's edge and the value, never touching the value", () => {
    const valueHalf = boldTextWidth("#12", 40) / 2;

    for (const n of drawn(render({ left: "#123", right: "#123" }))) {
      const half = boldTextWidth(n.text, n.size) / 2;

      if (n.side === "left") {
        expect(n.x - half).toBeGreaterThanOrEqual(14 - 0.5);
        expect(n.x + half).toBeLessThan(100 - valueHalf);
      } else {
        expect(n.x - half).toBeGreaterThan(100 + valueHalf);
        expect(n.x + half).toBeLessThanOrEqual(186 + 0.5);
      }
    }
  });

  it("draws nothing for an empty side, and nothing at all when both are empty", () => {
    expect(drawn(render({ left: "", right: "#42" })).map((n) => n.side)).toEqual(["right"]);
    expect(drawn(render({ left: "#5", right: "" })).map((n) => n.side)).toEqual(["left"]);
    expect(render({ left: "", right: "" })).toBe("");
  });

  it("shrinks both sides to one size when the value leaves less room", () => {
    // A wider value: "#123" at 40 px is 89 px, leaving 34 px a side.
    const sizes = drawn(render({ left: "#5", right: "#123" }, "#123")).map((n) => n.size);

    expect(sizes[0]).toBe(sizes[1]);
    expect(sizes[0]).toBeLessThan(18);
    expect(sizes[0]).toBe(Math.floor((100 - boldTextWidth("#123", 40) / 2 - 6 - 14) / boldTextWidth("#123", 1)));
  });

  it("drops the pair rather than overlap or shrink below legible", () => {
    expect(render({ left: "#5", right: "#42" }, "1234567", 40)).toBe("");
  });
});
