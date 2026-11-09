/**
 * Learned pit-lane landmarks (issue #1112): the pure model behind the
 * per-track pit-lane file.
 *
 * A sim reports which state a car is in (approaching the pits, between the
 * cones, back on track) but not the positions at which those states change —
 * iRacing, the one sim read today, does not. A sim's translator turns each
 * observed edge into a {@link PitLaneLandmarkSample};
 * this module folds samples into a windowed record whose position is the
 * circular median of the window, decides when a landmark is trustworthy enough
 * to publish, and handles a track rebuild. It does no IO and reads no clock:
 * every timestamp is an argument, so the store, the translator and the tests
 * all fold samples identically.
 *
 * These are LEARNED values, measured from live telemetry. They are not Lovely
 * Sim Racing data and carry none of its licence terms (`attribution.ts`).
 *
 * The file format defined here is frozen: it is the upload payload of the
 * later shared database, so every function keeps keys it does not know about.
 * Design record: `docs/superpowers/specs/2026-09-04-issue-1112-pit-lane-landmarks.md`
 * (with its 2026-11-09 amendments).
 */

/** The four learned landmarks, in driving order. */
export const PIT_LANE_LANDMARK_NAMES = ["approachStart", "pitRoadStart", "pitRoadEnd", "blendEnd"] as const;

/** One of {@link PIT_LANE_LANDMARK_NAMES}. */
export type PitLaneLandmarkName = (typeof PIT_LANE_LANDMARK_NAMES)[number];

/**
 * One accepted edge: one car crossing one landmark once. The examples name
 * iRacing's telemetry, the one sim read today; another sim fills each field
 * from its own equivalent.
 */
export interface PitLaneLandmarkSample {
  /**
   * Where the edge happened, as a fraction of the lap from the start/finish
   * line, `0 <= pct < 1`: the wrap-aware midpoint of the edge's two ticks
   * (iRacing: `CarIdxLapDistPct`).
   */
  pct: number;
  /**
   * The sim's reference time to this point of the lap for the car's class, in
   * seconds from the start/finish line, read on the landmark's side of the
   * line (iRacing: `CarIdxEstTime`).
   */
  estTime: number;
  /** The sim's id of the car's class (iRacing: `CarIdxClass`). */
  carClassId: number;
  /**
   * Opaque: unique per crossing of one landmark by one car, so two processes
   * watching one session make the same key for one edge. Its publisher builds
   * it (iRacing's translator: `<subSessionId>:<sessionNum>:<carIdx>:<landmark>:<lap>`);
   * nothing parses it.
   */
  key: string;
  /** Epoch ms (wall clock) when the sample was accepted. */
  at: number;
}

/**
 * The track a landmark belongs to, carried by the event and the file
 * envelope. The raw names travel with the id so a record can be re-keyed if
 * the identity scheme changes, and the raw length so a rebuilt track is
 * noticed. The examples are iRacing's; the id and class key types are
 * revisited by the second-sim state-model spike (#714).
 */
export interface PitLaneTrackIdentity {
  /**
   * The simulator the track belongs to, e.g. `"iracing"`: lowercase letters,
   * digits and hyphens, starting with a letter or digit (the store names a
   * folder after it). Every other field is read in this sim's terms.
   */
  sim: string;
  /** The sim's id of the track layout (iRacing: `WeekendInfo.TrackID`). */
  trackId: number;
  /** The sim's name of the track (iRacing: `WeekendInfo.TrackName`). */
  trackName: string;
  /** The sim's name of the layout, `""` when it has none (iRacing: `WeekendInfo.TrackConfigName`). */
  trackConfigName: string;
  /**
   * The track length exactly as the sim reports it (iRacing:
   * `WeekendInfo.TrackLength`, e.g. `"5.51 km"`). Compared as a string: a
   * change is a rebuild ({@link applyTrackLength}).
   */
  trackLength: string;
  /** That length in metres, or `null` when it does not parse. */
  trackLengthM: number | null;
  /**
   * The sim's track version as reported, or `null` when it reports none
   * (iRacing: `WeekendInfo.TrackVersion`). Informational only: it can move on
   * any update of the sim whether or not the geometry changed, so the rebuild
   * rule stays on `trackLength`.
   */
  trackVersion: string | null;
}

/** What consumers read (translator accessor) and the event's summary. */
export interface PitLaneLandmarkSummary {
  pct: number;
  /**
   * Class id (string) → median estTime, for classes with at least one window
   * sample within tolerance of the median and on its side of S/F.
   */
  estTimeByClass: Record<string, number>;
  /** Accepted samples that entered the window, since the last rebuild. */
  samples: number;
  published: boolean;
}

/**
 * Where a landmark record came from. `learned` is the only origin written
 * today; `seeded` is reserved for the bundled shared snapshot. Typed open so
 * an origin a newer writer introduces survives a round trip.
 *
 * A seeded landmark needs no logic of its own: it ships as an ordinary
 * {@link PitLaneLandmarkRecord} with `origin: "seeded"` and a synthetic window
 * (keys `seed:<n>`, old `at` values), so it publishes under the ordinary rule
 * and local samples displace its window oldest-first. The origin is kept on
 * fold.
 */
export type PitLaneLandmarkOrigin = "learned" | "seeded" | (string & {});

/**
 * The values a landmark had published before a track rebuild
 * ({@link applyTrackLength}), kept so a consumer can fall back to them until
 * the new geometry is published.
 */
export interface PitLaneLandmarkPrevious {
  pct: number;
  estTimeByClass: Record<string, number>;
  samples: number;
  [key: string]: unknown;
}

/**
 * One landmark in the pit-lane section of a track file.
 *
 * `samples: 0` with an empty window means "not learned under the current
 * geometry": after a rebuild ({@link applyTrackLength}) the record keeps its
 * pre-rebuild `pct` and `estTimeByClass` only so the record (and its unknown
 * keys) survives. Never read them as current; {@link resolvePublishedLandmark}
 * does not.
 */
export interface PitLaneLandmarkRecord {
  /** Circular median of the window's positions, normalized to `[0, 1)`. */
  pct: number;
  /**
   * Per class id (string): median estTime of that class's window samples that
   * lie within tolerance of the median and on its side of S/F.
   */
  estTimeByClass: Record<string, number>;
  /** Accepted samples that entered the window, since the last rebuild (not capped by the window). */
  samples: number;
  /** ISO time the record last changed: the `now` of the last accepting {@link foldSample}. */
  updatedAt: string;
  origin: PitLaneLandmarkOrigin;
  /**
   * The most recent accepted samples, at most {@link PIT_LANE_WINDOW_CAP},
   * ordered by `at` then `key` (oldest first).
   */
  window: PitLaneLandmarkSample[];
  /** Published values from before the last rebuild; dropped once this landmark publishes again. */
  previous?: PitLaneLandmarkPrevious;
  [key: string]: unknown;
}

/**
 * The landmarks of one section. Known names map to a record; an entry under a
 * name this version does not know is kept as it was read.
 */
export type PitLaneLandmarks = Partial<Record<PitLaneLandmarkName, PitLaneLandmarkRecord>> & {
  [key: string]: unknown;
};

/** The pit-lane section of a per-track file. */
export interface PitLaneSection {
  /** {@link PIT_LANE_SECTION_VERSION} when written by this code. */
  version: number;
  /** The identity's `trackLength` the landmarks were learned under; a change means a rebuild. */
  trackLength: string;
  /**
   * The identity's `trackVersion` when the store last wrote the section.
   * Informational only; the rebuild rule reads `trackLength`.
   */
  trackVersion?: string | null;
  landmarks: PitLaneLandmarks;
  [key: string]: unknown;
}

/**
 * Version of the pit-lane section this code reads and writes. Bumped by any
 * change an older host would misread rather than ignore: a different
 * {@link PIT_LANE_WINDOW_CAP} (an older host would mis-trim the window), a new
 * landmark name, or a new record field derived from the window or the
 * geometry (an older host would carry it stale across a rebuild).
 */
export const PIT_LANE_SECTION_VERSION = 1;

/**
 * Samples kept per landmark. A reasoned default, to be tuned on captures:
 * enough for a stable median against a few outliers, small enough that a
 * changed pit entry is relearned within a session or two. Changing it needs a
 * {@link PIT_LANE_SECTION_VERSION} bump.
 */
export const PIT_LANE_WINDOW_CAP = 25;

/**
 * Window samples that must lie within tolerance of the median before a
 * landmark is published. A reasoned default, to be tuned on captures: one
 * sample is remembered but never trusted.
 */
export const PIT_LANE_MIN_AGREEING_SAMPLES = 2;

/**
 * How far from the median (metres along the track) a sample may lie and still
 * agree — a half-width, so two samples up to twice this apart agree. A
 * reasoned default, to be tuned on captures: one 60 Hz tick is about a metre
 * at pit speed and several at track speed.
 */
export const PIT_LANE_TOLERANCE_M = 15;

/**
 * {@link PIT_LANE_TOLERANCE_M} as a lap fraction, used when the track length is
 * unknown. A reasoned default, to be tuned on captures: 15 m on a track of
 * about 3.75 km.
 */
export const PIT_LANE_TOLERANCE_PCT = 0.004;

/**
 * Two samples with the same key count as one when their `at` lies closer than
 * this. A reasoned default, to be tuned on captures: two processes watching
 * the same session see the same edge within a second or two, while the same
 * car can reach the same landmark on the same lap number again only after a
 * session restart, minutes later.
 */
export const PIT_LANE_DUPLICATE_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Wrap-aware helpers
// ---------------------------------------------------------------------------

/** Normalize a lap fraction into `[0, 1)`. */
export function normalizePitLanePct(pct: number): number {
  const wrapped = pct - Math.floor(pct);

  // A tiny negative input rounds to exactly 1.
  return wrapped >= 1 ? 0 : wrapped;
}

/**
 * Signed shortest distance from `from` to `to` around the lap, in
 * `[-0.5, 0.5)`. Positive means `to` lies ahead in driving direction:
 * `pitLaneSignedDeltaPct(0.99, 0.01)` is `0.02`.
 */
export function pitLaneSignedDeltaPct(from: number, to: number): number {
  let delta = (to - from) % 1;

  if (delta >= 0.5) delta -= 1;
  else if (delta < -0.5) delta += 1;

  return delta;
}

/** Midpoint of two lap fractions along the shorter arc, normalized to `[0, 1)`. */
export function pitLaneMidpointPct(a: number, b: number): number {
  return normalizePitLanePct(a + pitLaneSignedDeltaPct(a, b) / 2);
}

function linearMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Median of lap fractions that may straddle the S/F line, normalized to
 * `[0, 1)`; `null` for no values.
 *
 * Every value is unwrapped around a reference — the value with the smallest
 * total arc distance to the others, so an outlier never becomes the reference
 * — which orders `0.998`, `0.999`, `0.001` as they are driven. The median of
 * the unwrapped values is then wrapped back.
 */
export function pitLaneCircularMedianPct(values: readonly number[]): number | null {
  if (values.length === 0) return null;

  let reference = values[0]!;
  let bestSpread = Infinity;

  for (const candidate of values) {
    let spread = 0;

    for (const other of values) spread += Math.abs(pitLaneSignedDeltaPct(candidate, other));

    if (spread < bestSpread) {
      bestSpread = spread;
      reference = candidate;
    }
  }

  return normalizePitLanePct(linearMedian(values.map((value) => reference + pitLaneSignedDeltaPct(reference, value))));
}

/** The agreement tolerance as a lap fraction, from the track length in metres when known. */
export function pitLaneTolerancePct(trackLengthM: number | null): number {
  return trackLengthM !== null && Number.isFinite(trackLengthM) && trackLengthM > 0
    ? PIT_LANE_TOLERANCE_M / trackLengthM
    : PIT_LANE_TOLERANCE_PCT;
}

// ---------------------------------------------------------------------------
// Folding samples
// ---------------------------------------------------------------------------

/** Whether a value is a well-formed {@link PitLaneLandmarkSample}. */
export function isPitLaneLandmarkSample(value: unknown): value is PitLaneLandmarkSample {
  if (!isPlainObject(value)) return false;

  const { pct, estTime, carClassId, key, at } = value;

  return (
    isFiniteNumber(pct) &&
    pct >= 0 &&
    pct < 1 &&
    isFiniteNumber(estTime) &&
    estTime >= 0 &&
    isFiniteNumber(carClassId) &&
    typeof key === "string" &&
    key.length > 0 &&
    isFiniteNumber(at)
  );
}

/**
 * The outcome of {@link foldSample}. On a rejection `record` is the input,
 * untouched. `stale` is a sample older than every sample of a full window,
 * which would be evicted the moment it entered.
 */
export type PitLaneFoldResult =
  | { accepted: true; record: PitLaneLandmarkRecord }
  | { accepted: false; reason: "duplicate" | "stale"; record: PitLaneLandmarkRecord }
  | { accepted: false; reason: "invalid"; record: PitLaneLandmarkRecord | undefined };

/** Window order: by `at`, then by `key`, so eviction on a tie is deterministic. */
function compareSamples(a: PitLaneLandmarkSample, b: PitLaneLandmarkSample): number {
  if (a.at !== b.at) return a.at - b.at;

  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Sort by {@link compareSamples} and keep the newest {@link PIT_LANE_WINDOW_CAP}. Returns a new array. */
function orderAndTrim(window: readonly PitLaneLandmarkSample[]): PitLaneLandmarkSample[] {
  const ordered = [...window].sort(compareSamples);

  return ordered.slice(Math.max(0, ordered.length - PIT_LANE_WINDOW_CAP));
}

/**
 * Whether `sample` is already in `window`: the same key, accepted less than
 * {@link PIT_LANE_DUPLICATE_WINDOW_MS} apart.
 */
export function isDuplicatePitLaneSample(
  window: readonly PitLaneLandmarkSample[],
  sample: PitLaneLandmarkSample,
): boolean {
  return window.some(
    (existing) => existing.key === sample.key && Math.abs(sample.at - existing.at) < PIT_LANE_DUPLICATE_WINDOW_MS,
  );
}

/**
 * Per class, the median estTime of the window samples that agree with
 * `medianPct` (within `tolerancePct`) and lie on its side of the S/F line. An
 * outlier's time belongs to the wrong place on track, and the estTime
 * restarts at 0 on the line (iRacing's `CarIdxEstTime` does), so a sample unwrapped across it would mix a
 * near-zero time with a near-lap one.
 */
function estTimeByClassFor(
  window: readonly PitLaneLandmarkSample[],
  medianPct: number,
  tolerancePct: number,
): Record<string, number> {
  const byClass = new Map<string, number[]>();

  for (const sample of window) {
    const delta = pitLaneSignedDeltaPct(medianPct, sample.pct);
    const unwrapped = medianPct + delta;

    if (Math.abs(delta) > tolerancePct || unwrapped < 0 || unwrapped >= 1) continue;

    const classKey = String(sample.carClassId);
    const times = byClass.get(classKey);

    if (times) times.push(sample.estTime);
    else byClass.set(classKey, [sample.estTime]);
  }

  const result: Record<string, number> = {};

  for (const [classKey, times] of byClass) result[classKey] = linearMedian(times);

  return result;
}

function countAgreeing(window: readonly PitLaneLandmarkSample[], medianPct: number, tolerancePct: number): number {
  return window.filter((sample) => Math.abs(pitLaneSignedDeltaPct(medianPct, sample.pct)) <= tolerancePct).length;
}

/**
 * Fold one sample into a landmark record, returning a new record; neither
 * argument is mutated.
 *
 * Rejected, with the input returned: a malformed sample (`invalid`), a
 * duplicate of one in the window (same key, under
 * {@link PIT_LANE_DUPLICATE_WINDOW_MS} apart; `duplicate`), and a sample that
 * would be evicted at once because the window is full and it sorts before all
 * of it (`stale`). Otherwise the sample joins the window (ordered by `at`
 * then `key`, the oldest dropped past {@link PIT_LANE_WINDOW_CAP}), `samples`
 * grows by one, `pct` and `estTimeByClass` are recomputed from the window,
 * `updatedAt` becomes `now`, and `previous` is dropped once the landmark is
 * published again. A new record's origin is `learned`; an existing origin is
 * kept.
 *
 * @param now ISO timestamp written to `updatedAt`.
 * @param trackLengthM Track length in metres for the tolerance; `null` uses
 *   {@link PIT_LANE_TOLERANCE_PCT}.
 */
export function foldSample(
  record: PitLaneLandmarkRecord | undefined,
  sample: PitLaneLandmarkSample,
  now: string,
  trackLengthM: number | null,
): PitLaneFoldResult {
  if (!isPitLaneLandmarkSample(sample)) return { accepted: false, reason: "invalid", record };

  if (record && isDuplicatePitLaneSample(record.window, sample)) {
    return { accepted: false, reason: "duplicate", record };
  }

  const entry = { ...sample };
  const window = orderAndTrim([...(record?.window ?? []), entry]);

  if (record && !window.includes(entry)) return { accepted: false, reason: "stale", record };

  const pct = pitLaneCircularMedianPct(window.map((kept) => kept.pct))!;
  const next: PitLaneLandmarkRecord = {
    ...record,
    pct,
    estTimeByClass: estTimeByClassFor(window, pct, pitLaneTolerancePct(trackLengthM)),
    samples: (record?.samples ?? 0) + 1,
    updatedAt: now,
    origin: record?.origin ?? "learned",
    window,
  };

  if (next.previous !== undefined && isPublished(next, trackLengthM)) delete next.previous;

  return { accepted: true, record: next };
}

function isPublished(record: PitLaneLandmarkRecord, trackLengthM: number | null): boolean {
  const median = pitLaneCircularMedianPct(record.window.map((sample) => sample.pct));

  if (median === null) return false;

  return countAgreeing(record.window, median, pitLaneTolerancePct(trackLengthM)) >= PIT_LANE_MIN_AGREEING_SAMPLES;
}

/**
 * The consumer-facing summary of a record. `published` holds once at least
 * {@link PIT_LANE_MIN_AGREEING_SAMPLES} window samples lie within tolerance
 * ({@link pitLaneTolerancePct}) of the window's circular median.
 */
export function summarizeLandmark(record: PitLaneLandmarkRecord, trackLengthM: number | null): PitLaneLandmarkSummary {
  return {
    pct: record.pct,
    estTimeByClass: { ...record.estTimeByClass },
    samples: record.samples,
    published: isPublished(record, trackLengthM),
  };
}

/** A published landmark as a consumer sees it, with where the values came from. */
export type PitLaneResolvedLandmark = PitLaneLandmarkSummary & {
  /** `current` when learned under this geometry; `previous` while a rebuilt track is relearned. */
  source: "current" | "previous";
};

/**
 * What a consumer may use for one landmark: the current values when
 * published, else the pre-rebuild `previous` values when present, else `null`
 * — never a guess (spec decision 5).
 */
export function resolvePublishedLandmark(
  record: PitLaneLandmarkRecord | undefined,
  trackLengthM: number | null,
): PitLaneResolvedLandmark | null {
  if (!record) return null;

  const summary = summarizeLandmark(record, trackLengthM);

  if (summary.published) return { ...summary, source: "current" };

  if (record.previous) {
    return {
      pct: record.previous.pct,
      estTimeByClass: { ...record.previous.estTimeByClass },
      samples: record.previous.samples,
      published: true,
      source: "previous",
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Track rebuilds
// ---------------------------------------------------------------------------

/**
 * Bring a section in line with the session's track length (the identity's
 * `trackLength`).
 *
 * No section yields an empty one. An equal length returns the section itself.
 * A different length means the track was rebuilt: every landmark that was
 * published moves its `pct`, `estTimeByClass` and `samples` into `previous`
 * (one that was not keeps any `previous` it already had, so a second rebuild
 * before relearning still falls back to the last published geometry), and its
 * window and count reset (see {@link PitLaneLandmarkRecord} for what the
 * remaining values mean). `trackVersion` and every other section key are left
 * as they were; the store writes `trackVersion`. Nothing is mutated.
 *
 * @param trackLengthM The session's length in metres, used to judge which
 *   landmarks were published; a rebuild changes the length only slightly, so
 *   the new length stands in for the old one. `null` uses
 *   {@link PIT_LANE_TOLERANCE_PCT}.
 */
export function applyTrackLength(
  section: PitLaneSection | undefined,
  trackLength: string,
  trackLengthM: number | null,
): PitLaneSection {
  if (!section) return { version: PIT_LANE_SECTION_VERSION, trackLength, landmarks: {} };

  if (section.trackLength === trackLength) return section;

  const landmarks: PitLaneLandmarks = { ...section.landmarks };

  for (const name of PIT_LANE_LANDMARK_NAMES) {
    const record = section.landmarks[name];

    if (!record) continue;

    const reset: PitLaneLandmarkRecord = { ...record, samples: 0, window: [] };

    if (isPublished(record, trackLengthM)) {
      reset.previous = {
        pct: record.pct,
        estTimeByClass: { ...record.estTimeByClass },
        samples: record.samples,
      };
    }

    landmarks[name] = reset;
  }

  return { ...section, trackLength, landmarks };
}

// ---------------------------------------------------------------------------
// Reading a section from JSON
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidPct(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value < 1;
}

function isCount(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

/** Keep only entries whose value is a finite, non-negative number. */
function normalizeEstTimeByClass(raw: unknown): Record<string, number> {
  const result: Record<string, number> = {};

  if (!isPlainObject(raw)) return result;

  for (const [classKey, value] of Object.entries(raw)) {
    if (isFiniteNumber(value) && value >= 0) result[classKey] = value;
  }

  return result;
}

function normalizePrevious(raw: unknown): PitLaneLandmarkPrevious | undefined {
  if (!isPlainObject(raw) || !isValidPct(raw.pct)) return undefined;

  return {
    ...raw,
    pct: raw.pct,
    estTimeByClass: normalizeEstTimeByClass(raw.estTimeByClass),
    samples: isCount(raw.samples) ? raw.samples : 0,
  };
}

/**
 * Read one landmark record leniently: malformed samples are dropped from the
 * window, which is then ordered by `at` then `key` and trimmed to the newest
 * {@link PIT_LANE_WINDOW_CAP}; a missing or malformed count falls back to the
 * window's size; a missing `pct` is recomputed from the window, and a missing
 * `estTimeByClass` too (with {@link PIT_LANE_TOLERANCE_PCT}, since no track
 * length is known here); unknown keys are kept. A record with neither a valid
 * `pct` nor any valid sample is `null`.
 */
export function normalizePitLaneLandmarkRecord(raw: unknown): PitLaneLandmarkRecord | null {
  if (!isPlainObject(raw)) return null;

  const window = orderAndTrim(
    (Array.isArray(raw.window) ? raw.window : []).filter(isPitLaneLandmarkSample).map((sample) => ({ ...sample })),
  );
  const pct = isValidPct(raw.pct) ? raw.pct : pitLaneCircularMedianPct(window.map((sample) => sample.pct));

  if (pct === null) return null;

  const record: PitLaneLandmarkRecord = {
    ...raw,
    pct,
    estTimeByClass: isPlainObject(raw.estTimeByClass)
      ? normalizeEstTimeByClass(raw.estTimeByClass)
      : estTimeByClassFor(window, pct, pitLaneTolerancePct(null)),
    samples: isCount(raw.samples) ? raw.samples : window.length,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    origin: typeof raw.origin === "string" ? raw.origin : "learned",
    window,
  };
  const previous = normalizePrevious(raw.previous);

  if (previous) record.previous = previous;
  else delete record.previous;

  return record;
}

/**
 * Whether a value read from a file is a pit-lane section written by a newer
 * version of this code. Such a section must be neither rewritten nor moved
 * aside as corrupt: {@link normalizePitLaneSection} returns `null` for it.
 */
export function isNewerPitLaneSection(raw: unknown): boolean {
  return isPlainObject(raw) && isFiniteNumber(raw.version) && raw.version > PIT_LANE_SECTION_VERSION;
}

/**
 * Read a pit-lane section from parsed JSON. `null` when the shape is wrong
 * (not an object, no integer `version` from 1 up, no string `trackLength`, no
 * `landmarks` object) or when the version is newer than this code
 * ({@link isNewerPitLaneSection}). Records under known landmark names are read
 * with {@link normalizePitLaneLandmarkRecord} and dropped when unusable;
 * entries under unknown names, and unknown keys at every level, are kept. A
 * `trackVersion` that is neither a string nor `null` is dropped.
 */
export function normalizePitLaneSection(raw: unknown): PitLaneSection | null {
  if (!isPlainObject(raw)) return null;

  const { version, trackLength, landmarks } = raw;

  if (!isCount(version) || version < 1 || version > PIT_LANE_SECTION_VERSION) return null;

  if (typeof trackLength !== "string" || !isPlainObject(landmarks)) return null;

  const normalized: PitLaneLandmarks = { ...landmarks };

  for (const name of PIT_LANE_LANDMARK_NAMES) {
    if (!(name in landmarks)) continue;

    const record = normalizePitLaneLandmarkRecord(landmarks[name]);

    if (record) normalized[name] = record;
    else delete normalized[name];
  }

  const section: PitLaneSection = { ...raw, version, trackLength, landmarks: normalized };

  if ("trackVersion" in section && typeof section.trackVersion !== "string" && section.trackVersion !== null) {
    delete section.trackVersion;
  }

  return section;
}
