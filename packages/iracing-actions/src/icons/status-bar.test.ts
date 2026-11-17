import { describe, expect, it } from "vitest";

import { borderColorForState, statusBarNA, statusBarOff, statusBarOn, statusBarSplit } from "./status-bar.js";

describe("statusBarOn", () => {
  it("should return SVG with green fill and ON text", () => {
    const result = statusBarOn();
    expect(result).toContain('fill="#2ecc71"');
    expect(result).toContain(">ON</text>");
  });

  it("should have correct position and dimensions", () => {
    const result = statusBarOn();
    expect(result).toContain('x="0" y="100" width="144" height="44"');
  });
});

describe("statusBarOff", () => {
  it("should return SVG with red fill and OFF text", () => {
    const result = statusBarOff();
    expect(result).toContain('fill="#e74c3c"');
    expect(result).toContain(">OFF</text>");
  });

  it("should have correct position and dimensions", () => {
    const result = statusBarOff();
    expect(result).toContain('x="0" y="100" width="144" height="44"');
  });
});

describe("statusBarNA", () => {
  it("should return SVG with gray fill and N/A text", () => {
    const result = statusBarNA();
    expect(result).toContain('fill="#888888"');
    expect(result).toContain(">N/A</text>");
  });

  it("should have correct position and dimensions", () => {
    const result = statusBarNA();
    expect(result).toContain('x="0" y="100" width="144" height="44"');
  });
});

describe("borderColorForState", () => {
  it("should return green for 'on' state", () => {
    expect(borderColorForState("on")).toBe("#2ecc71");
  });

  it("should return red for 'off' state", () => {
    expect(borderColorForState("off")).toBe("#e74c3c");
  });

  it("should return gray for 'na' state", () => {
    expect(borderColorForState("na")).toBe("#888888");
  });
});

describe("statusBarSplit", () => {
  const GREEN = "#2ecc71";
  const RED = "#e74c3c";

  function halfFills(svg: string): { left: string | undefined; right: string | undefined } {
    const left = /<rect x="0" y="100" width="72" height="44" fill="([^"]+)"\/>/.exec(svg)?.[1];
    const right = /<rect x="72" y="100" width="72" height="44" fill="([^"]+)"\/>/.exec(svg)?.[1];

    return { left, right };
  }

  it.each([
    ["on", "on", GREEN, GREEN],
    ["on", "off", GREEN, RED],
    ["off", "on", RED, GREEN],
    ["off", "off", RED, RED],
  ] as const)("should fill left %s and right %s halves with the state colours", (left, right, leftFill, rightFill) => {
    expect(halfFills(statusBarSplit(left, right, "CORNER", "SECTOR"))).toEqual({ left: leftFill, right: rightFill });
  });

  it("should centre each label in its half", () => {
    const result = statusBarSplit("on", "off", "CORNER", "SECTOR");
    expect(result).toMatch(/<text x="36" y="\d+"[^>]*>CORNER<\/text>/);
    expect(result).toMatch(/<text x="108" y="\d+"[^>]*>SECTOR<\/text>/);
  });

  it("should draw the labels in white bold text smaller than the 20 px ON/OFF", () => {
    const result = statusBarSplit("off", "on", "CORNER", "SECTOR");
    const sizes = [...result.matchAll(/font-size="(\d+)"/g)].map((m) => Number(m[1]));
    expect(sizes).toHaveLength(2);

    for (const size of sizes) {
      expect(size).toBeLessThan(20);
      expect(size).toBeGreaterThan(0);
    }

    expect(result.match(/fill="#ffffff"/g)).toHaveLength(2);
    expect(result.match(/font-weight="bold"/g)).toHaveLength(2);
  });

  it("should cover the same 144x44 area at y 100 as the full-width bars", () => {
    const result = statusBarSplit("on", "off", "CORNER", "SECTOR");
    expect(result).toContain('<rect x="0" y="100" width="72" height="44"');
    expect(result).toContain('<rect x="72" y="100" width="72" height="44"');
  });
});
