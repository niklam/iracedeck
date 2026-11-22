/**
 * The camera catalog as the Property Inspector shows it (issue #1653): the pure
 * view helpers behind the Change Camera picker (`ird-camera-group-select`), the
 * Remembered groups section of both Cycle Camera grids in `camera-focus.ejs`
 * (reached there as `window.irdCameraGroups`, see {@link CAMERA_GROUP_HELPERS})
 * and the settings window's Camera Groups card (`ird-camera-catalog-list`).
 *
 * Every function here is pure and touches no DOM, so the ordering and labelling
 * rules the spec settles are unit-tested in one place and the template's inline
 * script only draws what they return.
 *
 * Design: docs/superpowers/specs/2026-11-08-issue-1653-custom-camera-groups.md,
 * decisions 4 and 7.
 */
import {
  type CameraCatalogView,
  type CameraCatalogViewCurrent,
  type CameraCatalogViewGroup,
  type CameraCatalogViewTrack,
  STANDARD_CAMERA_GROUP_OPTIONS,
  type StandardCameraGroupOption,
} from "@iracedeck/app-constants";

/*
 * OWN KEYS ONLY. A group name comes from a camera file somebody wrote, so
 * `constructor`, `toString` or `__proto__` is a name like any other. Every
 * lookup keyed by a name here goes through a Map or an own-key check, and every
 * name-keyed map built here has a null prototype: on a plain object `constructor`
 * reads as Object's function and assigning `__proto__` replaces the prototype
 * instead of adding the group. A null-prototype map still serialises as the
 * plain JSON object the stored subset has always been.
 */

/**
 * Name variants the sim spells differently from the canonical names: a copy of
 * `LEGACY_NAMES` in iracing-actions' `camera-groups.ts` (and of the one the
 * Cycle Camera grid script keeps), because this bundle cannot import that
 * package. The PI test holds it to `normalizeGroupName`. A Map, like the
 * original, for the reason above.
 */
export const LEGACY_CAMERA_GROUP_NAMES: ReadonlyMap<string, string> = new Map([["Pit Lane2", "Pit Lane 2"]]);

/** The legacy spellings by lower case, folded to the lower-case canonical name. */
const LEGACY_CAMERA_GROUP_NAMES_FOLDED: ReadonlyMap<string, string> = new Map(
  [...LEGACY_CAMERA_GROUP_NAMES].map(([variant, canonical]) => [variant.toLowerCase(), canonical.toLowerCase()]),
);

/**
 * A group name folded as the press folds it (`foldCameraGroupName` in
 * iracing-sdk): lower case, with a legacy spelling taken to its canonical one,
 * so `PIT LANE2` and `Pit Lane 2` fold alike (#1653 review).
 */
export function foldCameraGroupName(name: string): string {
  const lower = name.toLowerCase();

  return LEGACY_CAMERA_GROUP_NAMES_FOLDED.get(lower) ?? lower;
}

/** The canonical spelling of a group name, as `normalizeGroupName` reads it. */
export function normalizeCameraGroupName(name: string): string {
  return LEGACY_CAMERA_GROUP_NAMES.get(name) ?? name;
}

/**
 * The longest group name the plugin records: a copy of deck-iracing's
 * `CAMERA_GROUP_NAME_MAX_LENGTH` (the settings window's remove command restates
 * it too), held to it by `camera-focus-pi.test.ts`.
 */
export const CAMERA_GROUP_NAME_MAX_LENGTH = 256;

/**
 * Whether `name` is one the plugin would record (deck-iracing's
 * `isRecordableName`): a non-blank string no longer than
 * {@link CAMERA_GROUP_NAME_MAX_LENGTH} with no C0 control character or DEL.
 * The PI accepts exactly those, so it never stores a name the catalog could not
 * hold and the settings window could not remove.
 */
export function isAcceptableCameraGroupName(name: unknown): name is string {
  if (typeof name !== "string" || name.trim() === "" || name.length > CAMERA_GROUP_NAME_MAX_LENGTH) return false;

  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);

    if (code < 0x20 || code === 0x7f) return false;
  }

  return true;
}

/** A name-keyed boolean map with no prototype (see OWN KEYS ONLY above). */
function emptyGroupMap(): Record<string, boolean> {
  return Object.create(null) as Record<string, boolean>;
}

/** The value Change Camera falls back to (`CameraGroupField`'s default): Cockpit. */
export const DEFAULT_CAMERA_GROUP_VALUE = 9;

const STANDARD_BY_NAME = new Map(STANDARD_CAMERA_GROUP_OPTIONS.map((option) => [option.name, option]));
const STANDARD_BY_LOWER_NAME = new Map(
  STANDARD_CAMERA_GROUP_OPTIONS.map((option) => [option.name.toLowerCase(), option]),
);
const STANDARD_BY_VALUE = new Map(STANDARD_CAMERA_GROUP_OPTIONS.map((option) => [option.value, option]));

/** Whether `name` is one of the 25 standard groups, spelled exactly. */
export function isStandardCameraGroup(name: string): boolean {
  return STANDARD_BY_NAME.has(normalizeCameraGroupName(name));
}

/** The standard group spelled `name` exactly (after the legacy fold), or undefined. */
export function findStandardCameraGroup(name: string): StandardCameraGroupOption | undefined {
  return STANDARD_BY_NAME.get(normalizeCameraGroupName(name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The published `_cameraCatalog` view, read defensively: anything that is not a
 * version-1 view (unparseable JSON, another shape, a version this build does
 * not know) is `null`, which every consumer renders as "nothing remembered".
 *
 * Inside a valid view, a malformed entry costs only itself. A track keeps its
 * POSITION even when malformed, as an unnamed track, because the groups point
 * at tracks by index; a group without a usable name — or with one the plugin
 * never records ({@link isAcceptableCameraGroupName}) — is dropped, a repeated
 * name keeps its first entry, and track indices that are not whole numbers are
 * dropped.
 */
export function parseCameraCatalog(raw: unknown): CameraCatalogView | null {
  let parsed: unknown = raw;

  if (typeof raw === "string") {
    if (raw.length === 0) return null;

    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (!isRecord(parsed) || parsed.version !== 1) return null;

  if (!Array.isArray(parsed.tracks) || !Array.isArray(parsed.groups)) return null;

  const tracks: CameraCatalogViewTrack[] = parsed.tracks.map((track) =>
    isRecord(track) && typeof track.id === "number" && nonEmptyString(track.name)
      ? { id: track.id, name: track.name, config: typeof track.config === "string" ? track.config : "" }
      : { id: Number.NaN, name: "", config: "" },
  );

  const groups: CameraCatalogViewGroup[] = [];
  const seen = new Set<string>();

  for (const group of parsed.groups) {
    if (!isRecord(group) || !isAcceptableCameraGroupName(group.name)) continue;

    const name = normalizeCameraGroupName(group.name);

    if (seen.has(name)) continue;

    seen.add(name);
    groups.push({
      name,
      tracks: Array.isArray(group.tracks)
        ? group.tracks.filter((index): index is number => Number.isInteger(index))
        : [],
      lastSeen: typeof group.lastSeen === "string" ? group.lastSeen : "",
    });
  }

  let current: CameraCatalogViewCurrent | null = null;

  if (isRecord(parsed.current) && typeof parsed.current.trackId === "number" && Array.isArray(parsed.current.groups)) {
    const names: string[] = [];

    for (const name of parsed.current.groups) {
      if (!isAcceptableCameraGroupName(name)) continue;

      const canonical = normalizeCameraGroupName(name);

      if (!names.includes(canonical)) names.push(canonical);
    }

    current = { trackId: parsed.current.trackId, groups: names };
  }

  return { version: 1, tracks, groups, current };
}

/**
 * Whether the loaded camera file is a custom one, as far as the PI can tell: at
 * least one of the session's groups is outside the 25 standard names.
 *
 * A heuristic, and stated as one (decision 7): a custom file that uses only
 * standard names reads as the default cameras, and the heading never claims
 * more than it can see.
 */
export function isCustomCameraFile(current: CameraCatalogViewCurrent | null | undefined): boolean {
  return current?.groups.some((name) => !isStandardCameraGroup(name)) ?? false;
}

/**
 * The names of the tracks whose latest list holds `group`, de-duplicated (two
 * layouts of one track read as that track once) and sorted, leaving out the
 * current session's track and any unnamed one.
 */
export function trackNamesOf(catalog: CameraCatalogView, group: CameraCatalogViewGroup): string[] {
  const currentTrackId = catalog.current?.trackId;
  const names = new Set<string>();

  for (const index of group.tracks) {
    const track = catalog.tracks[index];

    if (track === undefined || track.name.length === 0 || track.id === currentTrackId) continue;

    names.add(track.name);
  }

  return [...names].sort(compareNames);
}

/** `Spa, Monza +2`: the first `max` names, then how many more there are. */
export function formatTrackList(names: readonly string[], max = 3): string {
  const shown = names.slice(0, max).join(", ");
  const rest = names.length - max;

  return rest > 0 ? `${shown} +${rest}` : shown;
}

/** Alphabetical, ignoring case, with a stable tie-break on the exact spelling. */
function compareNames(a: string, b: string): number {
  const folded = a.localeCompare(b, "en", { sensitivity: "base" });

  if (folded !== 0) return folded;

  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The name a Change Camera key stands for: its `cameraGroupName` when that is
 * non-empty, otherwise the standard group its `cameraGroup` number names — the
 * reading every key saved before #1653 gets. A number that is not one of ours
 * reads as the action reads it, as the fallback (Cockpit), so the picker and the
 * press agree.
 */
export function effectiveCameraGroupName(
  storedName: unknown,
  storedNumber: unknown,
  fallbackNumber: number = DEFAULT_CAMERA_GROUP_VALUE,
): string {
  if (typeof storedName === "string" && storedName.trim().length > 0) {
    return normalizeCameraGroupName(storedName.trim());
  }

  const number =
    typeof storedNumber === "number"
      ? storedNumber
      : typeof storedNumber === "string"
        ? Number(storedNumber)
        : Number.NaN;
  const option = STANDARD_BY_VALUE.get(number) ?? STANDARD_BY_VALUE.get(fallbackNumber);

  return option?.name ?? "Cockpit";
}

/** One `<option>` of the picker: the group name it stores and what it shows. */
export interface CameraGroupPickerOption {
  value: string;
  label: string;
}

/** One `<optgroup>` of the picker; a null heading is options outside any optgroup. */
export interface CameraGroupPickerSection {
  heading: string | null;
  options: CameraGroupPickerOption[];
}

/** The picker as decision 7 orders it, and the name to show selected. */
export interface CameraGroupPickerModel {
  sections: CameraGroupPickerSection[];
  /** The option value (a group name) the stored choice resolves to. */
  selected: string;
}

/** The headings the picker uses, fixed so the tests and the review page name them once. */
export const PICKER_HEADINGS = {
  onTrack: "On this track",
  onTrackCustom: "On this track (custom camera file)",
  remembered: "Other remembered groups",
  stored: "Saved on this key",
} as const;

/**
 * The name `stored` resolves to among `names`, the way the press resolves a
 * name against the session (decision 6): exactly first, then the one name that
 * matches once case and the legacy spellings are folded. Undefined when neither
 * finds exactly one.
 */
export function matchCameraGroupName(stored: string, names: Iterable<string>): string | undefined {
  const target = foldCameraGroupName(stored);
  let folded: string | undefined;
  let foldedCount = 0;

  for (const name of names) {
    if (name === stored) return name;

    if (foldCameraGroupName(name) === target) {
      folded = name;
      foldedCount++;
    }
  }

  return foldedCount === 1 ? folded : undefined;
}

/**
 * The Change Camera picker's options, in the spec's order (decision 7):
 *
 * 1. **On this track** — the session's groups in the sim's order, standard and
 *    custom alike, headed "On this track (custom camera file)" when one is not
 *    standard. Absent with no session.
 * 2. **The standard groups** not listed above, in the Car / Chase / Track /
 *    Aerial optgroups, each marked "(not on this track)" while a session is
 *    loaded. One the press resolves to a session group (decision 6: the
 *    session's `tv1` for `TV1`) is already listed in the session's spelling,
 *    and is not offered again as absent (#1653 review). With no session this
 *    is exactly the picker before #1653.
 * 3. **Other remembered groups** — every catalog name not shown above,
 *    alphabetically, labelled with up to three tracks whose latest list holds
 *    it, or "(seen before)" when none does; "(on this track)" for one the
 *    press resolves to a session group in another spelling.
 * 4. **The stored name** when none of the above lists it, so a key never looks
 *    unset.
 *
 * The fifth entry, Other…, is the component's own and not part of the model.
 */
export function buildCameraGroupPicker(catalog: CameraCatalogView | null, storedName: string): CameraGroupPickerModel {
  const sections: CameraGroupPickerSection[] = [];
  const listed = new Set<string>();
  const session = catalog?.current ?? null;
  const labelOf = (name: string): string => findStandardCameraGroup(name)?.label ?? name;

  if (session !== null && session.groups.length > 0) {
    const options: CameraGroupPickerOption[] = [];

    for (const name of session.groups) {
      if (listed.has(name)) continue;

      listed.add(name);
      options.push({ value: name, label: labelOf(name) });
    }

    sections.push({
      heading: isCustomCameraFile(session) ? PICKER_HEADINGS.onTrackCustom : PICKER_HEADINGS.onTrack,
      options,
    });
  }

  const missingSuffix = session !== null ? " (not on this track)" : "";
  const standardSections = new Map<string, CameraGroupPickerOption[]>();

  for (const option of STANDARD_CAMERA_GROUP_OPTIONS) {
    if (listed.has(option.name)) continue;

    listed.add(option.name);

    if (session !== null && matchCameraGroupName(option.name, session.groups) !== undefined) continue;

    const bucket = standardSections.get(option.section) ?? [];

    bucket.push({ value: option.name, label: `${option.label}${missingSuffix}` });
    standardSections.set(option.section, bucket);
  }

  for (const [heading, options] of standardSections) sections.push({ heading, options });

  if (catalog !== null) {
    const remembered = catalog.groups
      .filter((group) => !listed.has(group.name))
      .sort((a, b) => compareNames(a.name, b.name))
      .map((group): CameraGroupPickerOption => {
        listed.add(group.name);

        // A name the press resolves to a session group (decision 6: the
        // session's `DynamicTV` for a remembered `dynamictv`) keeps its own
        // option, labelled on this track rather than absent (#1653 review).
        const reachable = session !== null && matchCameraGroupName(group.name, session.groups) !== undefined;
        const suffix = reachable ? "(on this track)" : rememberedSuffix(catalog, group);

        return { value: group.name, label: `${group.name} ${suffix}` };
      });

    if (remembered.length > 0) sections.push({ heading: PICKER_HEADINGS.remembered, options: remembered });
  }

  const stored = storedName.trim().length > 0 ? normalizeCameraGroupName(storedName.trim()) : "";
  // This track's groups first, as the press resolves a name (decision 6): a
  // stored `TV1` on a file whose group is `tv1` selects that group, which the
  // press reaches, rather than the standard entry marked not on this track.
  const fromSession = stored.length > 0 && session !== null ? matchCameraGroupName(stored, session.groups) : undefined;
  let selected = fromSession ?? (stored.length > 0 ? matchCameraGroupName(stored, listed) : undefined);

  if (stored.length > 0 && selected === undefined) {
    sections.push({
      heading: PICKER_HEADINGS.stored,
      options: [{ value: stored, label: `${stored} ${session !== null ? "(not on this track)" : "(not seen yet)"}` }],
    });
    selected = stored;
  }

  return { sections, selected: selected ?? "" };
}

/**
 * `(not on this track: Spa, Monza +2)` while a session is loaded, `(on Spa,
 * Monza +2)` without one, and `(seen before)` when no track's latest list holds
 * the name any more.
 */
function rememberedSuffix(catalog: CameraCatalogView, group: CameraCatalogViewGroup): string {
  const tracks = trackNamesOf(catalog, group);

  if (tracks.length === 0) return "(seen before)";

  return catalog.current !== null
    ? `(not on this track: ${formatTrackList(tracks)})`
    : `(on ${formatTrackList(tracks)})`;
}

/**
 * The name a typed Other… entry stores, or null when there is nothing to store.
 *
 * Trimmed. A name the loaded session lists exactly is stored as typed, since
 * that is the group a press finds first (#1653 review: with `TV1` and `tv1`
 * both in the file, `tv1` means `tv1`). Otherwise legacy-folded: a standard
 * name typed in any case stores the canonical standard spelling (so its number
 * is written too), and any other name resolves as the press resolves a name —
 * exactly, then the one name matching ignoring case — first against the
 * session, so `dynamictv` stores the `DynamicTV` the file actually has, and
 * only then against the remembered names: a remembered `drone` from another
 * track neither makes the session's one `Drone` ambiguous nor breaks a tie
 * between two of the session's own names (#1653 review). A name none of them
 * settles is stored as typed.
 */
export function resolveTypedCameraGroupName(typed: string, catalog: CameraCatalogView | null): string | null {
  const trimmed = typed.trim();

  if (!isAcceptableCameraGroupName(trimmed)) return null;

  if (catalog?.current?.groups.includes(trimmed)) return trimmed;

  const folded =
    [...LEGACY_CAMERA_GROUP_NAMES].find(([variant]) => variant.toLowerCase() === trimmed.toLowerCase())?.[1] ?? trimmed;
  const standard = STANDARD_BY_LOWER_NAME.get(folded.toLowerCase());

  if (standard !== undefined) return standard.name;

  const session = catalog?.current?.groups ?? [];
  const inSession = matchCameraGroupName(folded, session);

  if (inSession !== undefined) return inSession;

  // Several of the session's own names match: a remembered one does not choose.
  const lower = folded.toLowerCase();

  if (session.some((name) => name.toLowerCase() === lower)) return folded;

  return matchCameraGroupName(folded, catalog?.groups.map((g) => g.name) ?? []) ?? folded;
}

/**
 * What choosing `name` writes (decision 5): the name always, and the `cameraGroup`
 * number too when the name is one of the 25 standard groups, as the string the
 * old `sdpi-select` stored. A custom name leaves the number as it was, so an
 * older build presses the last standard group the key had.
 */
export function cameraGroupWrite(name: string): { name: string; number?: string } {
  const standard = findStandardCameraGroup(name);

  return standard !== undefined ? { name: standard.name, number: String(standard.value) } : { name };
}

/** One entry of a Cycle Camera grid's Remembered groups section. */
export interface RememberedGroupEntry {
  name: string;
  /** Not on the current session's track (only ever true while a session is loaded). */
  dimmed: boolean;
  /** Tooltip: where the group has been seen. */
  title: string;
}

/**
 * The Remembered groups section of a Cycle Camera grid (decision 7): every
 * non-standard catalog name, plus every non-standard name `subset` ticks even
 * when the catalog no longer has it.
 *
 * The current track's custom groups come first, in the sim's order; then the
 * rest alphabetically, dimmed while a session is loaded. With no session there
 * is no "this track" to contrast with, so nothing is dimmed. A remembered or
 * ticked name the press resolves to a session group (decision 6: exactly, then
 * the one folded match — a stored `dynamictv` for the session's `DynamicTV`)
 * keeps its own row, but is on this track and not dimmed (#1653 review).
 */
export function buildRememberedGroups(
  catalog: CameraCatalogView | null,
  subset: Readonly<Record<string, unknown>> | null | undefined,
): RememberedGroupEntry[] {
  const session = catalog?.current ?? null;
  const entries: RememberedGroupEntry[] = [];
  const listed = new Set<string>();

  for (const name of session?.groups ?? []) {
    if (isStandardCameraGroup(name) || listed.has(name)) continue;

    listed.add(name);
    entries.push({ name, dimmed: false, title: "On this track" });
  }

  const rest = new Map<string, string>();

  for (const group of catalog?.groups ?? []) {
    if (isStandardCameraGroup(group.name) || listed.has(group.name) || rest.has(group.name)) continue;

    const tracks = catalog === null ? [] : trackNamesOf(catalog, group);

    rest.set(group.name, tracks.length > 0 ? `Seen on ${formatTrackList(tracks)}` : "Seen before");
  }

  // Object.entries reads own keys only, so a ticked `constructor` or
  // `__proto__` (own data properties of the parsed JSON) is listed, and nothing
  // inherited is.
  for (const [key, value] of Object.entries(subset ?? {})) {
    const name = normalizeCameraGroupName(key);

    if (value !== true || isStandardCameraGroup(name) || listed.has(name) || rest.has(name)) continue;

    rest.set(name, "No longer remembered");
  }

  const prefix = session !== null ? "Not on this track — " : "";

  for (const name of [...rest.keys()].sort(compareNames)) {
    const where = rest.get(name) ?? "";

    if (session !== null && matchCameraGroupName(name, session.groups) !== undefined) {
      entries.push({ name, dimmed: false, title: "On this track" });

      continue;
    }

    entries.push({
      name,
      dimmed: session !== null,
      title: session !== null ? `${prefix}${where.charAt(0).toLowerCase()}${where.slice(1)}` : where,
    });
  }

  return entries;
}

/**
 * Select All's effect on the remembered groups: tick the current track's custom
 * groups — the ones a press can act on now — and leave every other remembered
 * name as it is. Ticking hundreds of names seen elsewhere is not what "all" on
 * this screen means, and a custom group is never enabled by default (#958).
 * Returns a new null-prototype map holding `state`'s own entries; the standard
 * 25 are the template's to set.
 */
export function selectAllRemembered(
  state: Readonly<Record<string, boolean>>,
  catalog: CameraCatalogView | null,
): Record<string, boolean> {
  const next = emptyGroupMap();

  for (const [name, value] of Object.entries(state)) next[name] = value;

  for (const name of catalog?.current?.groups ?? []) {
    if (!isStandardCameraGroup(name)) next[name] = true;
  }

  return next;
}

/**
 * Clear's effect on the remembered groups: untick every one by dropping it from
 * the map, which is how a custom name leaves the stored subset (it enters only
 * when ticked). Returns a new null-prototype map; the standard 25 are the
 * template's to set.
 */
export function clearRemembered(state: Readonly<Record<string, boolean>>): Record<string, boolean> {
  const next = emptyGroupMap();

  for (const [name, value] of Object.entries(state)) {
    if (isStandardCameraGroup(name)) next[name] = value;
  }

  return next;
}

/**
 * The helpers `camera-focus.ejs`' inline script reaches as
 * `window.irdCameraGroups` (installed by `installCameraGroupHelpers`): the
 * script renders the grids, these decide what goes in them.
 */
export const CAMERA_GROUP_HELPERS = {
  parseCatalog: parseCameraCatalog,
  rememberedGroups: buildRememberedGroups,
  selectAllRemembered,
  clearRemembered,
  isStandard: isStandardCameraGroup,
} as const;

export type CameraGroupHelpers = typeof CAMERA_GROUP_HELPERS;
