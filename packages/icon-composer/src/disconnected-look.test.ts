import { describe, expect, it } from "vitest";

import {
  applyDisconnectedLook,
  DISCONNECTED_BADGE,
  DISCONNECTED_DIM_OPACITY,
  disconnectedOverlaySvg,
} from "./disconnected-look.js";
import { dataUriToSvg, isDataUri, svgToDataUri } from "./svg-utils.js";

const KEY_144 =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect width="144" height="144" fill="#2a3a5c"/><circle cx="72" cy="72" r="30" fill="#ff0000"/></svg>';
const KEY_72 =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><circle cx="36" cy="36" r="30" fill="#ff0000"/></svg>';
const SIZE_ONLY =
  '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><circle cx="36" cy="36" r="30" fill="#ff0000"/></svg>';
const PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const dimRect = (x: number, y: number, w: number, h: number, opacity = DISCONNECTED_DIM_OPACITY): string =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000000" fill-opacity="${opacity}"/>`;

/** Every element name used in a snippet. */
function elementNames(svg: string): Set<string> {
  return new Set([...svg.matchAll(/<([a-zA-Z][\w:-]*)/g)].map((m) => m[1]));
}

describe("applyDisconnectedLook", () => {
  describe("raw SVG", () => {
    it("appends the dim layer and the badge, in that order, before the root close on a 144 canvas", () => {
      const result = applyDisconnectedLook(KEY_144);

      const original = KEY_144.slice(0, -"</svg>".length);

      expect(result).toBe(`${original}${dimRect(0, 0, 144, 144)}${DISCONNECTED_BADGE}</svg>`);
    });

    it("keeps the original image unchanged underneath", () => {
      const result = applyDisconnectedLook(KEY_144);

      expect(result.startsWith(KEY_144.slice(0, -"</svg>".length))).toBe(true);
    });

    it("scales the badge by half on a 72 viewBox", () => {
      const result = applyDisconnectedLook(KEY_72);

      expect(result).toContain(dimRect(0, 0, 72, 72));
      expect(result).toContain(`<g transform="translate(0, 0) scale(0.5)">${DISCONNECTED_BADGE}</g>`);
      expect(result.endsWith("</svg>")).toBe(true);
    });

    it("falls back to the root width and height when there is no viewBox", () => {
      const result = applyDisconnectedLook(SIZE_ONLY);

      expect(result).toContain(dimRect(0, 0, 72, 72));
      expect(result).toContain(`scale(0.5)">${DISCONNECTED_BADGE}</g>`);
    });

    it("accepts px sizes", () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="144px" height="144px"><g/></svg>';

      expect(applyDisconnectedLook(svg)).toContain(dimRect(0, 0, 144, 144));
    });

    it("scales by the shorter side on a non-square canvas", () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><g/></svg>';
      const result = applyDisconnectedLook(svg);

      expect(result).toContain(dimRect(0, 0, 200, 100));
      expect(result).toContain(`scale(${Math.round((100 / 144) * 10000) / 10000})`);
    });

    it("respects a non-zero viewBox origin", () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 20 144 144"><g/></svg>';
      const result = applyDisconnectedLook(svg);

      expect(result).toContain(dimRect(-10, 20, 144, 144));
      expect(result).toContain(`<g transform="translate(-10, 20) scale(1)">${DISCONNECTED_BADGE}</g>`);
    });

    it("reads the root's viewBox, not a nested svg's", () => {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><svg viewBox="0 0 10 10" width="20" height="20"><rect width="10" height="10"/></svg></svg>';
      const result = applyDisconnectedLook(svg);

      expect(result).toContain(dimRect(0, 0, 144, 144));
      expect(result).not.toContain(dimRect(0, 0, 10, 10));
    });

    it("inserts before the last </svg>, outside any nested svg", () => {
      const nested = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">${nested}</svg>`;
      const result = applyDisconnectedLook(svg);

      expect(result).toContain(`${nested}${dimRect(0, 0, 144, 144)}`);
      expect(result.endsWith(`${DISCONNECTED_BADGE}</svg>`)).toBe(true);
      expect(result.match(/<\/svg>/g)).toHaveLength(2);
    });

    it("decorates an SVG with an XML declaration", () => {
      const svg = `<?xml version="1.0" encoding="UTF-8"?>\n${KEY_144}`;

      expect(applyDisconnectedLook(svg)).toContain(dimRect(0, 0, 144, 144));
    });
  });

  describe("data URI", () => {
    it("round-trips a base64 SVG data URI", () => {
      const result = applyDisconnectedLook(svgToDataUri(KEY_144));

      expect(isDataUri(result)).toBe(true);
      expect(dataUriToSvg(result)).toBe(applyDisconnectedLook(KEY_144));
    });

    it("decorates a plain-text SVG data URI", () => {
      const result = applyDisconnectedLook(`data:image/svg+xml,${encodeURIComponent(KEY_72)}`);

      expect(isDataUri(result)).toBe(true);
      expect(dataUriToSvg(result)).toBe(applyDisconnectedLook(KEY_72));
    });

    it("returns a PNG data URI unchanged", () => {
      expect(applyDisconnectedLook(PNG_DATA_URI)).toBe(PNG_DATA_URI);
    });

    it("returns a malformed SVG data URI unchanged", () => {
      const malformed = "data:image/svg+xml;utf8;base64";

      expect(applyDisconnectedLook(malformed)).toBe(malformed);
    });

    it("returns a data URI of an unplaceable SVG unchanged", () => {
      const uri = svgToDataUri('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>');

      expect(applyDisconnectedLook(uri)).toBe(uri);
    });
  });

  describe("unplaceable input", () => {
    it("returns an SVG with neither a viewBox nor a size unchanged", () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="5"/></svg>';

      expect(applyDisconnectedLook(svg)).toBe(svg);
    });

    it("returns an SVG with a percentage size unchanged", () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><g/></svg>';

      expect(applyDisconnectedLook(svg)).toBe(svg);
    });

    it("returns an SVG with only one dimension unchanged", () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="72"><g/></svg>';

      expect(applyDisconnectedLook(svg)).toBe(svg);
    });

    it("returns an SVG with no closing tag unchanged", () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><g/>';

      expect(applyDisconnectedLook(svg)).toBe(svg);
    });

    it("returns a non-SVG string unchanged", () => {
      expect(applyDisconnectedLook("not an image")).toBe("not an image");
      expect(applyDisconnectedLook("")).toBe("");
    });
  });
});

describe("disconnectedOverlaySvg", () => {
  it("draws the dim layer over the whole box", () => {
    expect(disconnectedOverlaySvg({ x: 0, y: 0, width: 144, height: 144 })).toBe(
      dimRect(0, 0, 144, 144) + DISCONNECTED_BADGE,
    );
  });
});

describe("the badge", () => {
  const allowed = new Set(["g", "rect", "circle", "polygon", "path"]);
  const badge = DISCONNECTED_BADGE;

  it("uses only the SVG Tiny shape set", () => {
    for (const name of elementNames(badge)) {
      expect(allowed).toContain(name);
    }

    expect(badge).not.toMatch(/filter|mask|clip-?path|<style|class=|gradient|<text|url\(/i);
  });

  it("stays in the top-left third of the 144 canvas", () => {
    // Every coordinate the badge draws at sits inside the top-left 48×48,
    // clear of the centre (#612 ⚠), the top-right "A" badge and the title band.
    const numbers = [...badge.matchAll(/\b(?:x|y|cx|cy)="([-\d.]+)"|points="([^"]+)"/g)].flatMap((m) =>
      m[1] !== undefined ? [Number(m[1])] : m[2].split(/[\s,]+/).map(Number),
    );
    const attr = (tag: string, name: string): number => Number(tag.match(new RegExp(`\\b${name}="([-\\d.]+)"`))?.[1]);
    const extents = [...badge.matchAll(/<rect\b[^>]*>/g)].flatMap(([tag]) => [
      attr(tag, "x") + attr(tag, "width"),
      attr(tag, "y") + attr(tag, "height"),
    ]);

    expect(numbers.length).toBeGreaterThan(0);

    for (const value of [...numbers, ...extents]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(48);
    }
  });

  it("leaves no filter, mask, clipPath or <style> in the decorated output", () => {
    expect(applyDisconnectedLook(KEY_144)).not.toMatch(/<filter|<mask|<clipPath|<style/i);
  });

  it("is the approved red plate with a white plug and slash", () => {
    expect(badge).toContain('fill="#c0392b"');
    expect(badge).not.toContain("#1a1a1a");
  });
});
