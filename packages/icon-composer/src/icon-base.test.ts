import { describe, expect, it } from "vitest";

import { extractGraphicContent } from "./icon-base.js";

describe("extractGraphicContent", () => {
  it("strips the svg wrapper and desc metadata", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 72">
  <desc>{"colors":{"backgroundColor":"#1a2a3a"}}</desc>
  <circle cx="48" cy="36" r="20" fill="{{graphic1Color}}"/>
</svg>`;
    const result = extractGraphicContent(svg);
    expect(result).not.toContain("<svg");
    expect(result).not.toContain("<desc>");
    expect(result).toContain('<circle cx="48" cy="36" r="20"');
  });

  it("preserves gradient and filter defs used by rich artwork (#827)", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 72">
  <desc>{}</desc>
  <defs>
    <linearGradient id="mtl"><stop stop-color="{{graphic1Color}}"/><stop offset="1" stop-color="{{graphic1Color}}" stop-opacity="0.55"/></linearGradient>
    <filter id="glow"><feGaussianBlur stdDeviation="3"/></filter>
  </defs>
  <rect x="10" y="10" width="20" height="20" fill="url(#mtl)"/>
</svg>`;
    const result = extractGraphicContent(svg);
    expect(result).toContain('<linearGradient id="mtl">');
    expect(result).toContain('<filter id="glow">');
    expect(result).toContain('fill="url(#mtl)"');
  });

  it("still strips a legacy activity-state defs block", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <defs><filter id="activity-state"><feColorMatrix type="saturate" values="1"/></filter></defs>
  <g filter="url(#activity-state)">
    <circle cx="72" cy="72" r="30" fill="#fff"/>
  </g>
</svg>`;
    const result = extractGraphicContent(svg);
    expect(result).not.toContain("activity-state");
    expect(result).toContain('<circle cx="72" cy="72" r="30"');
  });
});
