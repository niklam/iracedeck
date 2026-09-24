import { describe, expect, it } from "vitest";

import {
  addMarker,
  deleteNearestMarker,
  MARKER_DEDUPE_FRAMES,
  MARKER_DELETE_WINDOW_FRAMES,
  MARKER_NEXT_MIN_AHEAD_FRAMES,
  MARKER_PREVIOUS_MIN_BEHIND_FRAMES,
  nextMarker,
  normalizeMarkers,
  previousMarker,
  type ReplayMarker,
} from "./replay-markers.js";

const marker = (frame: number, sessionNum = 2, sessionTimeMs = frame * 1000): ReplayMarker => ({
  frame,
  sessionNum,
  sessionTimeMs,
});

describe("replay markers (#1162)", () => {
  it("pins the spec's windows, in frames", () => {
    expect(MARKER_DEDUPE_FRAMES).toBe(60);
    expect(MARKER_DELETE_WINDOW_FRAMES).toBe(600);
    expect(MARKER_NEXT_MIN_AHEAD_FRAMES).toBe(60);
    expect(MARKER_PREVIOUS_MIN_BEHIND_FRAMES).toBe(120);
  });

  describe("normalizeMarkers", () => {
    it("orders a loaded section by frame and drops entries that are not markers", () => {
      const raw = [marker(500), { frame: "x" }, null, marker(100), { frame: 300, sessionNum: 1 }, marker(200)];

      expect(normalizeMarkers(raw).map((m) => m.frame)).toEqual([100, 200, 500]);
    });

    it("keeps a field on a marker that this build does not know", () => {
      expect(normalizeMarkers([{ ...marker(5), label: "lift" }])).toEqual([{ ...marker(5), label: "lift" }]);
    });

    it("reads anything that is not an array as no markers", () => {
      expect(normalizeMarkers(undefined)).toEqual([]);
      expect(normalizeMarkers({ frame: 1 })).toEqual([]);
    });
  });

  describe("addMarker", () => {
    it("inserts in frame order and reports the add", () => {
      const markers: ReplayMarker[] = [];

      expect(addMarker(markers, marker(1000))).toBe(true);
      expect(addMarker(markers, marker(200))).toBe(true);
      expect(addMarker(markers, marker(600))).toBe(true);
      expect(markers.map((m) => m.frame)).toEqual([200, 600, 1000]);
    });

    it("does not add a marker within 60 frames of an existing one, on either side", () => {
      const markers = [marker(1000)];

      expect(addMarker(markers, marker(1060))).toBe(false);
      expect(addMarker(markers, marker(940))).toBe(false);
      expect(markers).toHaveLength(1);
    });

    it("adds a marker 61 frames away", () => {
      const markers = [marker(1000)];

      expect(addMarker(markers, marker(1061))).toBe(true);
      expect(markers).toHaveLength(2);
    });

    it("stores a copy, so the caller's object cannot mutate the list", () => {
      const markers: ReplayMarker[] = [];
      const m = marker(10);

      addMarker(markers, m);
      m.frame = 99;
      expect(markers[0]?.frame).toBe(10);
    });
  });

  describe("deleteNearestMarker", () => {
    it("removes and returns the nearest marker within 600 frames", () => {
      const markers = [marker(100), marker(1000), marker(1500)];

      expect(deleteNearestMarker(markers, 1300)?.frame).toBe(1500);
      expect(markers.map((m) => m.frame)).toEqual([100, 1000]);
    });

    it("reaches a marker exactly 600 frames away", () => {
      const markers = [marker(1000)];

      expect(deleteNearestMarker(markers, 1600)?.frame).toBe(1000);
      expect(markers).toHaveLength(0);
    });

    it("removes nothing when the nearest marker is beyond 600 frames", () => {
      const markers = [marker(1000)];

      expect(deleteNearestMarker(markers, 1601)).toBeNull();
      expect(deleteNearestMarker(markers, 399)).toBeNull();
      expect(markers).toHaveLength(1);
    });

    it("takes the earlier marker on a tie", () => {
      const markers = [marker(900), marker(1100)];

      expect(deleteNearestMarker(markers, 1000)?.frame).toBe(900);
    });

    it("returns null for an empty list", () => {
      expect(deleteNearestMarker([], 1000)).toBeNull();
    });
  });

  describe("nextMarker", () => {
    const markers = [marker(100), marker(1000), marker(1060), marker(1061), marker(5000)];

    it("is the first marker more than 60 frames ahead, so a second press moves on", () => {
      expect(nextMarker(markers, 1000)?.frame).toBe(1061);
      expect(nextMarker(markers, 0)?.frame).toBe(100);
    });

    it("is null past the last marker — the live edge finds nothing", () => {
      expect(nextMarker(markers, 5000)).toBeNull();
      expect(nextMarker(markers, 4940)).toBeNull();
      expect(nextMarker([], 0)).toBeNull();
    });
  });

  describe("previousMarker", () => {
    const markers = [marker(100), marker(880), marker(1000), marker(5000)];

    it("is the last marker more than 120 frames behind, so a press during a marker's moment goes to the one before", () => {
      expect(previousMarker(markers, 1000)?.frame).toBe(100); // 880 is exactly 120 behind: not "more than"
      expect(previousMarker(markers, 1001)?.frame).toBe(880);
      expect(previousMarker(markers, 1120)?.frame).toBe(880);
      expect(previousMarker(markers, 1121)?.frame).toBe(1000);
    });

    it("opens the replay at the last marker from the live edge", () => {
      expect(previousMarker(markers, 999_999)?.frame).toBe(5000);
    });

    it("is null before the first marker", () => {
      expect(previousMarker(markers, 100)).toBeNull();
      expect(previousMarker([], 100)).toBeNull();
    });
  });
});
