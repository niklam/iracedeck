import { describe, expect, it } from "vitest";

import { CORNER_DATA_ATTRIBUTION, listCornerNames, resolveCornerMarkers } from "./index.js";

describe("resolveCornerMarkers", () => {
  it("resolves a known track by its exact iRacing TrackName", () => {
    const markers = resolveCornerMarkers("bathurst");

    expect(markers).not.toBeNull();
    expect(markers![0]).toEqual({ startPct: 0.046, name: "Hell Corner", slug: "hell-corner" });
    // Sorted ascending by startPct.
    const pcts = markers!.map((m) => m.startPct);
    expect([...pcts].sort((a, b) => a - b)).toEqual(pcts);
  });

  it("matches case- and separator-insensitively", () => {
    // Dataset stores "cota-gp" (hyphen outlier); iRacing reports "cota gp".
    expect(resolveCornerMarkers("cota gp")).not.toBeNull();
    expect(resolveCornerMarkers("BATHURST")).not.toBeNull();
  });

  it("returns null for unknown or empty track names", () => {
    expect(resolveCornerMarkers("some future dlc track")).toBeNull();
    expect(resolveCornerMarkers("")).toBeNull();
  });
});

describe("listCornerNames", () => {
  it("returns the deduplicated name set with stable slugs", () => {
    const names = listCornerNames();

    expect(names.length).toBeGreaterThan(400);
    expect(names).toContainEqual({ name: "Hell Corner", slug: "hell-corner" });
    // No duplicate slugs — one clip per name.
    expect(new Set(names.map((n) => n.slug)).size).toBe(names.length);
  });
});

describe("CORNER_DATA_ATTRIBUTION", () => {
  it("carries the grant-mandated credits", () => {
    expect(CORNER_DATA_ATTRIBUTION.sourceName).toBe("Lovely Sim Racing");
    expect(CORNER_DATA_ATTRIBUTION.sourceUrl).toBe("https://github.com/Lovely-Sim-Racing/lovely-track-data");
    expect(CORNER_DATA_ATTRIBUTION.license).toBe("CC BY-NC-SA 4.0");
    expect(CORNER_DATA_ATTRIBUTION.namesCredit).toBe("Racing Circuits");
  });
});
