import { describe, expect, it, vi } from "vitest";

import {
  foldSample,
  PIT_LANE_SECTION_VERSION,
  type PitLaneLandmarkRecord,
  type PitLaneLandmarkSample,
  type PitLaneSection,
  type PitLaneTrackIdentity,
} from "./pit-lane-landmarks.js";
import {
  createPitLaneLandmarkLearner,
  learnPitLaneLandmarks,
  loadPitLaneLandmarkLearner,
  type PitLaneLandmarkLearner,
  pitLaneTrackKey,
  resolvePitLaneLandmarks,
} from "./pit-lane-learner.js";

/** A 4 km track: the 15 m tolerance is 0.00375 of a lap. */
const TRACK: PitLaneTrackIdentity = {
  sim: "iracing",
  trackId: 123,
  trackName: "testtrack",
  trackConfigName: "Grand Prix",
  trackLength: "4.00 km",
  trackLengthM: 4000,
  trackVersion: "2026.11.01.01",
};
const NOW = "2026-11-09T12:00:00.000Z";

function sample(pct: number, key: string, at: number, overrides: Partial<PitLaneLandmarkSample> = {}) {
  return { pct, estTime: 20, carClassId: 10, key, at, ...overrides };
}

/** A record of two agreeing samples: published under the 4 km geometry. */
function publishedRecord(pct: number): PitLaneLandmarkRecord {
  const a = foldSample(undefined, sample(pct, "a", 1), NOW, 4000);
  const b = foldSample(a.record, sample(pct, "b", 2), NOW, 4000);

  return b.record!;
}

function stored(trackLength = TRACK.trackLength): PitLaneSection {
  return { version: PIT_LANE_SECTION_VERSION, trackLength, landmarks: { pitRoadEnd: publishedRecord(0.35) } };
}

function loaded(section: PitLaneSection | null = null): PitLaneLandmarkLearner {
  const learner = createPitLaneLandmarkLearner();

  loadPitLaneLandmarkLearner(learner, TRACK, () => section);

  return learner;
}

describe("pitLaneTrackKey", () => {
  it("changes with every field of the identity", () => {
    const base = pitLaneTrackKey(TRACK);
    const variants: PitLaneTrackIdentity[] = [
      { ...TRACK, sim: "othersim" },
      { ...TRACK, trackId: 124 },
      { ...TRACK, trackName: "other" },
      { ...TRACK, trackConfigName: "Oval" },
      { ...TRACK, trackLength: "4.01 km" },
      { ...TRACK, trackLengthM: 4010 },
      { ...TRACK, trackVersion: null },
    ];

    expect(pitLaneTrackKey({ ...TRACK })).toBe(base);

    for (const variant of variants) expect(pitLaneTrackKey(variant)).not.toBe(base);
  });
});

describe("loadPitLaneLandmarkLearner", () => {
  it("seeds from the loader, which gets a copy of the identity", () => {
    const loader = vi.fn((_track: PitLaneTrackIdentity) => stored());
    const learner = createPitLaneLandmarkLearner();

    expect(loadPitLaneLandmarkLearner(learner, TRACK, loader)).toEqual({ kind: "loaded", records: 1 });

    expect(loader).toHaveBeenCalledOnce();
    expect(loader.mock.calls[0]![0]).toEqual(TRACK);
    expect(loader.mock.calls[0]![0]).not.toBe(TRACK);
    expect(learner.key).toBe(pitLaneTrackKey(TRACK));
    expect(learner.track).toBe(TRACK);
    expect(resolvePitLaneLandmarks(learner)).toEqual({
      approachStart: null,
      pitRoadStart: null,
      pitRoadEnd: expect.objectContaining({ pct: 0.35, samples: 2, published: true, source: "current" }),
      blendEnd: null,
    });
  });

  it("asks once per identity, and again when the identity changes", () => {
    const loader = vi.fn((_track: PitLaneTrackIdentity) => null);
    const learner = createPitLaneLandmarkLearner();

    expect(loadPitLaneLandmarkLearner(learner, TRACK, loader)).toEqual({ kind: "none" });
    expect(loadPitLaneLandmarkLearner(learner, { ...TRACK }, loader)).toEqual({ kind: "kept" });
    expect(loader).toHaveBeenCalledOnce();

    expect(loadPitLaneLandmarkLearner(learner, { ...TRACK, trackVersion: "2027.01.01.01" }, loader)).toEqual({
      kind: "none",
    });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("does nothing without an identity", () => {
    const loader = vi.fn((_track: PitLaneTrackIdentity) => stored());
    const learner = createPitLaneLandmarkLearner();

    expect(loadPitLaneLandmarkLearner(learner, null, loader)).toEqual({ kind: "kept" });

    expect(loader).not.toHaveBeenCalled();
    expect(resolvePitLaneLandmarks(learner)).toBeNull();
  });

  it("starts empty for a null answer or no loader", () => {
    for (const loader of [() => null, null]) {
      const learner = createPitLaneLandmarkLearner();

      expect(loadPitLaneLandmarkLearner(learner, TRACK, loader)).toEqual({ kind: "none" });
      expect(learner.section).toEqual({
        version: PIT_LANE_SECTION_VERSION,
        trackLength: TRACK.trackLength,
        landmarks: {},
      });
    }
  });

  it("counts a readable section with no known landmark as loaded with none", () => {
    const learner = createPitLaneLandmarkLearner();

    expect(
      loadPitLaneLandmarkLearner(learner, TRACK, () => ({
        version: PIT_LANE_SECTION_VERSION,
        trackLength: TRACK.trackLength,
        landmarks: { pitBoxCentre: { future: true } },
      })),
    ).toEqual({ kind: "loaded", records: 0 });
    expect(learner.section!.landmarks).toEqual({ pitBoxCentre: { future: true } });
  });

  it("starts empty, says it threw, and does not ask again when the loader throws", () => {
    const error = new Error("disk on fire");
    const loader = vi.fn((): PitLaneSection | null => {
      throw error;
    });
    const learner = createPitLaneLandmarkLearner();

    expect(loadPitLaneLandmarkLearner(learner, TRACK, loader)).toEqual({ kind: "threw", error });
    expect(loadPitLaneLandmarkLearner(learner, TRACK, loader)).toEqual({ kind: "kept" });

    expect(loader).toHaveBeenCalledOnce();
    expect(learner.section!.landmarks).toEqual({});
  });

  it("starts empty on an unreadable or newer section", () => {
    for (const bad of [{ nonsense: true }, { ...stored(), version: PIT_LANE_SECTION_VERSION + 1 }]) {
      const learner = createPitLaneLandmarkLearner();

      expect(loadPitLaneLandmarkLearner(learner, TRACK, () => bad as unknown as PitLaneSection)).toEqual({
        kind: "unreadable",
      });
      expect(learner.section!.landmarks).toEqual({});
    }
  });

  it("applies a track rebuild: the published values become the fallback", () => {
    const learner = createPitLaneLandmarkLearner();

    loadPitLaneLandmarkLearner(learner, TRACK, () => stored("3.99 km"));

    expect(learner.section!.trackLength).toBe(TRACK.trackLength);
    expect(learner.section!.landmarks.pitRoadEnd).toMatchObject({ samples: 0, window: [] });
    expect(resolvePitLaneLandmarks(learner)!.pitRoadEnd).toMatchObject({ pct: 0.35, source: "previous" });
  });
});

describe("resolvePitLaneLandmarks", () => {
  it("is null until a track is loaded", () => {
    expect(resolvePitLaneLandmarks(createPitLaneLandmarkLearner())).toBeNull();
  });

  it("is null per landmark until it publishes", () => {
    const learner = loaded();

    learnPitLaneLandmarks(learner, [{ landmark: "approachStart", sample: sample(0.5, "k1", 1_000) }], NOW);

    expect(resolvePitLaneLandmarks(learner)!.approachStart).toBeNull();

    learnPitLaneLandmarks(learner, [{ landmark: "approachStart", sample: sample(0.5005, "k2", 2_000) }], NOW);

    expect(resolvePitLaneLandmarks(learner)!.approachStart).toMatchObject({
      samples: 2,
      published: true,
      source: "current",
    });
  });
});

describe("learnPitLaneLandmarks", () => {
  it("folds each edge, in order, and returns each one's summary", () => {
    const learner = loaded();

    const results = learnPitLaneLandmarks(
      learner,
      [
        { landmark: "pitRoadEnd", sample: sample(0.05, "car1:pitRoadEnd", 1_000) },
        { landmark: "blendEnd", sample: sample(0.05, "car1:blendEnd", 1_000) },
      ],
      NOW,
    );

    expect(results).toEqual([
      {
        landmark: "pitRoadEnd",
        sample: sample(0.05, "car1:pitRoadEnd", 1_000),
        accepted: true,
        summary: { pct: 0.05, estTimeByClass: { "10": 20 }, samples: 1, published: false },
      },
      {
        landmark: "blendEnd",
        sample: sample(0.05, "car1:blendEnd", 1_000),
        accepted: true,
        summary: { pct: 0.05, estTimeByClass: { "10": 20 }, samples: 1, published: false },
      },
    ]);
    expect(learner.section!.landmarks.pitRoadEnd).toMatchObject({ samples: 1, updatedAt: NOW });
    expect(learner.section!.landmarks.blendEnd).toMatchObject({ samples: 1, updatedAt: NOW });
  });

  it("summarises under the loaded track's length", () => {
    const learner = loaded();

    learnPitLaneLandmarks(learner, [{ landmark: "pitRoadStart", sample: sample(0.9, "a", 1_000) }], NOW);
    // 0.003 of 4 km is 12 m: within the 15 m half-width of the median.
    const [second] = learnPitLaneLandmarks(
      learner,
      [{ landmark: "pitRoadStart", sample: sample(0.903, "b", 2_000) }],
      NOW,
    );

    expect(second).toMatchObject({ accepted: true, summary: { samples: 2, published: true } });
  });

  it("folds a later edge of one landmark onto the record an earlier one in the same call left", () => {
    const learner = loaded();

    const results = learnPitLaneLandmarks(
      learner,
      [
        { landmark: "approachStart", sample: sample(0.5, "a", 1_000) },
        { landmark: "approachStart", sample: sample(0.5, "a", 1_500) },
      ],
      NOW,
    );

    expect(results.map((r) => (r.accepted ? "accepted" : r.reason))).toEqual(["accepted", "duplicate"]);
    expect(learner.section!.landmarks.approachStart).toMatchObject({ samples: 1 });
  });

  it("rejects a duplicate or a malformed sample and leaves the section as it was", () => {
    const learner = loaded();

    learnPitLaneLandmarks(learner, [{ landmark: "pitRoadEnd", sample: sample(0.2, "a", 1_000) }], NOW);
    const before = learner.section;

    const results = learnPitLaneLandmarks(
      learner,
      [
        { landmark: "pitRoadEnd", sample: sample(0.2, "a", 2_000) },
        { landmark: "blendEnd", sample: sample(1.5, "b", 2_000) },
      ],
      NOW,
    );

    expect(results.map((r) => (r.accepted ? "accepted" : r.reason))).toEqual(["duplicate", "invalid"]);
    expect(learner.section).toBe(before);
  });

  it("rejects every edge while nothing is loaded", () => {
    const learner = createPitLaneLandmarkLearner();

    expect(learnPitLaneLandmarks(learner, [{ landmark: "blendEnd", sample: sample(0.1, "a", 1_000) }], NOW)).toEqual([
      { landmark: "blendEnd", sample: sample(0.1, "a", 1_000), accepted: false, reason: "unloaded" },
    ]);
    expect(learner.section).toBeNull();
  });

  it("replaces the section, never mutates it", () => {
    const learner = loaded(stored());
    const before = learner.section!;
    const snapshot = structuredClone(before);

    learnPitLaneLandmarks(learner, [{ landmark: "pitRoadEnd", sample: sample(0.35, "c", 3) }], NOW);

    expect(learner.section).not.toBe(before);
    expect(before).toEqual(snapshot);
    expect(learner.section!.landmarks.pitRoadEnd).toMatchObject({ samples: 3 });
  });

  it("is all or nothing: a throw part-way leaves the learner untouched", () => {
    const learner = loaded();
    const before = learner.section;
    const throwing = {
      landmark: "blendEnd" as const,
      get sample(): PitLaneLandmarkSample {
        throw new Error("reading failed");
      },
    };

    expect(() =>
      learnPitLaneLandmarks(learner, [{ landmark: "pitRoadEnd", sample: sample(0.05, "a", 1_000) }, throwing], NOW),
    ).toThrow("reading failed");
    expect(learner.section).toBe(before);
    expect(learner.section!.landmarks).toEqual({});
  });
});
