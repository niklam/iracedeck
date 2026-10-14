/**
 * The `sessions` section of the per-session replay file (issue #1426): the
 * frame each session of the recording began at, recorded the moment the
 * session is first seen live, so Next / Previous Session can step through the
 * record. Pure functions over the section; the store (`replay-session-store.ts`)
 * owns it, and the translator's `replay.sessionStarted` event reaches it
 * through the store's `sessions` API.
 * Design: docs/superpowers/specs/2026-10-12-issue-1426-replay-record-steps.md.
 *
 * One entry per `(sessionNum, sessionUniqueId)` pair, held in frame order. A
 * restarted offline event puts the same `sessionNum` on the tape again under a
 * new unique id: that is a new entry further along the tape. Nothing here
 * looks a session up by its number; every step is by frame.
 */

/** The section's own version; the file's envelope version does not move for it. */
export const SESSIONS_SECTION_VERSION = 1;

/**
 * `{ sessionNum, sessionUniqueId, frame }`: the session began at `frame`. The
 * index signatures on this and the section are forward compatibility: a field
 * a newer build adds at either level survives this build's writes.
 */
export interface ReplaySessionStart {
  [key: string]: unknown;
  sessionNum: number;
  sessionUniqueId: number;
  /** The live replay frame the session began at; 0 when it began before the recording. */
  frame: number;
}

export interface ReplaySessionsSection {
  [key: string]: unknown;
  version: number;
  /** Ordered by frame; one entry per `(sessionNum, sessionUniqueId)`. */
  sessions: ReplaySessionStart[];
}

/** What `replay.sessionStarted` carries, minus the session identity the store checks. */
export interface SessionStartRecord {
  sessionNum: number;
  sessionUniqueId: number;
  frame: number;
}

export function emptySessionsSection(): ReplaySessionsSection {
  return { version: SESSIONS_SECTION_VERSION, sessions: [] };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Whether a loaded `sessions` section carries a `version` above this build's —
 * a newer build's reshaped section. The store then treats it as a section it
 * has no reader for: carried through every write verbatim, never normalized
 * and never written into.
 */
export function isNewerSessionsSection(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object") return false;

  const version = (raw as Record<string, unknown>).version;

  return isFiniteNumber(version) && version > SESSIONS_SECTION_VERSION;
}

/**
 * Read a loaded `sessions` section, dropping whatever in it is not an entry (an
 * object with a finite `sessionNum`, `sessionUniqueId` and `frame`) and putting
 * the entries in frame order. Anything that is not a section reads as an empty
 * one.
 */
export function normalizeSessionsSection(raw: unknown): ReplaySessionsSection {
  if (raw === null || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).sessions)) {
    return emptySessionsSection();
  }

  const sessions: ReplaySessionStart[] = [];

  for (const candidate of (raw as { sessions: unknown[] }).sessions) {
    if (candidate === null || typeof candidate !== "object") continue;

    const s = candidate as Record<string, unknown>;

    if (!isFiniteNumber(s.sessionNum) || !isFiniteNumber(s.sessionUniqueId) || !isFiniteNumber(s.frame)) continue;

    sessions.push({ ...s, sessionNum: s.sessionNum, sessionUniqueId: s.sessionUniqueId, frame: s.frame });
  }

  sessions.sort((a, b) => a.frame - b.frame);

  const rawVersion = (raw as Record<string, unknown>).version;

  return {
    ...(raw as Record<string, unknown>),
    // Never downgrade a newer build's section version on the way through.
    version: isFiniteNumber(rawVersion) ? Math.max(rawVersion, SESSIONS_SECTION_VERSION) : SESSIONS_SECTION_VERSION,
    sessions,
  };
}

function hasPair(section: ReplaySessionsSection, sessionNum: number, sessionUniqueId: number): boolean {
  return section.sessions.some((s) => s.sessionNum === sessionNum && s.sessionUniqueId === sessionUniqueId);
}

/** Insert in frame order, after any entry already at that frame. */
function insertByFrame(sessions: ReplaySessionStart[], entry: ReplaySessionStart): void {
  const at = sessions.findIndex((s) => s.frame > entry.frame);

  sessions.splice(at === -1 ? sessions.length : at, 0, entry);
}

/**
 * Record a session's start. The first start recorded for a
 * `(sessionNum, sessionUniqueId)` pair stays: a second record for the same
 * pair changes nothing, whatever its frame. A pair not yet recorded is a new
 * entry, inserted in frame order — a restarted event's second instance of a
 * `sessionNum` included.
 *
 * @returns whether the section changed — false for a pair already recorded,
 * which the store then does not write
 */
export function recordSessionStartInSection(section: ReplaySessionsSection, record: SessionStartRecord): boolean {
  if (hasPair(section, record.sessionNum, record.sessionUniqueId)) return false;

  insertByFrame(section.sessions, {
    sessionNum: record.sessionNum,
    sessionUniqueId: record.sessionUniqueId,
    frame: record.frame,
  });

  return true;
}

/**
 * Union `source` into `target` (the store, when a file it could not read at
 * open becomes readable while the session ran in memory: `target` is what the
 * disk holds, `source` what was recorded meanwhile). An entry is matched by
 * its pair; where both have one the entry already in `target` stays. Nothing
 * already in `target` is moved, changed or removed. Everything copied in is
 * cloned; `source` is left untouched.
 */
export function mergeSessionsSectionInto(target: ReplaySessionsSection, source: ReplaySessionsSection): void {
  for (const entry of source.sessions) {
    if (!hasPair(target, entry.sessionNum, entry.sessionUniqueId))
      insertByFrame(target.sessions, structuredClone(entry));
  }
}

/**
 * Every recorded session start, in frame order, as copies the caller cannot
 * change the section through. `section` undefined (the file has no `sessions`
 * section) is an empty list.
 */
export function listSessionStartsInSection(section: ReplaySessionsSection | undefined): ReplaySessionStart[] {
  if (section === undefined) return [];

  return section.sessions.map((s) => ({ ...s })).sort((a, b) => a.frame - b.frame);
}

/**
 * Why the store could not list the session starts, worded as the action logs
 * it: `record MISS (<reason>)`. "no file": nothing is recorded for that
 * SubSessionID at all. "newer format": the file's `sessions` section was
 * written by a build with a higher {@link SESSIONS_SECTION_VERSION}, so this
 * build carries it through untouched and neither reads nor writes it. A record
 * with no session recorded is a hit with an empty list.
 */
export type SessionStartListMissReason = "no file" | "newer format";

export type SessionStartListing =
  | {
      hit: true;
      /** Every recorded session start, in frame order. */
      starts: ReplaySessionStart[];
    }
  | { hit: false; reason: SessionStartListMissReason };
