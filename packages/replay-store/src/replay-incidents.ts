/**
 * The `incidents` section of the per-session replay file (issue #1426): each
 * incident at the frame it happened, the driver's own from his counter and
 * other cars' from the session YAML. Recorded and not yet read for a jump:
 * Next / Previous Incident keeps sending iRacing's search, and a later
 * observer compares where that search lands with the nearest recorded entry.
 * Pure functions over the section; the store (`replay-session-store.ts`) owns
 * it, and the translator's `replay.incident` event reaches it through the
 * store's `incidents` API.
 * Design: docs/superpowers/specs/2026-10-12-issue-1426-replay-record-steps.md.
 *
 * Per `(sessionNum, sessionUniqueId)`, like the greens, with no join-by-frame
 * rule. Keyed by `carIdx` and VERIFIED by `carNumberRaw`, like the lap record:
 * an index handed to another car is another car. An entry is stored at the
 * incident's own frame; the later consumer applies its lead-in at the jump.
 */

/** The section's own version; the file's envelope version does not move for it. */
export const INCIDENTS_SECTION_VERSION = 1;

/**
 * How far after a car's last entry a further rise of its count is folded into
 * that entry: 600 frames, ten seconds at 60 fps, #1122's sequence gap
 * (`INCIDENT_SEQUENCE_GAP_MS` in `sim-events-iracing`). One crash scores in
 * several steps, and is one entry at its first frame. Measured from the
 * entry's frame, which is the first rise's, so an entry never spans more than
 * this window.
 */
export const INCIDENT_FOLD_FRAMES = 600;

/** Where an incident was read: the driver's own counter, or another car's count in the session YAML. */
export type IncidentSource = "telemetry" | "sessionInfo";

/**
 * `{ carIdx, carNumberRaw, frame, sessionTimeMs, delta, source }`. The index
 * signatures on this and the two records below are forward compatibility: a
 * field a newer build adds at any level survives this build's writes.
 */
export interface ReplayIncidentEntry {
  [key: string]: unknown;
  carIdx: number;
  carNumberRaw: number;
  /** The live replay frame on the tick the count first rose, recorded raw. */
  frame: number;
  /** `SessionTime` on the same tick, whole milliseconds; descriptive only. */
  sessionTimeMs: number;
  /** How far the count rose: the first rise plus every rise folded into the entry. */
  delta: number;
  /** An {@link IncidentSource}, or whatever a newer build recorded. */
  source: string;
}

export interface ReplayIncidentsSession {
  [key: string]: unknown;
  sessionNum: number;
  sessionUniqueId: number;
  /** Ordered by frame. */
  incidents: ReplayIncidentEntry[];
}

export interface ReplayIncidentsSection {
  [key: string]: unknown;
  version: number;
  sessions: ReplayIncidentsSession[];
}

/** What `replay.incident` carries, minus the session identity the store checks. */
export interface IncidentRecord {
  sessionNum: number;
  sessionUniqueId: number;
  carIdx: number;
  carNumberRaw: number;
  frame: number;
  sessionTimeMs: number;
  delta: number;
  source: IncidentSource;
}

/** One entry of the section as the list reader returns it: the entry with the session it belongs to. */
export interface ReplayIncident extends ReplayIncidentEntry {
  sessionNum: number;
  sessionUniqueId: number;
}

export function emptyIncidentsSection(): ReplayIncidentsSection {
  return { version: INCIDENTS_SECTION_VERSION, sessions: [] };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * An entry is an object with a finite `carIdx`, `carNumberRaw`, `frame` and
 * `delta` and a string `source`; anything else is not one and is dropped, as
 * the lap record drops what is not a lap. A missing `sessionTimeMs` reads as 0
 * (descriptive, never part of a match). A `source` this build does not know is
 * kept as it came.
 */
function normalizeEntry(raw: unknown): ReplayIncidentEntry | undefined {
  if (raw === null || typeof raw !== "object") return undefined;

  const e = raw as Record<string, unknown>;

  if (
    !isFiniteNumber(e.carIdx) ||
    !isFiniteNumber(e.carNumberRaw) ||
    !isFiniteNumber(e.frame) ||
    !isFiniteNumber(e.delta) ||
    typeof e.source !== "string"
  ) {
    return undefined;
  }

  return {
    ...e,
    carIdx: e.carIdx,
    carNumberRaw: e.carNumberRaw,
    frame: e.frame,
    sessionTimeMs: isFiniteNumber(e.sessionTimeMs) ? e.sessionTimeMs : 0,
    delta: e.delta,
    source: e.source,
  };
}

/**
 * Whether a loaded `incidents` section carries a `version` above this build's
 * — a newer build's reshaped section. The store then treats it as a section it
 * has no reader for: carried through every write verbatim, never normalized
 * and never written into.
 */
export function isNewerIncidentsSection(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object") return false;

  const version = (raw as Record<string, unknown>).version;

  return isFiniteNumber(version) && version > INCIDENTS_SECTION_VERSION;
}

/**
 * Read a loaded `incidents` section, dropping whatever in it is not a session
 * or an entry and putting each session's entries in frame order. Anything that
 * is not a section reads as an empty one.
 */
export function normalizeIncidentsSection(raw: unknown): ReplayIncidentsSection {
  if (raw === null || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).sessions)) {
    return emptyIncidentsSection();
  }

  const sessions: ReplayIncidentsSession[] = [];

  for (const candidate of (raw as { sessions: unknown[] }).sessions) {
    if (candidate === null || typeof candidate !== "object") continue;

    const s = candidate as Record<string, unknown>;

    if (!isFiniteNumber(s.sessionNum) || !isFiniteNumber(s.sessionUniqueId)) continue;

    const incidents = Array.isArray(s.incidents)
      ? s.incidents.map(normalizeEntry).filter((e): e is ReplayIncidentEntry => e !== undefined)
      : [];

    incidents.sort((a, b) => a.frame - b.frame);

    sessions.push({ ...s, sessionNum: s.sessionNum, sessionUniqueId: s.sessionUniqueId, incidents });
  }

  const rawVersion = (raw as Record<string, unknown>).version;

  return {
    ...(raw as Record<string, unknown>),
    // Never downgrade a newer build's section version on the way through.
    version: isFiniteNumber(rawVersion) ? Math.max(rawVersion, INCIDENTS_SECTION_VERSION) : INCIDENTS_SECTION_VERSION,
    sessions,
  };
}

function findSessionByPair(
  section: ReplayIncidentsSection,
  sessionNum: number,
  sessionUniqueId: number,
): ReplayIncidentsSession | undefined {
  return section.sessions.find((s) => s.sessionNum === sessionNum && s.sessionUniqueId === sessionUniqueId);
}

/** Insert in frame order, after any entry already at that frame. */
function insertByFrame(incidents: ReplayIncidentEntry[], entry: ReplayIncidentEntry): void {
  const at = incidents.findIndex((e) => e.frame > entry.frame);

  incidents.splice(at === -1 ? incidents.length : at, 0, entry);
}

const isSameCar = (entry: ReplayIncidentEntry, car: { carIdx: number; carNumberRaw: number }): boolean =>
  entry.carIdx === car.carIdx && entry.carNumberRaw === car.carNumberRaw;

/**
 * Record a rise of a car's incident count. Creates the session as needed; a
 * session is matched by its exact `(sessionNum, sessionUniqueId)` pair and by
 * nothing else.
 *
 * A rise at most {@link INCIDENT_FOLD_FRAMES} after the same car's last entry
 * in that session (the same `carIdx` and `carNumberRaw`) is folded into it:
 * its `delta` is added and the entry keeps its frame, its `sessionTimeMs` and
 * its `source`, so one crash scored in several steps is one entry at its first
 * frame. Any other rise — later than the window, before the car's last entry,
 * or the first for the car — is a new entry, inserted in frame order.
 *
 * @returns whether the section changed: always true, since a rise either adds
 * an entry or adds to one
 */
export function recordIncidentInSection(section: ReplayIncidentsSection, record: IncidentRecord): boolean {
  let session = findSessionByPair(section, record.sessionNum, record.sessionUniqueId);

  if (session === undefined) {
    session = { sessionNum: record.sessionNum, sessionUniqueId: record.sessionUniqueId, incidents: [] };
    section.sessions.push(session);
  }

  const last = session.incidents.findLast((e) => isSameCar(e, record));

  if (last !== undefined && record.frame >= last.frame && record.frame - last.frame <= INCIDENT_FOLD_FRAMES) {
    last.delta += record.delta;

    return true;
  }

  insertByFrame(session.incidents, {
    carIdx: record.carIdx,
    carNumberRaw: record.carNumberRaw,
    frame: record.frame,
    sessionTimeMs: record.sessionTimeMs,
    delta: record.delta,
    source: record.source,
  });

  return true;
}

/**
 * Union `source` into `target` (the store, when a file it could not read at
 * open becomes readable while the session ran in memory: `target` is what the
 * disk holds, `source` what was recorded meanwhile). A session is matched by
 * its pair. An entry is the same incident as one in `target` when it is the
 * same car within {@link INCIDENT_FOLD_FRAMES} of it, either way; then the
 * entry already in `target` stays, unchanged. Every other entry is copied in,
 * in frame order. Nothing already in `target` is moved, changed or removed.
 * Everything copied in is cloned; `source` is left untouched.
 */
export function mergeIncidentsSectionInto(target: ReplayIncidentsSection, source: ReplayIncidentsSection): void {
  for (const session of source.sessions) {
    const existing = findSessionByPair(target, session.sessionNum, session.sessionUniqueId);

    if (existing === undefined) {
      target.sessions.push(structuredClone(session));
      continue;
    }

    for (const entry of session.incidents) {
      const held = existing.incidents.some(
        (e) => isSameCar(e, entry) && Math.abs(e.frame - entry.frame) <= INCIDENT_FOLD_FRAMES,
      );

      if (!held) insertByFrame(existing.incidents, structuredClone(entry));
    }
  }
}

/**
 * Every recorded incident of every session, in frame order, each with the
 * session it belongs to, as copies the caller cannot change the section
 * through. `section` undefined (the file has no `incidents` section) is an
 * empty list.
 */
export function listIncidentsInSection(section: ReplayIncidentsSection | undefined): ReplayIncident[] {
  if (section === undefined) return [];

  const all: ReplayIncident[] = [];

  for (const session of section.sessions) {
    for (const entry of session.incidents) {
      all.push({ ...entry, sessionNum: session.sessionNum, sessionUniqueId: session.sessionUniqueId });
    }
  }

  return all.sort((a, b) => a.frame - b.frame);
}

/**
 * Why the store could not list the incidents, worded as the caller logs it.
 * "no file": nothing is recorded for that SubSessionID at all. "newer format":
 * the file's `incidents` section was written by a build with a higher
 * {@link INCIDENTS_SECTION_VERSION}, so this build carries it through
 * untouched and neither reads nor writes it. A record with no incident
 * recorded is a hit with an empty list.
 */
export type IncidentListMissReason = "no file" | "newer format";

export type IncidentListing =
  | {
      hit: true;
      /** Every recorded incident, in frame order. */
      incidents: ReplayIncident[];
    }
  | { hit: false; reason: IncidentListMissReason };
