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
 * "newer format" is the store's too: the file's `laps` section was written by
 * a build with a higher {@link LAPS_SECTION_VERSION}, so this build carries it
 * through untouched and neither reads nor writes it.
 */
export type LapStartMissReason =
  "no file" | "no session" | "no car" | "car mismatch" | "lap not recorded" | "newer format";

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
 * Whether a loaded `laps` section carries a `version` above this build's — a
 * newer build's reshaped section. The store then treats it as a section it has
 * no reader for: carried through every write verbatim, never normalized (which
 * would keep the newer version label over data this build has mangled) and
 * never written into.
 */
export function isNewerLapsSection(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object") return false;

  const version = (raw as Record<string, unknown>).version;

  return isFiniteNumber(version) && version > LAPS_SECTION_VERSION;
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

/** The earliest and latest lap-start frame recorded in a session, over every car; undefined with no laps. */
function frameSpan(session: ReplayLapsSession): { min: number; max: number } | undefined {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const car of Object.values(session.cars)) {
    for (const entry of car.laps) {
      if (entry.frame < min) min = entry.frame;

      if (entry.frame > max) max = entry.frame;
    }
  }

  return min <= max ? { min, max } : undefined;
}

/**
 * Which session a start with no pair match joins — see the rule on
 * {@link recordLapStartInSection}: the one session with that `sessionNum`,
 * when there is exactly one and the frame lies within the span of its
 * recorded lap starts. Undefined means "open a new session".
 */
function sessionJoinedByFrame(section: ReplayLapsSection, record: LapStartRecord): ReplayLapsSession | undefined {
  const sameNum = section.sessions.filter((s) => s.sessionNum === record.sessionNum);
  const only = sameNum[0];

  if (sameNum.length !== 1 || only === undefined) return undefined;

  const span = frameSpan(only);

  return span !== undefined && record.frame >= span.min && record.frame <= span.max ? only : undefined;
}

/**
 * Record that a car started a lap at a frame. Creates the session and the car
 * as needed. An existing entry for the lap takes the new frame and keeps its
 * time (the walk re-recording a lap, or a duplicated event). A car record whose
 * `carNumberRaw` differs is REPLACED: the index has been handed to another car,
 * and the old car's laps must not answer for it. A changed `userId` (a team
 * driver swap) only updates the field.
 *
 * **Which session the start goes into.** The `(sessionNum, sessionUniqueId)`
 * pair when one is recorded. Otherwise a NEW session — except when exactly one
 * recorded session has the `sessionNum` and the frame lies within the span of
 * that session's recorded lap starts (its earliest to its latest frame), in
 * which case the start joins that session. The rule separates two cases that
 * look alike by their ids:
 *
 * - A restart within one sim run is session 0 again under a NEW unique id (the
 *   2026-09-17 Homestead captures: `SessionNum` 0 under `SessionUniqueID` 1,
 *   then 0 under 2). Every lap of the new instance is recorded after every lap
 *   of the old one, because the recording's frames only grow, so its frames
 *   fall past the old span and it gets its own session, as the spec requires.
 * - The walk records a lap from INSIDE a replay under the replay's own pair,
 *   and a saved `.rpy` whose unique ids did not survive the save (or a
 *   `SessionUniqueID` read off the −1 transient) hands it a pair no live
 *   recording carries. The lap it walked to lies between laps the live
 *   recorder saw, so it lands in the live session — instead of opening a
 *   sparse second session with the same `sessionNum`, which would pair-match
 *   every later lookup from that replay and leave the `sessionNum` fallback
 *   unreachable for every other car.
 *
 * A walked lap outside the span (past the last recorded crossing) still opens
 * its own session; {@link findLapStartInSection}'s fallback reads through it.
 *
 * @returns whether the car record was replaced over a `carNumberRaw` mismatch,
 * and whether the start joined a session by `sessionNum` rather than by pair,
 * both for the caller's log
 */
export function recordLapStartInSection(
  section: ReplayLapsSection,
  record: LapStartRecord,
): { carReplaced: boolean; joinedBySessionNum: boolean } {
  let session = findSessionByPair(section, record.sessionNum, record.sessionUniqueId);
  let joinedBySessionNum = false;

  if (session === undefined) {
    session = sessionJoinedByFrame(section, record);
    joinedBySessionNum = session !== undefined;
  }

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

  return { carReplaced, joinedBySessionNum };
}

/**
 * Union `source` into `target` (the store, when a file it could not read at
 * open becomes readable while the session ran in memory: `target` is what the
 * disk holds, `source` what was recorded meanwhile). A session is matched by
 * its pair, a car by its index within the session, a lap by its number within
 * the car. Where both have an entry the one already in `target` stays — only a
 * null `timeMs` is filled from `source`, since null means "not known yet". A
 * car present in both under different `carNumberRaw` values is a different
 * car in `source`; `target`'s stays and `source`'s laps for that index are not
 * merged, because filing them under another car's number would be a wrong jump
 * later. Everything copied in is cloned; `source` is left untouched.
 */
export function mergeLapsSectionInto(target: ReplayLapsSection, source: ReplayLapsSection): void {
  for (const session of source.sessions) {
    const existing = findSessionByPair(target, session.sessionNum, session.sessionUniqueId);

    if (existing === undefined) {
      target.sessions.push(structuredClone(session));
      continue;
    }

    for (const [carIdx, car] of Object.entries(session.cars)) {
      const existingCar = existing.cars[carIdx];

      if (existingCar === undefined) {
        existing.cars[carIdx] = structuredClone(car);
        continue;
      }

      if (existingCar.carNumberRaw !== car.carNumberRaw) continue;

      for (const entry of car.laps) {
        const existingEntry = existingCar.laps.find((e) => e.lap === entry.lap);

        if (existingEntry === undefined) {
          const at = existingCar.laps.findIndex((e) => e.lap > entry.lap);

          existingCar.laps.splice(at === -1 ? existingCar.laps.length : at, 0, structuredClone(entry));
        } else if (existingEntry.timeMs === null && entry.timeMs !== null) {
          existingEntry.timeMs = entry.timeMs;
        }
      }
    }
  }
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

type LookupInSession = { hit: true; frame: number; timeMs: number | null } | { hit: false; reason: LapStartMissReason };

function lookupInSession(session: ReplayLapsSession, query: LapStartQuery): LookupInSession {
  const car = session.cars[String(query.carIdx)];

  if (car === undefined) return { hit: false, reason: "no car" };

  if (car.carNumberRaw !== query.carNumberRaw) return { hit: false, reason: "car mismatch" };

  const entry = car.laps.find((e) => e.lap === query.lap);

  if (entry === undefined) return { hit: false, reason: "lap not recorded" };

  return { hit: true, frame: entry.frame, timeMs: entry.timeMs };
}

/**
 * The frame a car started a lap at. A `carNumberRaw` mismatch is a miss, never
 * a wrong jump. `section` undefined means the file has no `laps` section.
 *
 * The session is the `(sessionNum, sessionUniqueId)` pair when one is
 * recorded. When the pair-matched session lacks the car or the lap — a sparse
 * session the walk opened under a replay's own pair (see the rule on
 * {@link recordLapStartInSection}) — the lookup falls back to the OTHER
 * sessions with that `sessionNum`, and hits when exactly one of them has the
 * car (with the same number) and the lap, `matchedBy: "sessionNum"`; otherwise
 * the pair session's miss stands. With no pair match at all — the replay's
 * telemetry offers no `SessionUniqueID`, or none is recorded — a `sessionNum`
 * held by exactly one recorded session is used, so a file whose unique ids did
 * not survive the save is still useful.
 */
export function findLapStartInSection(section: ReplayLapsSection | undefined, query: LapStartQuery): LapStartLookup {
  if (section === undefined) return { hit: false, reason: "no session" };

  const byPair =
    query.sessionUniqueId !== null && query.sessionUniqueId !== undefined
      ? findSessionByPair(section, query.sessionNum, query.sessionUniqueId)
      : undefined;
  const sameNum = section.sessions.filter((s) => s.sessionNum === query.sessionNum);

  if (byPair !== undefined) {
    const direct = lookupInSession(byPair, query);

    if (direct.hit) return { ...direct, matchedBy: "pair" };

    if (direct.reason === "car mismatch") return direct;

    const elsewhere = sameNum
      .filter((s) => s !== byPair)
      .map((s) => lookupInSession(s, query))
      .filter((r) => r.hit);
    const only = elsewhere[0];

    return elsewhere.length === 1 && only !== undefined && only.hit ? { ...only, matchedBy: "sessionNum" } : direct;
  }

  const only = sameNum[0];

  if (sameNum.length !== 1 || only === undefined) return { hit: false, reason: "no session" };

  const result = lookupInSession(only, query);

  return result.hit ? { ...result, matchedBy: "sessionNum" } : result;
}
