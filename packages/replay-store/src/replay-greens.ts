/**
 * The `greens` section of the per-session replay file (issue #1354): the frame
 * a race went green at, and every caution restart after it, recorded live, so
 * Jump to Race Start is a lookup. Pure functions over the section; the store
 * (`replay-session-store.ts`) owns it, and the translator's `replay.greenFlag`
 * event reaches it through the store's `greens` API.
 * Design: docs/superpowers/specs/2026-10-05-issue-1354-replay-jump-to-green-flag.md.
 *
 * Per `(sessionNum, sessionUniqueId)`, like the lap record: a restart within
 * one sim run is the same `sessionNum` under a new unique id, with a green of
 * its own. Unlike the lap record there is no join-by-frame rule — nothing
 * records a green from inside a replay, so a pair no session carries is always
 * a new session.
 */
import { MARKER_DEDUPE_FRAMES } from "./replay-markers.js";

/** The section's own version; the file's envelope version does not move for it. */
export const GREENS_SECTION_VERSION = 1;

/** The greens this build records: the race start, and the green that ends a full-course caution. */
export type GreenKind = "start" | "restart";

/**
 * `{ kind, frame, sessionTimeMs }`: the session went green at `frame`. The
 * index signatures on this and the two records below are forward
 * compatibility: a field a newer build adds at any level survives this build's
 * writes. `kind` is a plain string for the same reason — an entry of a kind
 * this build has no reader for is kept where it is on every write, never
 * de-duplicated against and never returned by a lookup.
 */
export interface ReplayGreenEntry {
  [key: string]: unknown;
  /** A {@link GreenKind}, or whatever a newer build recorded. */
  kind: string;
  /** The live replay frame on the green tick, recorded raw. */
  frame: number;
  /** `SessionTime` on the same tick, whole milliseconds; descriptive only, never used to jump. */
  sessionTimeMs: number;
}

export interface ReplayGreensSession {
  [key: string]: unknown;
  sessionNum: number;
  sessionUniqueId: number;
  /** Ordered by frame; at most one `start`. */
  greens: ReplayGreenEntry[];
}

export interface ReplayGreensSection {
  [key: string]: unknown;
  version: number;
  sessions: ReplayGreensSession[];
}

/** What `replay.greenFlag` carries, minus the session identity the store checks. */
export interface GreenRecord {
  sessionNum: number;
  sessionUniqueId: number;
  kind: GreenKind;
  frame: number;
  sessionTimeMs: number;
}

export interface GreenQuery {
  sessionNum: number;
  /**
   * The target session's `SessionUniqueID`, or null/undefined when the caller
   * knows none (a race session other than the one the replay cursor is in).
   * The lookup then goes by `sessionNum` alone.
   */
  sessionUniqueId?: number | null;
  /**
   * Only the start is looked up: a session has one, so the answer is a single
   * frame. Restarts are recorded for a later next / previous pair, which walks
   * the list rather than asking for one entry.
   */
  kind: "start";
}

/** How a lookup that names a session instance treats the other instances of its `sessionNum`. */
export interface SessionMatchOptions {
  /**
   * The record's `sessionUniqueId`s are the very ones a query carries, so a
   * named instance is answered from that instance or not at all. False or
   * absent for a record that may have come from a file, whose ids can differ
   * from the ones a later sim run gives the same sessions.
   */
  exactInstance?: boolean;
}

/**
 * Why a lookup missed, worded as the action logs it: `record MISS (<reason>)`.
 * "no file" is the store's: nothing is recorded for that SubSessionID at all.
 * "newer format" is the store's too: the file's `greens` section was written
 * by a build with a higher {@link GREENS_SECTION_VERSION}, so this build
 * carries it through untouched and neither reads nor writes it. "no session":
 * the section holds no session with that `sessionNum`, or the query named an
 * instance it does not hold while several others have the entry. "no green":
 * everything else — a file with no `greens` section, or a session without the
 * entry.
 */
export type GreenMissReason = "no file" | "no session" | "no green" | "newer format";

export type GreenLookup =
  | {
      hit: true;
      frame: number;
      sessionTimeMs: number;
      /** Whether the session matched by its `(sessionNum, sessionUniqueId)` pair or by the `sessionNum` fallback. */
      matchedBy: "pair" | "sessionNum";
      /** The matched session's unique id: which instance of the `sessionNum` the answer came from, for the caller's log. */
      sessionUniqueId: number;
    }
  | { hit: false; reason: GreenMissReason };

export function emptyGreensSection(): ReplayGreensSection {
  return { version: GREENS_SECTION_VERSION, sessions: [] };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isGreenKind(kind: string): kind is GreenKind {
  return kind === "start" || kind === "restart";
}

/**
 * An entry is an object with a `kind` and a `frame`, the list's ordering key;
 * anything else is not one and is dropped, as the lap record drops what is not
 * a lap. An entry of a kind this build writes gets a missing `sessionTimeMs`
 * read as 0 (descriptive, never part of a match). An entry of any other kind
 * is carried exactly as it came, whatever its other fields hold.
 */
function normalizeEntry(raw: unknown): ReplayGreenEntry | undefined {
  if (raw === null || typeof raw !== "object") return undefined;

  const e = raw as Record<string, unknown>;

  if (typeof e.kind !== "string" || !isFiniteNumber(e.frame)) return undefined;

  // Nothing here reads the other fields of a kind it has no reader for, so the
  // type's `sessionTimeMs: number` is not checked for one: coercing it would
  // rewrite a newer build's data.
  if (!isGreenKind(e.kind)) return { ...e } as ReplayGreenEntry;

  return {
    ...e,
    kind: e.kind,
    frame: e.frame,
    sessionTimeMs: isFiniteNumber(e.sessionTimeMs) ? e.sessionTimeMs : 0,
  };
}

/**
 * Whether a loaded `greens` section carries a `version` above this build's — a
 * newer build's reshaped section. The store then treats it as a section it has
 * no reader for: carried through every write verbatim, never normalized (which
 * would keep the newer version label over data this build has mangled) and
 * never written into.
 */
export function isNewerGreensSection(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object") return false;

  const version = (raw as Record<string, unknown>).version;

  return isFiniteNumber(version) && version > GREENS_SECTION_VERSION;
}

/**
 * Read a loaded `greens` section, dropping whatever in it is not a session or
 * an entry and putting each session's entries in frame order. Anything that is
 * not a section reads as an empty one.
 */
export function normalizeGreensSection(raw: unknown): ReplayGreensSection {
  if (raw === null || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).sessions)) {
    return emptyGreensSection();
  }

  const sessions: ReplayGreensSession[] = [];

  for (const candidate of (raw as { sessions: unknown[] }).sessions) {
    if (candidate === null || typeof candidate !== "object") continue;

    const s = candidate as Record<string, unknown>;

    if (!isFiniteNumber(s.sessionNum) || !isFiniteNumber(s.sessionUniqueId)) continue;

    const greens = Array.isArray(s.greens)
      ? s.greens.map(normalizeEntry).filter((e): e is ReplayGreenEntry => e !== undefined)
      : [];

    greens.sort((a, b) => a.frame - b.frame);

    sessions.push({ ...s, sessionNum: s.sessionNum, sessionUniqueId: s.sessionUniqueId, greens });
  }

  const rawVersion = (raw as Record<string, unknown>).version;

  return {
    ...(raw as Record<string, unknown>),
    // Never downgrade a newer build's section version on the way through.
    version: isFiniteNumber(rawVersion) ? Math.max(rawVersion, GREENS_SECTION_VERSION) : GREENS_SECTION_VERSION,
    sessions,
  };
}

function findSessionByPair(
  section: ReplayGreensSection,
  sessionNum: number,
  sessionUniqueId: number,
): ReplayGreensSession | undefined {
  return section.sessions.find((s) => s.sessionNum === sessionNum && s.sessionUniqueId === sessionUniqueId);
}

/** Insert in frame order, after any entry already at that frame. */
function insertByFrame(greens: ReplayGreenEntry[], entry: ReplayGreenEntry): void {
  const at = greens.findIndex((e) => e.frame > entry.frame);

  greens.splice(at === -1 ? greens.length : at, 0, entry);
}

/** Whether a restart is already recorded within {@link MARKER_DEDUPE_FRAMES} of `frame`. */
function hasRestartNear(greens: readonly ReplayGreenEntry[], frame: number): boolean {
  return greens.some((e) => e.kind === "restart" && Math.abs(e.frame - frame) <= MARKER_DEDUPE_FRAMES);
}

/**
 * Record a green. Creates the session as needed; a session is matched by its
 * exact `(sessionNum, sessionUniqueId)` pair and by nothing else.
 *
 * - **`start`**: a session has at most one, and the latest wins. A re-grid
 *   re-enters the parade laps and its green is the real start, so a second
 *   start for the same session instance replaces the first. A start at the
 *   frame one is already recorded at is the same moment: the entry stays, with
 *   its fields, and only a different `sessionTimeMs` is taken.
 * - **`restart`**: not added when another restart is within
 *   {@link MARKER_DEDUPE_FRAMES} (the marker window, one second), so a
 *   tick-level double emit cannot create two entries.
 *
 * Entries stay in frame order. One kind is never de-duplicated against the
 * other, and an entry of a kind this build does not know is never touched,
 * de-duplicated against or dropped.
 *
 * @returns whether the section changed — false for a de-duplicated restart or
 * an identical start, which the store then does not write
 */
export function recordGreenInSection(section: ReplayGreensSection, record: GreenRecord): boolean {
  const existing = findSessionByPair(section, record.sessionNum, record.sessionUniqueId);

  if (record.kind === "restart" && existing !== undefined && hasRestartNear(existing.greens, record.frame)) {
    return false;
  }

  let session = existing;

  if (session === undefined) {
    session = { sessionNum: record.sessionNum, sessionUniqueId: record.sessionUniqueId, greens: [] };
    section.sessions.push(session);
  }

  const entry: ReplayGreenEntry = { kind: record.kind, frame: record.frame, sessionTimeMs: record.sessionTimeMs };

  if (record.kind === "restart") {
    insertByFrame(session.greens, entry);

    return true;
  }

  const starts = session.greens.filter((e) => e.kind === "start");
  const same = starts.find((e) => e.frame === record.frame);

  if (same === undefined) {
    session.greens = session.greens.filter((e) => e.kind !== "start");
    insertByFrame(session.greens, entry);

    return true;
  }

  let changed = starts.length > 1;

  if (changed) session.greens = session.greens.filter((e) => e.kind !== "start" || e === same);

  if (same.sessionTimeMs !== record.sessionTimeMs) {
    same.sessionTimeMs = record.sessionTimeMs;
    changed = true;
  }

  return changed;
}

/**
 * Union `source` into `target` (the store, when a file it could not read at
 * open becomes readable while the session ran in memory: `target` is what the
 * disk holds, `source` what was recorded meanwhile). A session is matched by
 * its pair. Where both have a `start` for a session the one already in
 * `target` stays; restarts are a union under the de-dupe rule of
 * {@link recordGreenInSection}, `target`'s winning inside the window; an entry
 * of any other kind is copied in unless `target` has one of that kind at that
 * frame. Nothing already in `target` is moved, changed or removed. Everything
 * copied in is cloned; `source` is left untouched.
 */
export function mergeGreensSectionInto(target: ReplayGreensSection, source: ReplayGreensSection): void {
  for (const session of source.sessions) {
    const existing = findSessionByPair(target, session.sessionNum, session.sessionUniqueId);

    if (existing === undefined) {
      target.sessions.push(structuredClone(session));
      continue;
    }

    for (const entry of session.greens) {
      const held =
        entry.kind === "start"
          ? existing.greens.some((e) => e.kind === "start")
          : entry.kind === "restart"
            ? hasRestartNear(existing.greens, entry.frame)
            : existing.greens.some((e) => e.kind === entry.kind && e.frame === entry.frame);

      if (!held) insertByFrame(existing.greens, structuredClone(entry));
    }
  }
}

/** The session's entry of a kind — the latest by frame, should a file hold more than one. */
function greenOfKind(session: ReplayGreensSession, kind: GreenKind): ReplayGreenEntry | undefined {
  return session.greens.findLast((e) => e.kind === kind);
}

/**
 * The frame a session went green at. `section` undefined means the file has no
 * `greens` section, which is a miss with `no green`: a replay recorded by a
 * build before this one has a lap record to fall back on, and no greens.
 *
 * A query that names an instance — a press made inside a race, which knows
 * its `sessionUniqueId` — is answered from that instance and no other. The
 * session recorded under the pair either has the entry or the lookup misses
 * with `no green`: a start recorded for another pass of the same race (an AI
 * event restarted) is a different green, and landing there would put the
 * cursor in a race the user is not watching. When the record holds no session
 * under the pair at all, the lap record's rule applies: the ONE other session
 * with that `sessionNum` that has the entry is taken, for a file whose unique
 * ids did not survive the save, and with several the lookup misses with
 * `no session`.
 *
 * With `options.exactInstance` that last fallback is off as well: in a record
 * whose unique ids are known to be the ones the query carries (the store's
 * offline record, which lives and dies within one sim run) an instance that is
 * not recorded is simply a race whose green was not seen — the driver sat in
 * the garage through it — and the one other instance is another pass of an AI
 * event that was restarted, never the same race under a lost id.
 *
 * A query that names none — a press from practice or qualifying — reads the
 * sessions with that `sessionNum` that have the entry: the only one, and of
 * several the one whose entry has the highest frame, which is the latest
 * instance in the recording.
 *
 * Restarts and entries of a kind this build does not know are never the answer
 * to a `start` lookup.
 */
export function findGreenInSection(
  section: ReplayGreensSection | undefined,
  query: GreenQuery,
  options: SessionMatchOptions = {},
): GreenLookup {
  if (section === undefined) return { hit: false, reason: "no green" };

  const sameNum = section.sessions.filter((s) => s.sessionNum === query.sessionNum);

  if (sameNum.length === 0) return { hit: false, reason: "no session" };

  const namesInstance = query.sessionUniqueId !== null && query.sessionUniqueId !== undefined;
  const byPair = namesInstance ? sameNum.find((s) => s.sessionUniqueId === query.sessionUniqueId) : undefined;

  if (byPair !== undefined) {
    const direct = greenOfKind(byPair, query.kind);

    if (direct === undefined) return { hit: false, reason: "no green" };

    return {
      hit: true,
      frame: direct.frame,
      sessionTimeMs: direct.sessionTimeMs,
      matchedBy: "pair",
      sessionUniqueId: byPair.sessionUniqueId,
    };
  }

  // Exact ids: the instance the query names is not recorded, and no other
  // instance is that race.
  if (namesInstance && options.exactInstance === true) return { hit: false, reason: "no session" };

  let latest: { session: ReplayGreensSession; entry: ReplayGreenEntry } | undefined;
  let withEntry = 0;

  for (const session of sameNum) {
    const entry = greenOfKind(session, query.kind);

    if (entry === undefined) continue;

    withEntry++;

    if (latest === undefined || entry.frame > latest.entry.frame) latest = { session, entry };
  }

  if (latest === undefined) return { hit: false, reason: "no green" };

  if (namesInstance && withEntry > 1) return { hit: false, reason: "no session" };

  return {
    hit: true,
    frame: latest.entry.frame,
    sessionTimeMs: latest.entry.sessionTimeMs,
    matchedBy: "sessionNum",
    sessionUniqueId: latest.session.sessionUniqueId,
  };
}
