/**
 * The `laps` section of the per-session replay file (issue #1203): every car's
 * lap start frames and lap times, recorded live, so Jump to Fastest Lap is a
 * lookup. Pure functions over the section; the store (`replay-session-store.ts`)
 * owns it, and the translator's `replay.lapStarted` / `replay.lapTimed` events
 * reach it through the store's `laps` API.
 * Design: docs/superpowers/specs/2026-09-24-issue-1203-fastest-lap-from-session-record.md.
 *
 * Keyed by `carIdx`, VERIFIED by `carNumberRaw`: iRacing assigns the index at
 * join, and a record written for one driver must not answer for another car
 * that inherited the index. `userId` is stored for a person reading the file
 * and is not part of the match (it changes per stint in team racing).
 *
 * Per `(sessionNum, sessionUniqueId)`, not per `sessionNum`: a restart within
 * one sim run is session 0 again under a new unique id, with its own laps.
 */

/** The section's own version; the file's envelope version does not move for it. */
export const LAPS_SECTION_VERSION = 1;

/**
 * `{ lap: n, frame, timeMs }`: the car started lap `n` at `frame`; lap `n`
 * took `timeMs`. The index signatures on this and the three records below are
 * forward compatibility: a field a newer build adds at any level survives
 * this build's writes.
 */
export interface ReplayLapEntry {
  [key: string]: unknown;
  lap: number;
  frame: number;
  /** null until the sim publishes it, and forever null for a lap it never timed. */
  timeMs: number | null;
}

export interface ReplayCarLaps {
  [key: string]: unknown;
  carNumberRaw: number;
  userId: number;
  /** Ordered by lap. */
  laps: ReplayLapEntry[];
}

export interface ReplayLapsSession {
  [key: string]: unknown;
  sessionNum: number;
  sessionUniqueId: number;
  /** Keyed by `carIdx` as a string (JSON object keys). */
  cars: Record<string, ReplayCarLaps>;
}

export interface ReplayLapsSection {
  [key: string]: unknown;
  version: number;
  sessions: ReplayLapsSession[];
}

/** What `replay.lapStarted` carries, minus the session identity the store checks. */
export interface LapStartRecord {
  sessionNum: number;
  sessionUniqueId: number;
  carIdx: number;
  carNumberRaw: number;
  userId: number;
  lap: number;
  frame: number;
}

/** What `replay.lapTimed` carries. */
export interface LapTimeRecord {
  sessionNum: number;
  sessionUniqueId: number;
  carIdx: number;
  lap: number;
  timeMs: number;
}

export interface LapStartQuery {
  sessionNum: number;
  /**
   * The replay's `SessionUniqueID`, or null/undefined when its telemetry offers
   * none. With no pair match, a `sessionNum` held by exactly ONE recorded
   * session is used instead, so a file whose unique ids did not survive the
   * save is still useful.
   */
  sessionUniqueId: number | null | undefined;
  carIdx: number;
  carNumberRaw: number;
  lap: number;
}

/**
 * Why a lookup missed, worded as the action logs it: `record MISS (<reason>)`.
 * "no file" is the store's: nothing is recorded for that SubSessionID at all.
 */
export type LapStartMissReason = "no file" | "no session" | "no car" | "car mismatch" | "lap not recorded";

export type LapStartLookup =
  | {
      hit: true;
      frame: number;
      timeMs: number | null;
      /** Whether the session matched by its `(sessionNum, sessionUniqueId)` pair or by the unique-`sessionNum` fallback. */
      matchedBy: "pair" | "sessionNum";
    }
  | { hit: false; reason: LapStartMissReason };

export function emptyLapsSection(): ReplayLapsSection {
  return { version: LAPS_SECTION_VERSION, sessions: [] };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeEntry(raw: unknown): ReplayLapEntry | undefined {
  if (raw === null || typeof raw !== "object") return undefined;

  const e = raw as Record<string, unknown>;

  if (!isFiniteNumber(e.lap) || !isFiniteNumber(e.frame)) return undefined;

  return { ...e, lap: e.lap, frame: e.frame, timeMs: isFiniteNumber(e.timeMs) ? e.timeMs : null };
}

function normalizeCar(raw: unknown): ReplayCarLaps | undefined {
  if (raw === null || typeof raw !== "object") return undefined;

  const c = raw as Record<string, unknown>;

  if (!isFiniteNumber(c.carNumberRaw)) return undefined;

  const laps = Array.isArray(c.laps)
    ? c.laps.map(normalizeEntry).filter((e): e is ReplayLapEntry => e !== undefined)
    : [];

  laps.sort((a, b) => a.lap - b.lap);

  return { ...c, carNumberRaw: c.carNumberRaw, userId: isFiniteNumber(c.userId) ? c.userId : 0, laps };
}

/**
 * Read a loaded `laps` section, dropping whatever in it is not a session, a
 * car or an entry. Anything that is not a section reads as an empty one.
 */
export function normalizeLapsSection(raw: unknown): ReplayLapsSection {
  if (raw === null || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).sessions)) {
    return emptyLapsSection();
  }

  const sessions: ReplayLapsSession[] = [];

  for (const candidate of (raw as { sessions: unknown[] }).sessions) {
    if (candidate === null || typeof candidate !== "object") continue;

    const s = candidate as Record<string, unknown>;

    if (!isFiniteNumber(s.sessionNum) || !isFiniteNumber(s.sessionUniqueId)) continue;

    const cars: Record<string, ReplayCarLaps> = {};

    if (s.cars !== null && typeof s.cars === "object" && !Array.isArray(s.cars)) {
      for (const [carIdx, car] of Object.entries(s.cars as Record<string, unknown>)) {
        const normalized = normalizeCar(car);

        if (normalized !== undefined) cars[carIdx] = normalized;
      }
    }

    sessions.push({ ...s, sessionNum: s.sessionNum, sessionUniqueId: s.sessionUniqueId, cars });
  }

  const rawVersion = (raw as Record<string, unknown>).version;

  return {
    ...(raw as Record<string, unknown>),
    // Never downgrade a newer build's section version on the way through.
    version: isFiniteNumber(rawVersion) ? Math.max(rawVersion, LAPS_SECTION_VERSION) : LAPS_SECTION_VERSION,
    sessions,
  };
}

function findSessionByPair(
  section: ReplayLapsSection,
  sessionNum: number,
  sessionUniqueId: number,
): ReplayLapsSession | undefined {
  return section.sessions.find((s) => s.sessionNum === sessionNum && s.sessionUniqueId === sessionUniqueId);
}

/**
 * The session a lookup reads: the `(sessionNum, sessionUniqueId)` pair, else
 * the one session with that `sessionNum` when there is exactly one.
 */
function resolveSessionForLookup(
  section: ReplayLapsSection,
  query: LapStartQuery,
): { session: ReplayLapsSession; matchedBy: "pair" | "sessionNum" } | undefined {
  if (query.sessionUniqueId !== null && query.sessionUniqueId !== undefined) {
    const byPair = findSessionByPair(section, query.sessionNum, query.sessionUniqueId);

    if (byPair !== undefined) return { session: byPair, matchedBy: "pair" };
  }

  const bySessionNum = section.sessions.filter((s) => s.sessionNum === query.sessionNum);

  return bySessionNum.length === 1 && bySessionNum[0] !== undefined
    ? { session: bySessionNum[0], matchedBy: "sessionNum" }
    : undefined;
}

/**
 * Record that a car started a lap at a frame. Creates the session and the car
 * as needed. An existing entry for the lap takes the new frame and keeps its
 * time (the walk re-recording a lap, or a duplicated event). A car record whose
 * `carNumberRaw` differs is REPLACED: the index has been handed to another car,
 * and the old car's laps must not answer for it. A changed `userId` (a team
 * driver swap) only updates the field.
 *
 * @returns whether the car record was replaced over a `carNumberRaw` mismatch, for the caller's log
 */
export function recordLapStartInSection(section: ReplayLapsSection, record: LapStartRecord): { carReplaced: boolean } {
  let session = findSessionByPair(section, record.sessionNum, record.sessionUniqueId);

  if (session === undefined) {
    session = { sessionNum: record.sessionNum, sessionUniqueId: record.sessionUniqueId, cars: {} };
    section.sessions.push(session);
  }

  const key = String(record.carIdx);
  let car: ReplayCarLaps | undefined = session.cars[key];
  let carReplaced = false;

  if (car !== undefined && car.carNumberRaw !== record.carNumberRaw) {
    car = undefined;
    carReplaced = true;
  }

  if (car === undefined) {
    car = { carNumberRaw: record.carNumberRaw, userId: record.userId, laps: [] };
    session.cars[key] = car;
  } else if (car.userId !== record.userId) {
    car.userId = record.userId;
  }

  const existing = car.laps.find((e) => e.lap === record.lap);

  if (existing !== undefined) {
    existing.frame = record.frame;
  } else {
    const at = car.laps.findIndex((e) => e.lap > record.lap);

    car.laps.splice(at === -1 ? car.laps.length : at, 0, { lap: record.lap, frame: record.frame, timeMs: null });
  }

  return { carReplaced };
}

/**
 * Pair a lap time with its start entry. Returns false when the session, the
 * car or the lap's start is not recorded — the store then keeps the time
 * pending and pairs it when the start arrives.
 */
export function recordLapTimeInSection(section: ReplayLapsSection, record: LapTimeRecord): boolean {
  const entry = findSessionByPair(section, record.sessionNum, record.sessionUniqueId)?.cars[
    String(record.carIdx)
  ]?.laps.find((e) => e.lap === record.lap);

  if (entry === undefined) return false;

  entry.timeMs = record.timeMs;

  return true;
}

/**
 * The frame a car started a lap at. A `carNumberRaw` mismatch is a miss, never
 * a wrong jump. `section` undefined means the file has no `laps` section.
 */
export function findLapStartInSection(section: ReplayLapsSection | undefined, query: LapStartQuery): LapStartLookup {
  if (section === undefined) return { hit: false, reason: "no session" };

  const resolved = resolveSessionForLookup(section, query);

  if (resolved === undefined) return { hit: false, reason: "no session" };

  const car = resolved.session.cars[String(query.carIdx)];

  if (car === undefined) return { hit: false, reason: "no car" };

  if (car.carNumberRaw !== query.carNumberRaw) return { hit: false, reason: "car mismatch" };

  const entry = car.laps.find((e) => e.lap === query.lap);

  if (entry === undefined) return { hit: false, reason: "lap not recorded" };

  return { hit: true, frame: entry.frame, timeMs: entry.timeMs, matchedBy: resolved.matchedBy };
}
