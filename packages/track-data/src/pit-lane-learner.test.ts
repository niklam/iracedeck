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
  PIT_LANE_LOAD_RETRY_MAX_MS,
  PIT_LANE_LOAD_RETRY_MS,
  PIT_LANE_SECTION_UNAVAILABLE,
  type PitLaneLandmarkLearner,
  type PitLaneLandmarksLoader,
  pitLaneTrackKey,
  resolvePitLaneLandmarks,
} from "./pit-lane-learner.js";

/** A 4 km track: the 5 m tolerance is 0.00125 of a lap. */
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
/** The caller's clock at the first load, epoch ms. */
const T0 = Date.parse(NOW);

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

  loadPitLaneLandmarkLearner(learner, TRACK, () => section, T0);

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

    expect(loadPitLaneLandmarkLearner(learner, TRACK, loader, T0)).toEqual({ kind: "loaded", records: 1 });

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

    expect(loadPitLaneLandmarkLearner(learner, TRACK, loader, T0)).toEqual({ kind: "none" });
    expect(loadPitLaneLandmarkLearner(learner, { ...TRACK }, loader, T0)).toEqual({ kind: "kept" });
    expect(loader).toHaveBeenCalledOnce();

    expect(loadPitLaneLandmarkLearner(learner, { ...TRACK, trackVersion: "2027.01.01.01" }, loader, T0)).toEqual({
      kind: "none",
    });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("keeps the identity it holds without building its key, and adopts an equal one in a new object", () => {
    let reads = 0;
    const counted = (track: PitLaneTrackIdentity): PitLaneTrackIdentity =>
      new Proxy(track, {
        get(target, property, receiver) {
          reads++;

          return Reflect.get(target, property, receiver) as unknown;
        },
      });
    const loader = vi.fn((_track: PitLaneTrackIdentity) => null);
    const learner = createPitLaneLandmarkLearner();
    const first = counted({ ...TRACK });

    expect(loadPitLaneLandmarkLearner(learner, first, loader, T0)).toEqual({ kind: "none" });

    // The same object again, as on every tick of an unchanged session info: no field is read.
    reads = 0;
    expect(loadPitLaneLandmarkLearner(learner, first, loader, T0)).toEqual({ kind: "kept" });
    expect(reads).toBe(0);

    // An equal identity in a new object is keyed once, kept, and adopted.
    const second = counted({ ...TRACK });

    expect(loadPitLaneLandmarkLearner(learner, second, loader, T0)).toEqual({ kind: "kept" });
    expect(reads).toBeGreaterThan(0);
    expect(learner.track).toBe(second);

    reads = 0;
    expect(loadPitLaneLandmarkLearner(learner, second, loader, T0)).toEqual({ kind: "kept" });
    expect(reads).toBe(0);
    expect(loader).toHaveBeenCalledOnce();

    // A changed identity is still loaded.
    expect(loadPitLaneLandmarkLearner(learner, { ...TRACK, trackVersion: "2027.01.01.01" }, loader, T0)).toEqual({
      kind: "none",
    });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("does nothing without an identity", () => {
    const loader = vi.fn((_track: PitLaneTrackIdentity) => stored());
    const learner = createPitLaneLandmarkLearner();

    expect(loadPitLaneLandmarkLearner(learner, null, loader, T0)).toEqual({ kind: "kept" });

    expect(loader).not.toHaveBeenCalled();
    expect(resolvePitLaneLandmarks(learner)).toBeNull();
  });

  it("starts empty for a null answer or no loader", () => {
    for (const loader of [() => null, null]) {
      const learner = createPitLaneLandmarkLearner();

      expect(loadPitLaneLandmarkLearner(learner, TRACK, loader, T0)).toEqual({ kind: "none" });
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
      loadPitLaneLandmarkLearner(
        learner,
        TRACK,
        () => ({
          version: PIT_LANE_SECTION_VERSION,
          trackLength: TRACK.trackLength,
          landmarks: { pitBoxCentre: { future: true } },
        }),
        T0,
      ),
    ).toEqual({ kind: "loaded", records: 0 });
    expect(learner.section!.landmarks).toEqual({ pitBoxCentre: { future: true } });
  });

  it("starts empty, says it threw, and does not ask again when the loader throws", () => {
    const error = new Error("disk on fire");
    const loader = vi.fn((): PitLaneSection | null => {
      throw error;
    });
    const learner = createPitLaneLandmarkLearner();

    expect(loadPitLaneLandmarkLearner(learner, TRACK, loader, T0)).toEqual({ kind: "threw", error });
    expect(loadPitLaneLandmarkLearner(learner, TRACK, loader, T0)).toEqual({ kind: "kept" });

    expect(loader).toHaveBeenCalledOnce();
    expect(learner.section!.landmarks).toEqual({});
  });

  it("starts empty on an unreadable or newer section", () => {
    for (const bad of [{ nonsense: true }, { ...stored(), version: PIT_LANE_SECTION_VERSION + 1 }]) {
      const learner = createPitLaneLandmarkLearner();

      expect(loadPitLaneLandmarkLearner(learner, TRACK, () => bad as unknown as PitLaneSection, T0)).toEqual({
        kind: "unreadable",
      });
      expect(learner.section!.landmarks).toEqual({});
    }
  });

  it("applies a track rebuild: the published values become the fallback", () => {
    const learner = createPitLaneLandmarkLearner();

    loadPitLaneLandmarkLearner(learner, TRACK, () => stored("3.99 km"), T0);

    expect(learner.section!.trackLength).toBe(TRACK.trackLength);
    expect(learner.section!.landmarks.pitRoadEnd).toMatchObject({ samples: 0, window: [] });
    expect(resolvePitLaneLandmarks(learner)!.pitRoadEnd).toMatchObject({ pct: 0.35, source: "previous" });
  });
});

describe("loadPitLaneLandmarkLearner while the store cannot be read", () => {
  /** A loader answering each of `answers` in turn, then the last one for good. */
  function sequence(...answers: ReturnType<PitLaneLandmarksLoader>[]) {
    let call = 0;

    return vi.fn((_track: PitLaneTrackIdentity) => answers[Math.min(call++, answers.length - 1)]!);
  }

  const EMPTY: PitLaneSection = { version: PIT_LANE_SECTION_VERSION, trackLength: TRACK.trackLength, landmarks: {} };

  it("learns on an empty section, and asks again once the back-off has passed", () => {
    const loader = sequence(PIT_LANE_SECTION_UNAVAILABLE, stored());
    const learner = createPitLaneLandmarkLearner();

    expect(loadPitLaneLandmarkLearner(learner, TRACK, loader, T0)).toEqual({
      kind: "unavailable",
      attempt: 1,
      retryInMs: PIT_LANE_LOAD_RETRY_MS,
    });
    expect(learner.section).toEqual(EMPTY);
    expect(learner.key).toBe(pitLaneTrackKey(TRACK));
    expect(resolvePitLaneLandmarks(learner)).not.toBeNull();

    // Not due yet: the same object, and an equal one in a new object, are kept without asking.
    expect(loadPitLaneLandmarkLearner(learner, TRACK, loader, T0 + PIT_LANE_LOAD_RETRY_MS - 1)).toEqual({
      kind: "kept",
    });
    expect(loadPitLaneLandmarkLearner(learner, { ...TRACK }, loader, T0 + PIT_LANE_LOAD_RETRY_MS - 1)).toEqual({
      kind: "kept",
    });
    expect(loader).toHaveBeenCalledOnce();

    expect(loadPitLaneLandmarkLearner(learner, learner.track, loader, T0 + PIT_LANE_LOAD_RETRY_MS)).toEqual({
      kind: "loaded",
      records: 1,
    });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(learner.retry).toBeNull();
    expect(resolvePitLaneLandmarks(learner)!.pitRoadEnd).toMatchObject({ pct: 0.35, published: true });

    // Loaded for good: never asked again for this identity.
    expect(loadPitLaneLandmarkLearner(learner, { ...TRACK }, loader, T0 + 10 * PIT_LANE_LOAD_RETRY_MAX_MS)).toEqual({
      kind: "kept",
    });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("doubles the back-off on each unavailable answer in a row, up to the cap", () => {
    const loader = sequence(PIT_LANE_SECTION_UNAVAILABLE);
    const learner = createPitLaneLandmarkLearner();
    const delays: number[] = [];
    let now = T0;

    for (let attempt = 1; attempt <= 6; attempt++) {
      const outcome = loadPitLaneLandmarkLearner(learner, TRACK, loader, now);

      expect(outcome).toMatchObject({ kind: "unavailable", attempt });
      delays.push((outcome as { retryInMs: number }).retryInMs);
      now += (outcome as { retryInMs: number }).retryInMs;
    }

    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, PIT_LANE_LOAD_RETRY_MAX_MS, PIT_LANE_LOAD_RETRY_MAX_MS]);
    expect(loader).toHaveBeenCalledTimes(6);
  });

  it("folds the samples accepted while waiting into the section that finally loads", () => {
    const loader = sequence(PIT_LANE_SECTION_UNAVAILABLE, stored());
    const learner = createPitLaneLandmarkLearner();

    loadPitLaneLandmarkLearner(learner, TRACK, loader, T0);
    learnPitLaneLandmarks(
      learner,
      [
        { landmark: "pitRoadEnd", sample: sample(0.351, "w1", 10_000) },
        { landmark: "blendEnd", sample: sample(0.4, "w2", 10_000) },
      ],
      NOW,
    );

    expect(loadPitLaneLandmarkLearner(learner, TRACK, loader, T0 + PIT_LANE_LOAD_RETRY_MS)).toEqual({
      kind: "loaded",
      records: 2,
    });
    expect(learner.section!.landmarks.pitRoadEnd!.window.map((s) => s.key)).toEqual(["a", "b", "w1"]);
    expect(learner.section!.landmarks.pitRoadEnd).toMatchObject({ samples: 3 });
    expect(learner.section!.landmarks.blendEnd!.window.map((s) => s.key)).toEqual(["w2"]);
  });

  it("counts a waiting sample once when the loaded section already holds it", () => {
    const waitingSample = sample(0.351, "w1", 10_000);
    const withIt = stored();

    withIt.landmarks.pitRoadEnd = foldSample(withIt.landmarks.pitRoadEnd, waitingSample, NOW, 4000).record!;

    const loader = sequence(PIT_LANE_SECTION_UNAVAILABLE, withIt);
    const learner = createPitLaneLandmarkLearner();

    loadPitLaneLandmarkLearner(learner, TRACK, loader, T0);
    learnPitLaneLandmarks(learner, [{ landmark: "pitRoadEnd", sample: waitingSample }], NOW);
    loadPitLaneLandmarkLearner(learner, TRACK, loader, T0 + PIT_LANE_LOAD_RETRY_MS);

    expect(learner.section!.landmarks.pitRoadEnd!.window.map((s) => s.key)).toEqual(["a", "b", "w1"]);
    expect(learner.section!.landmarks.pitRoadEnd).toMatchObject({ samples: 3 });
  });

  it("keeps the waiting samples and stops asking when the retry answers none or throws", () => {
    const answers: (() => ReturnType<PitLaneLandmarksLoader>)[] = [
      () => null,
      () => {
        throw new Error("disk on fire");
      },
    ];

    for (const answer of answers) {
      let first = true;
      const loader = vi.fn((_track: PitLaneTrackIdentity) => {
        if (!first) return answer();

        first = false;

        return PIT_LANE_SECTION_UNAVAILABLE;
      });
      const learner = createPitLaneLandmarkLearner();

      loadPitLaneLandmarkLearner(learner, TRACK, loader, T0);
      learnPitLaneLandmarks(learner, [{ landmark: "approachStart", sample: sample(0.9, "w1", 10_000) }], NOW);

      expect(loadPitLaneLandmarkLearner(learner, TRACK, loader, T0 + PIT_LANE_LOAD_RETRY_MS).kind).toMatch(
        /^(none|threw)$/,
      );
      expect(learner.section!.landmarks.approachStart!.window.map((s) => s.key)).toEqual(["w1"]);
      expect(learner.retry).toBeNull();

      loadPitLaneLandmarkLearner(learner, TRACK, loader, T0 + 10 * PIT_LANE_LOAD_RETRY_MAX_MS);
      expect(loader).toHaveBeenCalledTimes(2);
    }
  });

  it("drops the pending retry and the waiting samples when the identity changes", () => {
    const loader = sequence(PIT_LANE_SECTION_UNAVAILABLE, null);
    const learner = createPitLaneLandmarkLearner();

    loadPitLaneLandmarkLearner(learner, TRACK, loader, T0);
    learnPitLaneLandmarks(learner, [{ landmark: "approachStart", sample: sample(0.9, "w1", 10_000) }], NOW);

    // Before the retry is due: a new identity is loaded at once, on its own.
    expect(loadPitLaneLandmarkLearner(learner, { ...TRACK, trackLength: "4.10 km" }, loader, T0 + 1)).toEqual({
      kind: "none",
    });
    expect(learner.section!.landmarks).toEqual({});
    expect(learner.retry).toBeNull();
  });

  it("restarts the count of unavailable answers for a new identity", () => {
    const loader = sequence(PIT_LANE_SECTION_UNAVAILABLE);
    const learner = createPitLaneLandmarkLearner();

    loadPitLaneLandmarkLearner(learner, TRACK, loader, T0);
    loadPitLaneLandmarkLearner(learner, TRACK, loader, T0 + PIT_LANE_LOAD_RETRY_MS);

    expect(
      loadPitLaneLandmarkLearner(learner, { ...TRACK, trackId: 124 }, loader, T0 + PIT_LANE_LOAD_RETRY_MS),
    ).toEqual({ kind: "unavailable", attempt: 1, retryInMs: PIT_LANE_LOAD_RETRY_MS });
  });

  it("asks again at once when the clock went back before the last ask, and never on a clock that is not a number", () => {
    const loader = sequence(PIT_LANE_SECTION_UNAVAILABLE);
    const learner = createPitLaneLandmarkLearner();

    loadPitLaneLandmarkLearner(learner, TRACK, loader, T0);

    expect(loadPitLaneLandmarkLearner(learner, TRACK, loader, Number.NaN)).toEqual({ kind: "kept" });
    expect(loader).toHaveBeenCalledOnce();

    expect(loadPitLaneLandmarkLearner(learner, TRACK, loader, T0 - 60_000)).toMatchObject({
      kind: "unavailable",
      attempt: 2,
    });
    expect(loader).toHaveBeenCalledTimes(2);
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
    // 0.002 of 4 km is 8 m, 4 m each side of the median: within the 5 m half-width.
    const [second] = learnPitLaneLandmarks(
      learner,
      [{ landmark: "pitRoadStart", sample: sample(0.902, "b", 2_000) }],
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
