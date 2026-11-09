import { describe, expect, it } from "vitest";

import {
  applyTrackLength,
  foldSample,
  isDuplicatePitLaneSample,
  isNewerPitLaneSection,
  isPitLaneLandmarkSample,
  normalizePitLaneLandmarkRecord,
  normalizePitLanePct,
  normalizePitLaneSection,
  PIT_LANE_DUPLICATE_WINDOW_MS,
  PIT_LANE_LANDMARK_NAMES,
  PIT_LANE_SECTION_VERSION,
  PIT_LANE_TOLERANCE_PCT,
  PIT_LANE_WINDOW_CAP,
  pitLaneCircularMedianPct,
  type PitLaneLandmarkRecord,
  type PitLaneLandmarkSample,
  pitLaneMidpointPct,
  type PitLaneSection,
  pitLaneSignedDeltaPct,
  pitLaneTolerancePct,
  resolvePublishedLandmark,
  summarizeLandmark,
} from "./pit-lane-landmarks.js";

const NOW = "2026-11-09T12:00:00.000Z";
const LATER = "2026-11-09T13:00:00.000Z";
const TRACK_M = 5000;

let nextAt = 1_000_000;

function sample(pct: number, overrides: Partial<PitLaneLandmarkSample> = {}): PitLaneLandmarkSample {
  nextAt += PIT_LANE_DUPLICATE_WINDOW_MS;

  return {
    pct,
    estTime: 80,
    carClassId: 1,
    key: `100:2:${nextAt}:pitRoadEnd:3`,
    at: nextAt,
    ...overrides,
  };
}

/** Fold samples in order, asserting each is accepted. */
function foldAll(
  samples: PitLaneLandmarkSample[],
  start?: PitLaneLandmarkRecord,
  trackLengthM: number | null = TRACK_M,
): PitLaneLandmarkRecord {
  let record = start;

  for (const entry of samples) {
    const result = foldSample(record, entry, NOW, trackLengthM);

    expect(result.accepted).toBe(true);
    record = result.record;
  }

  return record!;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);

    Object.freeze(value);
  }

  return value;
}

describe("names", () => {
  it("lists the four landmarks in driving order", () => {
    expect(PIT_LANE_LANDMARK_NAMES).toEqual(["approachStart", "pitRoadStart", "pitRoadEnd", "blendEnd"]);
  });
});

describe("wrap-aware helpers", () => {
  it("normalizes into [0, 1)", () => {
    expect(normalizePitLanePct(1.25)).toBeCloseTo(0.25);
    expect(normalizePitLanePct(-0.25)).toBeCloseTo(0.75);
    expect(normalizePitLanePct(1)).toBe(0);
    expect(normalizePitLanePct(-1e-17)).toBe(0);
  });

  it("takes the shorter signed arc", () => {
    expect(pitLaneSignedDeltaPct(0.2, 0.3)).toBeCloseTo(0.1);
    expect(pitLaneSignedDeltaPct(0.3, 0.2)).toBeCloseTo(-0.1);
    expect(pitLaneSignedDeltaPct(0.99, 0.01)).toBeCloseTo(0.02);
    expect(pitLaneSignedDeltaPct(0.01, 0.99)).toBeCloseTo(-0.02);
  });

  it("puts the midpoint on the shorter arc, across S/F too", () => {
    expect(pitLaneMidpointPct(0.2, 0.4)).toBeCloseTo(0.3);
    expect(pitLaneMidpointPct(0.98, 0.04)).toBeCloseTo(0.01);
    expect(pitLaneMidpointPct(0.97, 0.01)).toBeCloseTo(0.99);
    expect(pitLaneMidpointPct(0.99, 0.03)).toBeCloseTo(0.01);
  });

  it("takes the median of values straddling S/F in driving order", () => {
    expect(pitLaneCircularMedianPct([0.998, 0.999, 0.001])).toBeCloseTo(0.999);
    expect(pitLaneCircularMedianPct([0.001, 0.003, 0.999])).toBeCloseTo(0.001);
    expect(pitLaneCircularMedianPct([0.999, 0.003])).toBeCloseTo(0.001);
    expect(pitLaneCircularMedianPct([0.4, 0.5, 0.6])).toBeCloseTo(0.5);
  });

  it("never takes an outlier as the unwrap reference", () => {
    expect(pitLaneCircularMedianPct([0.998, 0.999, 0.001, 0.002, 0.3])).toBeCloseTo(0.001);
    expect(pitLaneCircularMedianPct([0.3, 0.998, 0.999, 0.001, 0.002])).toBeCloseTo(0.001);

    // An antipodal outlier is as far from either side of the cluster, so the median lands on its edge.
    const antipodal = pitLaneCircularMedianPct([0.998, 0.999, 0.001, 0.002, 0.5])!;

    expect(Math.abs(pitLaneSignedDeltaPct(0, antipodal))).toBeLessThanOrEqual(0.001 + 1e-12);
  });

  it("returns null for no values", () => {
    expect(pitLaneCircularMedianPct([])).toBeNull();
  });

  it("derives the tolerance from the track length, with a fallback", () => {
    expect(pitLaneTolerancePct(5000)).toBeCloseTo(0.003);
    expect(pitLaneTolerancePct(null)).toBe(PIT_LANE_TOLERANCE_PCT);
    expect(pitLaneTolerancePct(0)).toBe(PIT_LANE_TOLERANCE_PCT);
    expect(pitLaneTolerancePct(Number.NaN)).toBe(PIT_LANE_TOLERANCE_PCT);
  });
});

describe("foldSample", () => {
  it("creates a learned record from the first sample", () => {
    const first = sample(0.42, { estTime: 33.5, carClassId: 7 });
    const result = foldSample(undefined, first, NOW, TRACK_M);

    expect(result.accepted).toBe(true);
    expect(result.record).toEqual({
      pct: 0.42,
      estTimeByClass: { "7": 33.5 },
      samples: 1,
      updatedAt: NOW,
      origin: "learned",
      window: [first],
    });
  });

  it("converges on the median and shrugs off outliers", () => {
    const record = foldAll([0.301, 0.299, 0.3, 0.45, 0.302, 0.298, 0.1].map((pct) => sample(pct)));

    expect(record.pct).toBeCloseTo(0.3);
    expect(record.samples).toBe(7);
  });

  it("learns a pit exit straddling S/F", () => {
    const record = foldAll([0.999, 0.0015, 0.9995, 0.0005, 0.001].map((pct) => sample(pct)));

    expect(record.pct).toBeCloseTo(0.0005);
    expect(summarizeLandmark(record, TRACK_M).published).toBe(true);
  });

  it("rejects a duplicate key inside 60 s and accepts it after", () => {
    const first = sample(0.3, { key: "1:2:3:pitRoadEnd:4", at: 10_000 });
    const record = foldAll([first]);

    const dupe = foldSample(record, { ...first, at: 10_000 + PIT_LANE_DUPLICATE_WINDOW_MS - 1 }, LATER, TRACK_M);

    expect(dupe).toEqual({ accepted: false, reason: "duplicate", record });

    const earlier = foldSample(record, { ...first, at: 10_000 - PIT_LANE_DUPLICATE_WINDOW_MS + 1 }, LATER, TRACK_M);

    expect(earlier.accepted).toBe(false);

    const restart = foldSample(record, { ...first, at: 10_000 + PIT_LANE_DUPLICATE_WINDOW_MS }, LATER, TRACK_M);

    expect(restart.accepted).toBe(true);
    expect(restart.record?.samples).toBe(2);
    expect(restart.record?.updatedAt).toBe(LATER);
  });

  it("accepts a different key at the same time", () => {
    const first = sample(0.3, { key: "a", at: 10_000 });

    expect(foldSample(foldAll([first]), { ...first, key: "b" }, NOW, TRACK_M).accepted).toBe(true);
  });

  it("rejects a malformed sample and returns the input", () => {
    const record = foldAll([sample(0.3)]);

    for (const bad of [
      { ...sample(0.3), pct: 1 },
      { ...sample(0.3), pct: -0.1 },
      { ...sample(0.3), pct: Number.NaN },
      { ...sample(0.3), estTime: -1 },
      { ...sample(0.3), key: "" },
      { ...sample(0.3), at: Number.POSITIVE_INFINITY },
    ]) {
      expect(foldSample(record, bad, NOW, TRACK_M)).toEqual({ accepted: false, reason: "invalid", record });
    }

    expect(foldSample(undefined, { ...sample(0.3), pct: 2 }, NOW, TRACK_M)).toEqual({
      accepted: false,
      reason: "invalid",
      record: undefined,
    });
  });

  it("caps the window, dropping the oldest, while the count keeps climbing", () => {
    const samples = Array.from({ length: PIT_LANE_WINDOW_CAP + 5 }, (_, index) => sample(0.3 + index * 1e-5));
    const record = foldAll(samples);

    expect(record.window).toHaveLength(PIT_LANE_WINDOW_CAP);
    expect(record.window[0]).toEqual(samples[5]);
    expect(record.window.at(-1)).toEqual(samples.at(-1));
    expect(record.samples).toBe(PIT_LANE_WINDOW_CAP + 5);
  });

  it("rejects as stale a sample older than all of a full window", () => {
    const samples = Array.from({ length: PIT_LANE_WINDOW_CAP }, (_, index) =>
      sample(0.3, { at: 1000 + index, key: `k${String(index).padStart(2, "0")}` }),
    );
    const record = foldAll(samples);
    const result = foldSample(record, sample(0.3, { at: 500 }), LATER, TRACK_M);

    expect(result).toEqual({ accepted: false, reason: "stale", record });
    expect(record.samples).toBe(PIT_LANE_WINDOW_CAP);
    expect(record.updatedAt).toBe(NOW);
  });

  it("orders ties on at by key, so eviction is deterministic", () => {
    const samples = Array.from({ length: PIT_LANE_WINDOW_CAP }, (_, index) =>
      sample(0.3, { at: 1000 + index, key: `k${String(index).padStart(2, "0")}` }),
    );
    const record = foldAll(samples);

    // Same `at` as the oldest, key sorts before it: evicted at once.
    expect(foldSample(record, sample(0.3, { at: 1000, key: "k" }), LATER, TRACK_M).accepted).toBe(false);

    // Same `at` as the oldest, key sorts after it: the oldest goes instead.
    const tie = sample(0.3, { at: 1000, key: "k000" });
    const result = foldSample(record, tie, LATER, TRACK_M);

    expect(result.accepted).toBe(true);
    expect(result.record?.window).toHaveLength(PIT_LANE_WINDOW_CAP);
    expect(result.record?.window[0]).toEqual(tie);
    expect(result.record?.window).not.toContainEqual(samples[0]);
    expect(result.record?.samples).toBe(PIT_LANE_WINDOW_CAP + 1);
    expect(result.record?.updatedAt).toBe(LATER);
  });

  it("orders an older sample into a window that is not full", () => {
    const record = foldAll([sample(0.3, { at: 2000, key: "b" }), sample(0.3, { at: 3000, key: "c" })]);
    const result = foldSample(record, sample(0.3, { at: 1000, key: "a" }), LATER, TRACK_M);

    expect(result.record?.window.map((entry) => entry.key)).toEqual(["a", "b", "c"]);
  });

  it("keeps the median estTime per class", () => {
    const record = foldAll([
      sample(0.3, { carClassId: 1, estTime: 40 }),
      sample(0.3, { carClassId: 1, estTime: 42 }),
      sample(0.3, { carClassId: 1, estTime: 41 }),
      sample(0.3, { carClassId: 2, estTime: 50 }),
      sample(0.3, { carClassId: 2, estTime: 52 }),
    ]);

    expect(record.estTimeByClass).toEqual({ "1": 41, "2": 51 });
  });

  it("uses only estTimes on the median's side of S/F", () => {
    const record = foldAll([
      sample(0.999, { carClassId: 1, estTime: 89.9 }),
      sample(0.0005, { carClassId: 1, estTime: 0.5 }),
      sample(0.001, { carClassId: 1, estTime: 1.5 }),
      sample(0.0008, { carClassId: 2, estTime: 0.09 }),
      sample(0.9992, { carClassId: 3, estTime: 99.5 }),
    ]);

    expect(record.pct).toBeCloseTo(0.0005);
    expect(record.estTimeByClass).toEqual({ "1": 1, "2": 0.09 });
  });

  it("ignores the estTime of a sample outside the tolerance", () => {
    const record = foldAll([
      sample(0.5, { carClassId: 1, estTime: 40 }),
      sample(0.5, { carClassId: 1, estTime: 41 }),
      sample(0.5001, { carClassId: 1, estTime: 40.5 }),
      // An outlier of another class: must not create that class's time.
      sample(0.3, { carClassId: 2, estTime: 25 }),
      // An outlier of the same class: must not skew its median (40.5 with it would be 40.25).
      sample(0.3, { carClassId: 1, estTime: 25 }),
    ]);

    expect(record.pct).toBeCloseTo(0.5);
    expect(record.estTimeByClass).toEqual({ "1": 40.5 });
  });

  it("keeps an existing origin and unknown keys", () => {
    const seeded: PitLaneLandmarkRecord = {
      ...foldAll([sample(0.3)]),
      origin: "seeded",
      futureField: { nested: true },
    };
    const result = foldSample(seeded, sample(0.3), NOW, TRACK_M);

    expect(result.record?.origin).toBe("seeded");
    expect(result.record?.futureField).toEqual({ nested: true });
  });

  it("keeps unknown keys on a sample", () => {
    const extra = { ...sample(0.3), lapDist: 1500 } as PitLaneLandmarkSample;

    expect(foldAll([extra]).window[0]).toEqual(extra);
  });

  it("never mutates its input", () => {
    const record = deepFreeze(foldAll([sample(0.3), sample(0.3)]));
    const entry = deepFreeze(sample(0.31));
    const before = structuredClone(record);

    const result = foldSample(record, entry, LATER, TRACK_M);

    expect(result.accepted).toBe(true);
    expect(record).toEqual(before);
    expect(result.record).not.toBe(record);
    expect(result.record?.window).not.toBe(record.window);
  });
});

describe("summarizeLandmark", () => {
  it("does not publish a lone sample", () => {
    const summary = summarizeLandmark(foldAll([sample(0.3, { estTime: 20 })]), TRACK_M);

    expect(summary).toEqual({ pct: 0.3, estTimeByClass: { "1": 20 }, samples: 1, published: false });
  });

  it("publishes two samples within the tolerance", () => {
    // 5 m on 5000 m is 0.001: 9.5 m apart is 4.75 m each side of the median.
    expect(summarizeLandmark(foldAll([sample(0.3), sample(0.3019)]), TRACK_M).published).toBe(true);
  });

  it("treats the tolerance as a half-width around the median", () => {
    // 5 km track: 8 m apart is 4 m each side of the median, 11 m apart is 5.5 m.
    expect(summarizeLandmark(foldAll([sample(0.3), sample(0.3016)]), TRACK_M).published).toBe(true);
    expect(summarizeLandmark(foldAll([sample(0.3), sample(0.3022)]), TRACK_M).published).toBe(false);
  });

  it("does not publish two samples beyond the tolerance", () => {
    expect(summarizeLandmark(foldAll([sample(0.3), sample(0.307)]), TRACK_M).published).toBe(false);
  });

  it("uses the pct tolerance when the track length is unknown", () => {
    // 0.0012 each side of the median: within PIT_LANE_TOLERANCE_PCT, but 6 m on 5 km.
    const record = foldAll([sample(0.3), sample(0.3024)], undefined, null);

    expect(summarizeLandmark(record, null).published).toBe(true);
    expect(summarizeLandmark(record, TRACK_M).published).toBe(false);
  });

  it("publishes across S/F", () => {
    expect(summarizeLandmark(foldAll([sample(0.9995), sample(0.0005)]), TRACK_M).published).toBe(true);
  });

  it("does not publish an empty window", () => {
    const record: PitLaneLandmarkRecord = { ...foldAll([sample(0.3), sample(0.3)]), window: [] };

    expect(summarizeLandmark(record, TRACK_M).published).toBe(false);
  });

  it("returns a copy of estTimeByClass", () => {
    const record = foldAll([sample(0.3)]);
    const summary = summarizeLandmark(record, TRACK_M);

    summary.estTimeByClass["9"] = 1;
    expect(record.estTimeByClass).not.toHaveProperty("9");
  });
});

function section(landmarks: PitLaneSection["landmarks"], trackLength = "5.00 km"): PitLaneSection {
  return { version: PIT_LANE_SECTION_VERSION, trackLength, landmarks };
}

describe("applyTrackLength and resolvePublishedLandmark", () => {
  it("creates an empty section", () => {
    expect(applyTrackLength(undefined, "5.00 km", TRACK_M)).toEqual({
      version: PIT_LANE_SECTION_VERSION,
      trackLength: "5.00 km",
      landmarks: {},
    });
  });

  it("returns the section itself for an equal length", () => {
    const current = section({ pitRoadEnd: foldAll([sample(0.3)]) });

    expect(applyTrackLength(current, "5.00 km", TRACK_M)).toBe(current);
  });

  it("moves published values to previous on a rebuild, then drops them once relearned", () => {
    const learned = foldAll([sample(0.3, { estTime: 30 }), sample(0.3002, { estTime: 32 })]);
    const original = deepFreeze(section({ pitRoadEnd: learned, futureKey: { kept: true } }));

    const rebuilt = applyTrackLength(original, "5.02 km", 5020);
    const record = rebuilt.landmarks.pitRoadEnd!;

    expect(rebuilt.trackLength).toBe("5.02 km");
    expect(rebuilt.landmarks.futureKey).toEqual({ kept: true });
    expect(record.window).toEqual([]);
    expect(record.samples).toBe(0);
    expect(record.previous).toEqual({ pct: learned.pct, estTimeByClass: learned.estTimeByClass, samples: 2 });
    expect(resolvePublishedLandmark(record, 5020)).toEqual({
      pct: learned.pct,
      estTimeByClass: learned.estTimeByClass,
      samples: 2,
      published: true,
      source: "previous",
    });

    // One new sample: still unpublished, so previous stays the fallback.
    const one = foldAll([sample(0.31)], record, 5020);

    expect(one.previous).toBeDefined();
    expect(one.samples).toBe(1);
    expect(resolvePublishedLandmark(one, 5020)?.source).toBe("previous");

    // A second agreeing sample publishes the new geometry and drops previous.
    const two = foldAll([sample(0.3101)], one, 5020);

    expect(two).not.toHaveProperty("previous");
    expect(resolvePublishedLandmark(two, 5020)).toMatchObject({ pct: two.pct, samples: 2, source: "current" });
  });

  it("does not carry an unpublished lone sample into previous", () => {
    const rebuilt = applyTrackLength(section({ approachStart: foldAll([sample(0.2)]) }), "5.02 km", 5020);

    expect(rebuilt.landmarks.approachStart).not.toHaveProperty("previous");
    expect(resolvePublishedLandmark(rebuilt.landmarks.approachStart, 5020)).toBeNull();
  });

  it("keeps the last published previous through a second rebuild", () => {
    const learned = foldAll([sample(0.3), sample(0.3)]);
    const twice = applyTrackLength(
      applyTrackLength(section({ pitRoadEnd: learned }), "5.02 km", null),
      "5.03 km",
      null,
    );

    expect(twice.landmarks.pitRoadEnd?.previous?.pct).toBe(learned.pct);
  });

  it("resolves nothing for an absent record", () => {
    expect(resolvePublishedLandmark(undefined, TRACK_M)).toBeNull();
  });
});

describe("normalizePitLaneSection", () => {
  function roundTrip(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value));
  }

  it("round-trips a section written by this code", () => {
    const written = section({
      approachStart: foldAll([sample(0.2), sample(0.2001)]),
      blendEnd: foldAll([sample(0.999), sample(0.001)]),
    });

    expect(normalizePitLaneSection(roundTrip(written))).toEqual(written);
  });

  it("keeps unknown keys at every level", () => {
    const raw = roundTrip({
      ...section({
        pitRoadStart: {
          ...foldAll([sample(0.25)]),
          confidence: 0.9,
          previous: { pct: 0.24, estTimeByClass: {}, samples: 3, note: "x" },
        },
        pitStall: { pct: 0.26 },
      }),
      uploadedAt: "2026-12-01",
    }) as Record<string, unknown>;
    const pitRoadStart = (raw.landmarks as Record<string, Record<string, unknown>>).pitRoadStart!;

    (pitRoadStart.window as Record<string, unknown>[])[0]!.speed = 22;

    const normalized = normalizePitLaneSection(raw)!;

    expect(normalized.uploadedAt).toBe("2026-12-01");
    expect(normalized.landmarks.pitStall).toEqual({ pct: 0.26 });
    expect(normalized.landmarks.pitRoadStart?.confidence).toBe(0.9);
    expect(normalized.landmarks.pitRoadStart?.previous?.note).toBe("x");
    expect((normalized.landmarks.pitRoadStart?.window[0] as unknown as Record<string, unknown>).speed).toBe(22);
  });

  it("keeps unknown keys through fold and rebuild", () => {
    const normalized = normalizePitLaneSection(
      roundTrip({ ...section({ pitRoadEnd: { ...foldAll([sample(0.3)]), extra: 1 } }), envelope: "e" }),
    )!;
    const folded = foldSample(normalized.landmarks.pitRoadEnd, sample(0.3), NOW, null).record!;
    const rebuilt = applyTrackLength({ ...normalized, landmarks: { pitRoadEnd: folded } }, "5.1 km", null);

    expect(rebuilt.envelope).toBe("e");
    expect(rebuilt.landmarks.pitRoadEnd?.extra).toBe(1);
  });

  it("drops malformed samples and malformed values", () => {
    const good = sample(0.3);
    const normalized = normalizePitLaneSection({
      version: 1,
      trackLength: "5.00 km",
      landmarks: {
        pitRoadEnd: {
          pct: 0.3,
          estTimeByClass: { "1": 80, "2": "fast", "3": -1 },
          samples: 4,
          updatedAt: NOW,
          origin: "learned",
          window: [good, { pct: 2 }, null, "x", { ...good, key: 5 }],
          previous: { pct: "x" },
        },
      },
    })!;
    const record = normalized.landmarks.pitRoadEnd!;

    expect(record.window).toEqual([good]);
    expect(record.estTimeByClass).toEqual({ "1": 80 });
    expect(record).not.toHaveProperty("previous");
    expect(record.samples).toBe(4);
  });

  it("fills missing record fields from the window", () => {
    const normalized = normalizePitLaneSection({
      version: 1,
      trackLength: "5.00 km",
      landmarks: { pitRoadEnd: { window: [sample(0.3, { estTime: 12 }), sample(0.302, { estTime: 14 })] } },
    })!;

    expect(normalized.landmarks.pitRoadEnd).toMatchObject({
      pct: expect.closeTo(0.301, 6),
      estTimeByClass: { "1": 13 },
      samples: 2,
      updatedAt: "",
      origin: "learned",
    });
  });

  it("drops a record with no position and no samples", () => {
    const normalized = normalizePitLaneSection({
      version: 1,
      trackLength: "5.00 km",
      landmarks: { pitRoadEnd: { samples: 3 }, approachStart: "nope" },
    })!;

    expect(normalized.landmarks).toEqual({});
  });

  it("keeps an informational trackVersion and drops a malformed one", () => {
    expect(normalizePitLaneSection({ ...section({}), trackVersion: "2026.11.04.01" })?.trackVersion).toBe(
      "2026.11.04.01",
    );
    expect(normalizePitLaneSection({ ...section({}), trackVersion: null })).toHaveProperty("trackVersion", null);
    expect(normalizePitLaneSection({ ...section({}), trackVersion: 7 })).not.toHaveProperty("trackVersion");
    expect(normalizePitLaneSection(section({}))).not.toHaveProperty("trackVersion");
  });

  it("returns null for the wrong shape", () => {
    for (const bad of [
      null,
      [],
      "section",
      {},
      { version: 1, trackLength: "5 km" },
      { version: 1, trackLength: 5, landmarks: {} },
      { version: 0, trackLength: "5 km", landmarks: {} },
      { version: 1.5, trackLength: "5 km", landmarks: {} },
      { version: "1", trackLength: "5 km", landmarks: {} },
      { version: 1, trackLength: "5 km", landmarks: [] },
    ]) {
      expect(normalizePitLaneSection(bad)).toBeNull();
    }
  });

  it("detects a newer section and refuses to normalize it", () => {
    const newer = { version: PIT_LANE_SECTION_VERSION + 1, trackLength: "5 km", landmarks: {} };

    expect(isNewerPitLaneSection(newer)).toBe(true);
    expect(normalizePitLaneSection(newer)).toBeNull();
    expect(isNewerPitLaneSection(section({}))).toBe(false);
    expect(isNewerPitLaneSection({ version: "2" })).toBe(false);
    expect(isNewerPitLaneSection(null)).toBe(false);
  });

  it("never mutates its input", () => {
    const raw = deepFreeze(
      roundTrip({
        ...section({}),
        landmarks: { pitRoadEnd: { ...foldAll([sample(0.3)]), window: [sample(0.3), { bad: true }] } },
      }),
    );
    const before = structuredClone(raw);

    normalizePitLaneSection(raw);
    expect(raw).toEqual(before);
  });
});

describe("normalizePitLaneLandmarkRecord", () => {
  it("orders the window by at then key and keeps the newest up to the cap", () => {
    const window = Array.from({ length: PIT_LANE_WINDOW_CAP + 5 }, (_, index) =>
      sample(0.3, { at: 1000 + index, key: `k${String(index).padStart(2, "0")}` }),
    );
    const tieLow = sample(0.3, { at: 1000 + PIT_LANE_WINDOW_CAP + 4, key: "a" });
    const shuffled = [window[29], window[3], tieLow, ...window.slice(4, 29).reverse(), window[0], window[2], window[1]];

    const record = normalizePitLaneLandmarkRecord({ ...foldAll([sample(0.3)]), window: shuffled })!;

    expect(record.window).toHaveLength(PIT_LANE_WINDOW_CAP);
    expect(record.window).toEqual([...window.slice(6, 29), tieLow, window[29]]);
  });

  it("returns null for a non-object", () => {
    expect(normalizePitLaneLandmarkRecord(undefined)).toBeNull();
    expect(normalizePitLaneLandmarkRecord([])).toBeNull();
  });
});

describe("sample checks", () => {
  it("validates a sample", () => {
    expect(isPitLaneLandmarkSample(sample(0.3))).toBe(true);
    expect(isPitLaneLandmarkSample({ ...sample(0.3), carClassId: "1" })).toBe(false);
    expect(isPitLaneLandmarkSample(null)).toBe(false);
  });

  it("finds a duplicate in a window", () => {
    const entry = sample(0.3);

    expect(isDuplicatePitLaneSample([entry], { ...entry, at: entry.at + 1000 })).toBe(true);
    expect(isDuplicatePitLaneSample([entry], { ...entry, key: "other" })).toBe(false);
  });
});

describe("seeded landmarks", () => {
  function seededRecord(count: number): PitLaneLandmarkRecord {
    const window = Array.from({ length: count }, (_, index) => ({
      pct: 0.3 + index * 1e-5,
      estTime: 30,
      carClassId: 1,
      key: `seed:${index}`,
      at: index,
    }));

    return {
      ...normalizePitLaneLandmarkRecord({ window })!,
      origin: "seeded",
      samples: count,
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
  }

  it("publishes a seeded record with a synthetic window under the ordinary rule", () => {
    expect(resolvePublishedLandmark(seededRecord(3), TRACK_M)).toMatchObject({ source: "current", published: true });
  });

  it("is refined by local samples, which displace the seed oldest-first", () => {
    const seeded = seededRecord(PIT_LANE_WINDOW_CAP);
    const local = sample(0.31, { at: 1_000_000_000 });
    const result = foldSample(seeded, local, NOW, TRACK_M);

    expect(result.accepted).toBe(true);
    expect(result.record?.origin).toBe("seeded");
    expect(result.record?.window).toHaveLength(PIT_LANE_WINDOW_CAP);
    expect(result.record?.window.map((entry) => entry.key)).not.toContain("seed:0");
    expect(result.record?.window.at(-1)).toEqual(local);
    expect(result.record?.samples).toBe(PIT_LANE_WINDOW_CAP + 1);
  });
});
