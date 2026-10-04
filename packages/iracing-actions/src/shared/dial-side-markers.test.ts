import { describe, expect, it } from "vitest";

import { renderSideMarkers, resolveSideMarks } from "./dial-side-markers.js";

describe("resolveSideMarks", () => {
  it("reads a one-sided marker as that side lit and the other dimmed", () => {
    expect(resolveSideMarks("left")).toEqual({ left: true, right: false });
    expect(resolveSideMarks("right")).toEqual({ left: false, right: true });
  });

  it("passes a per-side marker through", () => {
    expect(resolveSideMarks({ left: true, right: true })).toEqual({ left: true, right: true });
    expect(resolveSideMarks({ left: false, right: false })).toEqual({ left: false, right: false });
  });
});

describe("renderSideMarkers", () => {
  const args = { width: 200, labelY: 28, labelFontSize: 15, color: "#abcdef" };

  it("always draws both triangles, outward-pointing, in the given color", () => {
    const svg = renderSideMarkers({ ...args, marks: { left: true, right: true } });

    expect(svg.match(/<polygon/g)).toHaveLength(2);
    expect(svg).toContain('data-side="left"');
    expect(svg).toContain('data-side="right"');
    expect(svg.match(/fill="#abcdef"/g)).toHaveLength(2);
  });

  it("dims exactly the unlit sides", () => {
    const dimmed = (marks: { left: boolean; right: boolean }): string[] =>
      (renderSideMarkers({ ...args, marks }).match(/<polygon[^>]*>/g) ?? [])
        .filter((p) => p.includes('opacity="0.22"'))
        .map((p) => /data-side="(\w+)"/.exec(p)?.[1] ?? "");

    expect(dimmed({ left: true, right: true })).toEqual([]);
    expect(dimmed({ left: true, right: false })).toEqual(["right"]);
    expect(dimmed({ left: false, right: true })).toEqual(["left"]);
    expect(dimmed({ left: false, right: false })).toEqual(["left", "right"]);
  });
});
