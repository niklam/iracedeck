/**
 * Pure helpers behind the three voice-pack reference components
 * (`src/components/PackReference*.astro`): grouping, anchors, the words for a
 * contract's scheduling flags, and the one text transform the recording
 * script needs. Kept out of the `.astro` files so they can be unit-tested
 * without rendering a page.
 */
import type {
  Callout,
  PackReferenceVocabulary,
  RecordingGroup,
  RecordingLine,
  VocabularyItem,
} from "./pack-reference-types.js";

// ─── Callouts ────────────────────────────────────────────────────────────────

/** Callouts that share a family, in the order the page renders them. `family` is `null` for the last bucket. */
export type FamilyGroup = { family: string | null; anchor: string; callouts: readonly Callout[] };

/** The anchor of the bucket callouts with no family render under. */
export const NO_FAMILY_ANCHOR = "family-none";

/** The heading of that bucket. */
export const NO_FAMILY_LABEL = "No family";

/**
 * Group callouts by `family` in code-point order — the order the artifact's
 * ids already come in — with the `null` bucket LAST: a callout with no
 * family neither replaces nor is replaced by a family-mate, and it must not
 * be given one here just to sort it.
 */
export function groupByFamily(callouts: readonly Callout[]): FamilyGroup[] {
  const byFamily = new Map<string, Callout[]>();
  const unfamilied: Callout[] = [];

  for (const callout of callouts) {
    if (callout.family === null) {
      unfamilied.push(callout);
      continue;
    }

    const bucket = byFamily.get(callout.family);

    if (bucket) bucket.push(callout);
    else byFamily.set(callout.family, [callout]);
  }

  const groups: FamilyGroup[] = [...byFamily.keys()]
    .sort(compare)
    .map((family) => ({ family, anchor: familyAnchor(family), callouts: byFamily.get(family) ?? [] }));

  if (unfamilied.length > 0) groups.push({ family: null, anchor: NO_FAMILY_ANCHOR, callouts: unfamilied });

  return groups;
}

/** `pit-service.fuel` → `family-pit-service-fuel`; the dot is the only character a family name carries that an anchor should not. */
export function familyAnchor(family: string): string {
  return `family-${family.replace(/\./g, "-")}`;
}

/**
 * `70` with band `SAFETY` → `"70 (safety)"`; an off-band value such as `65`
 * is shown bare. The band is the artifact's — the generator names it from
 * the engine's `WEIGHT` — so the page mirrors no table of its own.
 */
export function describeWeight(callout: Pick<Callout, "weight" | "weightBand">): string {
  return callout.weightBand === null
    ? String(callout.weight)
    : `${callout.weight} (${callout.weightBand.toLowerCase()})`;
}

/** The `base` that puts a bare clip path inside the active voice's folder — the common one, worth its own words. */
export const VOICE_FOLDER_BASE = "voice/{voice}";

/** Where a bare literal clip path in this callout's entry resolves, in words: the voice's folder, the audio root, or under the base. */
export function describeBase(callout: Pick<Callout, "base">): string {
  if (callout.base === null) return "none — a bare clip path resolves from the audio root";

  if (callout.base === VOICE_FOLDER_BASE) {
    return `${VOICE_FOLDER_BASE} — a bare clip path resolves inside the active voice's folder`;
  }

  return `${callout.base} — a bare clip path resolves under ${callout.base}/ from the audio root`;
}

/**
 * The two scheduling flags in words, for the callout's fact list. A fire
 * that cannot take the radio right now is either deferred and replayed
 * when it next falls silent (`queueable`) or dropped; a fire that wins the
 * radio over a quieter line in flight cuts it mid-sentence (`interrupt`)
 * or waits for it to finish.
 */
export function describeScheduling(callout: Pick<Callout, "queueable" | "interrupt">): string {
  const busy = callout.queueable ? "deferred and replayed when the radio is busy" : "dropped when the radio is busy";
  const quieter = callout.interrupt
    ? "cuts a quieter line that is already playing"
    : "waits for a quieter line that is already playing to finish";

  return `${busy}; ${quieter}`;
}

/** The trigger in words: the bus event, or the fact that only the plugin fires it. */
export function describeTrigger(callout: Pick<Callout, "event">): string {
  return callout.event ?? "fired by the plugin directly, not by a bus event";
}

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/** Look a var up by name; `undefined` when the vocabulary does not carry it. */
export function findVar(vocabulary: PackReferenceVocabulary, name: string): VocabularyItem | undefined {
  return vocabulary.vars.find((v) => v.name === name);
}

// ─── Recording script ────────────────────────────────────────────────────────

/** The visible stand-in for an SSML `<break …/>` in a take's text. */
export const PAUSE_MARKER = "…";

/**
 * A take's text as the page shows it. The bundled config's texts are
 * ElevenLabs prompts and carry SSML verbatim; a `<break time="0.3s"/>` is a
 * pause the actor should leave, so it becomes a visible {@link PAUSE_MARKER},
 * and any other tag is dropped. No markup ever reaches the page from here.
 */
export function renderTakeText(text: string): string {
  return text
    .replace(/<break\b[^>]*\/?>/gi, ` ${PAUSE_MARKER} `)
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A consumer the line reaches through a var: the var's name and the callouts whose entries name it. */
export type ViaVarConsumers = { name: string; usedBy: readonly string[] };

/**
 * The callouts a recording line reaches through each var in `viaVar` — the
 * var looked up in the vocabulary — so the page can list them apart from
 * the line's direct consumers. A var the vocabulary does not carry is still
 * listed, with nothing under it, rather than silently dropped.
 */
export function viaVarConsumers(
  line: Pick<RecordingLine, "viaVar">,
  vocabulary: PackReferenceVocabulary,
): ViaVarConsumers[] {
  return line.viaVar.map((name) => ({ name, usedBy: findVar(vocabulary, name)?.usedBy ?? [] }));
}

/** Whether nothing — no entry, no fragment, no var, no plugin code — draws from the line. */
export function isUnusedLine(line: Pick<RecordingLine, "usedBy" | "viaVar" | "playedBy">): boolean {
  return line.usedBy.length === 0 && line.viaVar.length === 0 && line.playedBy === null;
}

/** Whether nothing draws from any line of the group. */
export function isUnusedGroup(group: Pick<RecordingGroup, "lines">): boolean {
  return group.lines.every(isUnusedLine);
}

/**
 * The one `playedBy` EVERY line of the group carries, or `undefined`. The
 * artifact says per line what plugin code plays it for (the generator's
 * words — the website keeps no list of its own); where a whole group says
 * the same thing (`names/`, one clip per driver name), the page says it once
 * above the table instead of on every row.
 */
export function groupPlayedBy(group: Pick<RecordingGroup, "lines">): string | undefined {
  const [first, ...rest] = group.lines;

  if (first === undefined || first.playedBy === null) return undefined;

  return rest.every((line) => line.playedBy === first.playedBy) ? first.playedBy : undefined;
}

/** The note shown under an unreferenced group the plugin does not play either — the bundled voice's own leftovers. */
export const UNUSED_GROUP_NOTE =
  "No script entry or variable draws from this group. It is a leftover of the bundled voice; a pack does not need it.";

/** The note shown beside an unreferenced line inside a group that is otherwise used. */
export const UNUSED_LINE_NOTE = "Nothing in the script draws from this line.";

/** The note for a group: what the plugin plays every line of it for, or that nothing draws from it. `undefined` otherwise. */
export function groupNote(group: RecordingGroup): string | undefined {
  return groupPlayedBy(group) ?? (isUnusedGroup(group) ? UNUSED_GROUP_NOTE : undefined);
}

/** The line's own `playedBy`, unless the group note already says it for every line. `null` when there is nothing to add. */
export function linePlayedBy(line: Pick<RecordingLine, "playedBy">, note: string | undefined): string | null {
  return line.playedBy !== null && line.playedBy !== note ? line.playedBy : null;
}

/** `corner-names` → `group-corner-names`. */
export function groupAnchor(group: string): string {
  return `group-${group}`;
}

// ─── Cross-page links ────────────────────────────────────────────────────────

/** The three reference pages, as site-absolute paths. */
export const REFERENCE_PAGES = {
  callouts: "/docs/voice-packs/reference/callouts/",
  vocabulary: "/docs/voice-packs/reference/vocabulary/",
  recordingScript: "/docs/voice-packs/reference/recording-script/",
} as const;

/** A callout's anchor is its id verbatim — `pit-crew.flag-green` — so a reader can type it from a log line. */
export function calloutHref(id: string): string {
  return `${REFERENCE_PAGES.callouts}#${id}`;
}

export function varAnchor(name: string): string {
  return `var-${name}`;
}

export function condAnchor(name: string): string {
  return `cond-${name}`;
}

export function caseAnchor(name: string): string {
  return `case-${name}`;
}

export function varHref(name: string): string {
  return `${REFERENCE_PAGES.vocabulary}#${varAnchor(name)}`;
}

export function condHref(name: string): string {
  return `${REFERENCE_PAGES.vocabulary}#${condAnchor(name)}`;
}

export function caseHref(name: string): string {
  return `${REFERENCE_PAGES.vocabulary}#${caseAnchor(name)}`;
}

/** `flags/green-race` → `line-flags-green-race`; a pool reference is always `group/base`, so the slash is the only character to fold. */
export function lineAnchor(pool: string): string {
  return `line-${pool.replace("/", "-")}`;
}

export function lineHref(pool: string): string {
  return `${REFERENCE_PAGES.recordingScript}#${lineAnchor(pool)}`;
}

// ─── Table of contents ───────────────────────────────────────────────────────

/** One node of the injected "On this page" table of contents (the shape `routeData.ts` hands Starlight). */
export type TocItem = { depth: number; slug: string; text: string; children: TocItem[] };

/** One depth-2 entry per family, in render order, the no-family bucket last. */
export function calloutsToc(callouts: readonly Callout[]): TocItem[] {
  return groupByFamily(callouts).map((group) => ({
    depth: 2,
    slug: group.anchor,
    text: group.family ?? NO_FAMILY_LABEL,
    children: [],
  }));
}

/** The three vocabulary sections' anchors and headings, in render order. */
export const VOCABULARY_SECTIONS = [
  { anchor: "vars", label: "Variables" },
  { anchor: "conds", label: "Conditions" },
  { anchor: "cases", label: "Cases" },
] as const;

export function vocabularyToc(): TocItem[] {
  return VOCABULARY_SECTIONS.map((section) => ({ depth: 2, slug: section.anchor, text: section.label, children: [] }));
}

/** One depth-2 entry per clip group, in the artifact's order. */
export function recordingScriptToc(groups: readonly RecordingGroup[]): TocItem[] {
  return groups.map((group) => ({ depth: 2, slug: groupAnchor(group.group), text: `${group.group}/`, children: [] }));
}

// ─── Ordering ────────────────────────────────────────────────────────────────

/** Code-point order, the order the artifact is sorted in. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
