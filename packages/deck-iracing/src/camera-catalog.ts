/**
 * The camera catalog (#1653): every camera group name the plugin has seen in a
 * session, and each track's latest group list, as `cameras.json` holds them.
 * Pure: the model, the one update rule, removal, the loaded file's validation
 * and the view the Property Inspectors read. The file and the SDK live in
 * `camera-catalog-service.ts` and `camera-catalog-publisher.ts`.
 *
 * It is iRacing-shaped (`WeekendInfo.TrackID`, `CameraInfo.Groups`), which is
 * why it lives in deck-iracing and not in the sim-neutral deck-core.
 *
 * Design: docs/superpowers/specs/2026-11-08-issue-1653-custom-camera-groups.md
 * (decisions 2 to 4).
 *
 * Every record keyed by a name is a NULL-PROTOTYPE object: a group name comes
 * from a camera file the user wrote, so `__proto__` or `constructor` are names
 * like any other, and on an ordinary object the first would replace the
 * prototype instead of adding an entry. Lookups go through `Object.hasOwn`.
 */
import type { CameraCatalogView, CameraCatalogViewCurrent } from "@iracedeck/app-constants";
import { normalizeCameraGroupName } from "@iracedeck/iracing-sdk";

/** The file format's version. A file with any other is not read (see {@link parseCameraCatalog}). */
export const CAMERA_CATALOG_VERSION = 1;

/**
 * The longest group name the catalog records. Longer names, and names with a
 * control character, are skipped: the settings window's remove command
 * (`CameraGroupNameSchema` in `@iracedeck/settings-window`, which restates
 * this number) refuses them, so one recorded could never be removed. A camera
 * file's group names are short in practice.
 */
export const CAMERA_GROUP_NAME_MAX_LENGTH = 256;

/**
 * How old a track's `lastSeen` may get before an otherwise unchanged
 * observation refreshes it (one day). See {@link recordCameraGroups}.
 */
export const CAMERA_CATALOG_LAST_SEEN_REFRESH_MS = 24 * 60 * 60 * 1000;

/** One track layout the catalog has seen. */
export interface CameraCatalogTrack {
  /** `WeekendInfo.TrackDisplayName` as last seen. */
  readonly name: string;
  /** `WeekendInfo.TrackConfigName` as last seen; empty for a track without configurations. */
  readonly config: string;
  /** The LATEST group list seen for this track, canonical names in the sim's order. */
  readonly groups: readonly string[];
  /** ISO time the track was last recorded (see {@link recordCameraGroups} for when it refreshes). */
  readonly lastSeen: string;
}

/** One remembered group name. */
export interface CameraCatalogGroup {
  /** ISO time the name was first recorded. */
  readonly firstSeen: string;
  /** ISO time the name was last recorded. */
  readonly lastSeen: string;
}

/**
 * `cameras.json`, version 1. Never mutated: every update returns a new value,
 * so a reader holding one (the store's pending save included) never sees it
 * change.
 */
export interface CameraCatalog {
  readonly version: typeof CAMERA_CATALOG_VERSION;
  /** Keyed by `String(TrackID)`; null-prototype. */
  readonly tracks: Readonly<Record<string, CameraCatalogTrack>>;
  /** Every name ever seen and not removed, standard ones included; null-prototype. Only grows, but for removal. */
  readonly groups: Readonly<Record<string, CameraCatalogGroup>>;
}

/** What one session info says about its track's camera groups. */
export interface CameraGroupObservation {
  /** `WeekendInfo.TrackID`; a positive safe integer, or the observation is ignored. */
  readonly trackId: number;
  readonly trackName: string;
  readonly trackConfig: string;
  /** The session's group names in the sim's order; normalised and de-duplicated here. */
  readonly groups: readonly string[];
}

/** What {@link recordCameraGroups} and {@link removeCameraGroup} return. */
export interface CameraCatalogUpdate {
  /** The new catalog, or the input itself when nothing changed. */
  readonly catalog: CameraCatalog;
  /** Whether `catalog` differs from the input, which is when it must be saved and published. */
  readonly changed: boolean;
}

/** A fresh, empty null-prototype record. */
function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** A null-prototype copy of `source`'s own enumerable entries. */
function copyDict<T>(source: Readonly<Record<string, T>>): Record<string, T> {
  return Object.assign(dict<T>(), source);
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** An empty catalog. */
export function emptyCameraCatalog(): CameraCatalog {
  return { version: CAMERA_CATALOG_VERSION, tracks: dict(), groups: dict() };
}

/** Whether `name` holds a C0 control character or DEL. */
function hasControlCharacter(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);

    if (code < 0x20 || code === 0x7f) return true;
  }

  return false;
}

/**
 * Whether `name` is one the catalog records: a non-blank string no longer than
 * the limit, with no control character. The same rule as the settings window's
 * `CameraGroupNameSchema`, so every recorded name can be removed there.
 */
function isRecordableName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.trim() !== "" &&
    name.length <= CAMERA_GROUP_NAME_MAX_LENGTH &&
    !hasControlCharacter(name)
  );
}

/** The names in order, canonical, each once, unrecordable ones skipped. */
function canonicalGroupList(names: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const list: string[] = [];

  for (const raw of names) {
    if (typeof raw !== "string") continue;

    const name = normalizeCameraGroupName(raw);

    if (!isRecordableName(name) || seen.has(name)) continue;

    seen.add(name);
    list.push(name);
  }

  return list;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

/** A track id as the catalog keys it, or undefined when it is not a positive safe integer. */
function trackKey(trackId: number): string | undefined {
  return Number.isSafeInteger(trackId) && trackId > 0 ? String(trackId) : undefined;
}

/**
 * Whether a stored `lastSeen` is due for a refresh at `now`: unreadable, at
 * least {@link CAMERA_CATALOG_LAST_SEEN_REFRESH_MS} old, or as far in the
 * future (a clock that was set wrong when it was written).
 */
function isLastSeenStale(lastSeen: string, now: Date): boolean {
  const seenAt = Date.parse(lastSeen);

  if (Number.isNaN(seenAt)) return true;

  return Math.abs(now.getTime() - seenAt) >= CAMERA_CATALOG_LAST_SEEN_REFRESH_MS;
}

/**
 * Record one observation. Never mutates `catalog`.
 *
 * The track's list is REPLACED by the observation's, so a group dropped from a
 * camera file stops counting as on that track; `groups` only grows. An
 * observation with an unusable track id or no recordable group name changes
 * nothing (the recorder only observes sessions that carry both).
 *
 * When it changes the catalog — the rule that keeps a session from saving on
 * every session-info update: the catalog changes only when
 *
 * - the track is new, or its list, name or configuration differs from the
 *   stored ones, or
 * - one of its group names is not in `groups` (new, or removed by the user
 *   and seen again), or
 * - the track's stored `lastSeen` is stale: a day old or more (or unreadable,
 *   or a day in the future).
 *
 * The timestamps follow the change, never lead it: the track's `lastSeen` and
 * the `lastSeen` of every group in its list are set to `now` when, and only
 * when, one of the above holds; a new group's `firstSeen` is `now` too. So the
 * times are accurate to a day, and a session that sits on one track for hours
 * saves at most once a day instead of on every session-info update. A group's
 * `lastSeen` is therefore the last refresh of any track whose list held it.
 */
export function recordCameraGroups(
  catalog: CameraCatalog,
  observation: CameraGroupObservation,
  now: Date,
): CameraCatalogUpdate {
  const key = trackKey(observation.trackId);
  const names = canonicalGroupList(observation.groups);

  if (key === undefined || names.length === 0) return { catalog, changed: false };

  const trackName = observation.trackName;
  const trackConfig = observation.trackConfig;
  const stored = own(catalog.tracks, key);
  const differs =
    stored === undefined ||
    stored.name !== trackName ||
    stored.config !== trackConfig ||
    !sameList(stored.groups, names) ||
    names.some((name) => !Object.hasOwn(catalog.groups, name));

  if (!differs && !isLastSeenStale(stored.lastSeen, now)) return { catalog, changed: false };

  const iso = now.toISOString();
  const tracks = copyDict(catalog.tracks);
  const groups = copyDict(catalog.groups);

  tracks[key] = { name: trackName, config: trackConfig, groups: names, lastSeen: iso };

  for (const name of names) {
    const previous = own(catalog.groups, name);

    groups[name] = { firstSeen: previous?.firstSeen || iso, lastSeen: iso };
  }

  return { catalog: { version: CAMERA_CATALOG_VERSION, tracks, groups }, changed: true };
}

/**
 * Remove `name` from the remembered groups. Tracks' lists are left as they
 * are: a track whose file still has the group holds it until that track is
 * seen again, when it is recorded once more (spec decision 7). An unknown name
 * changes nothing. Never mutates `catalog`.
 */
export function removeCameraGroup(catalog: CameraCatalog, name: string): CameraCatalogUpdate {
  if (!Object.hasOwn(catalog.groups, name)) return { catalog, changed: false };

  const groups = copyDict(catalog.groups);

  delete groups[name];

  return { catalog: { version: CAMERA_CATALOG_VERSION, tracks: catalog.tracks, groups }, changed: true };
}

/** What {@link parseCameraCatalog} made of a loaded file. */
export type CameraCatalogParseResult =
  | {
      readonly kind: "ok";
      readonly catalog: CameraCatalog;
      /** How many entries were malformed and left out. */
      readonly dropped: number;
    }
  | {
      readonly kind: "unusable";
      /** Why, for the log. */
      readonly reason: string;
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** A track key as the file writes it: decimal digits of a positive safe integer, no leading zero. */
const TRACK_KEY = /^[1-9]\d*$/;

/** The later of two ISO times, by string order (ISO 8601 UTC sorts as text); a blank one loses. */
function later(a: string, b: string): string {
  return a === "" ? b : b === "" ? a : a >= b ? a : b;
}

/** The earlier of two ISO times; a blank one loses. */
function earlier(a: string, b: string): string {
  return a === "" ? b : b === "" ? a : a <= b ? a : b;
}

/**
 * Validate a loaded `cameras.json` (the JSON-parsed object).
 *
 * - `version` 1 with object `tracks` and `groups` is read, and malformed
 *   entries are left out and counted: a track whose key is not a positive
 *   decimal id, whose entry is not an object or whose `groups` is not a list;
 *   a group whose name is not recordable or whose entry is not an object.
 *   Within a kept entry a text field that is not text reads as empty (an
 *   empty `lastSeen` is stale, so the next observation refreshes it), names
 *   are normalised, and two that normalise to one are merged (earliest
 *   `firstSeen`, latest `lastSeen`).
 * - Anything else — another `version`, or `tracks` / `groups` that are not
 *   objects — is `unusable`. What happens to such a file is decided before
 *   this runs, by the file store's `validate` ({@link cameraCatalogFileProblem}):
 *   a newer build's file (a whole-number `version` above 1) is read, comes back
 *   `unusable` here, and the service runs in memory only and never saves over
 *   it, so a later build's catalog survives a downgrade; every other unusable
 *   file is set aside as `cameras.corrupt-<iso>.json` and never reaches this.
 */
export function parseCameraCatalog(raw: unknown): CameraCatalogParseResult {
  if (!isPlainObject(raw)) return { kind: "unusable", reason: "the file does not hold an object" };

  if (raw.version !== CAMERA_CATALOG_VERSION) {
    return { kind: "unusable", reason: `version ${JSON.stringify(raw.version) ?? "undefined"} is not 1` };
  }

  if (!isPlainObject(raw.tracks) || !isPlainObject(raw.groups)) {
    return { kind: "unusable", reason: "tracks or groups is not an object" };
  }

  let dropped = 0;
  const tracks = dict<CameraCatalogTrack>();
  const groups = dict<CameraCatalogGroup>();

  for (const [key, entry] of Object.entries(raw.tracks)) {
    if (!TRACK_KEY.test(key) || !Number.isSafeInteger(Number(key)) || !isPlainObject(entry)) {
      dropped++;
      continue;
    }

    if (!Array.isArray(entry.groups)) {
      dropped++;
      continue;
    }

    tracks[key] = {
      name: textOr(entry.name, ""),
      config: textOr(entry.config, ""),
      groups: canonicalGroupList(entry.groups),
      lastSeen: textOr(entry.lastSeen, ""),
    };
  }

  for (const [rawName, entry] of Object.entries(raw.groups)) {
    const name = normalizeCameraGroupName(rawName);

    if (!isRecordableName(name) || !isPlainObject(entry)) {
      dropped++;
      continue;
    }

    const firstSeen = textOr(entry.firstSeen, "");
    const lastSeen = textOr(entry.lastSeen, "");
    const existing = own(groups, name);

    groups[name] =
      existing === undefined
        ? { firstSeen, lastSeen }
        : { firstSeen: earlier(existing.firstSeen, firstSeen), lastSeen: later(existing.lastSeen, lastSeen) };
  }

  return { kind: "ok", catalog: { version: CAMERA_CATALOG_VERSION, tracks, groups }, dropped };
}

/**
 * Whether `raw` is a catalog a NEWER build wrote: its `version` is a whole
 * number above this build's. Such a file is kept as it is and the catalog runs
 * in memory only (spec decision 2), so the newer build finds it again after a
 * downgrade and an upgrade back.
 */
export function isNewerCameraCatalogFile(raw: Record<string, unknown>): boolean {
  return typeof raw.version === "number" && Number.isSafeInteger(raw.version) && raw.version > CAMERA_CATALOG_VERSION;
}

/**
 * The file store's `validate` for `cameras.json`: a reason to set the file
 * aside, exactly as an unparseable one is (moved to `cameras.corrupt-<iso>.json`,
 * the `camera-catalog-rejected` banner, the catalog starting empty and saving
 * again), or `undefined` to read it.
 *
 * Read: a usable version-1 catalog, and a newer build's file (see
 * {@link isNewerCameraCatalogFile}; the service then keeps it in place and runs
 * in memory only). Set aside: everything else that parses as an object — no
 * `version`, a version that is not a whole number above 1 (`"1"`, `0`, `1.5`),
 * or a version-1 file whose `tracks` / `groups` are not objects. No build
 * writes such a file, so it is a hand edit or damage, not a downgrade; kept in
 * place it would switch the catalog's saving off on every start with nothing
 * to say why (#1653 second read).
 */
export function cameraCatalogFileProblem(raw: Record<string, unknown>): string | undefined {
  if (isNewerCameraCatalogFile(raw)) return undefined;

  const parsed = parseCameraCatalog(raw);

  return parsed.kind === "unusable" ? `It is not a camera catalog: ${parsed.reason}` : undefined;
}

/**
 * Name order for the view: case-insensitive, then by code unit, so the order
 * is the same on every machine (no locale).
 */
function compareNames(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();

  if (la !== lb) return la < lb ? -1 : 1;

  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * The `_cameraCatalog` value for `catalog` and the current session (spec
 * decision 4). Deterministic, so equal inputs give byte-equal JSON and the
 * publisher can skip an unchanged push:
 *
 * - `tracks`: every track, by id ascending.
 * - `groups`: every remembered name, by {@link compareNames}, each with the
 *   indices into `tracks` of the tracks whose LATEST list holds it (ascending)
 *   and its `lastSeen`. A name a track holds but the user removed from
 *   `groups` is not listed.
 * - `current`: as given (copied), or null.
 */
export function toCameraCatalogView(
  catalog: CameraCatalog,
  current: CameraCatalogViewCurrent | null,
): CameraCatalogView {
  const keys = Object.keys(catalog.tracks).sort((a, b) => Number(a) - Number(b));
  const holders = new Map<string, number[]>();
  const tracks = keys.map((key, index) => {
    const track = catalog.tracks[key];

    for (const name of track.groups) {
      const list = holders.get(name);

      if (list === undefined) holders.set(name, [index]);
      else if (list[list.length - 1] !== index) list.push(index);
    }

    return { id: Number(key), name: track.name, config: track.config };
  });

  const groups = Object.keys(catalog.groups)
    .sort(compareNames)
    .map((name) => ({ name, tracks: holders.get(name) ?? [], lastSeen: catalog.groups[name].lastSeen }));

  return {
    version: CAMERA_CATALOG_VERSION,
    tracks,
    groups,
    current: current === null ? null : { trackId: current.trackId, groups: [...current.groups] },
  };
}
