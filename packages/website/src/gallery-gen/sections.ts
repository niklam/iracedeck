/**
 * Pure, shared gallery-section logic — consumed by both the Astro component
 * (`IconGallery.astro`) and the Starlight route-data middleware (`routeData.ts`),
 * and by the generator script for the `familyName` title-case fallback. No Node
 * APIs: everything here operates on the already-generated `GalleryEntry[]`.
 */
import type { GalleryEntry } from "./lib.js";

/** One section of the gallery page, one per `GalleryEntry["class"]`. */
export interface ClassSection {
  id: GalleryEntry["class"];
  label: string;
  blurb: string;
  /** A short second sentence naming the on-device pixel size(s) for this class (item 6). */
  blurbSize: string;
  /**
   * `true` renders the section as ONE flat grid with no family `<h3>` sub-groups
   * (item 7) — used by classes where family === the card's own name/a single
   * artificial family. Only `template` keeps family grouping.
   */
  flat: boolean;
}

export const CLASS_SECTIONS: ClassSection[] = [
  {
    id: "template",
    label: "Key icon templates",
    blurb:
      "The main icon library — artwork snippets composed with titles, colors, and borders at runtime, shown here with their defaults.",
    blurbSize:
      "Composed onto a 144×144 key canvas, then rasterized to PNG per device: 144px (Stream Deck), 160px (Mini), 192px (XL / Neo), 240px (Stream Deck +); Mirabox and Ulanzi devices use the 144px default.",
    flat: false,
  },
  {
    id: "dynamic",
    label: "Dynamic templates",
    blurb:
      "Telemetry-driven full-canvas templates. Cards show the template frame with sample values; live content is drawn from telemetry at runtime.",
    blurbSize: "Full 144×144 canvas, rasterized per device exactly like the key icon templates above.",
    flat: true,
  },
  {
    id: "key",
    label: "Static default key images",
    blurb:
      "The default key image shown by the deck app before an action first renders, for actions whose keys render entirely from dynamic templates (every other action's default key image is shown as the first card of its template family group above).",
    blurbSize: "72×72 SVGs.",
    flat: true,
  },
  {
    id: "dial",
    label: "Dial icons",
    blurb: "Per-action encoder icons plus a rendering of each dial's live touch-strip dash box.",
    blurbSize:
      "72×72 encoder icons shown in the Elgato app UI; the touch-strip slot each dial owns on Stream Deck + is 200×100, with pixmaps rasterized at 200px width.",
    flat: true,
  },
  {
    id: "category",
    label: "Category icons",
    blurb:
      "The small icons shown in the deck app's action list, for actions whose keys render entirely from dynamic templates (every other action's category icon is shown as a small chip beside its template family heading above).",
    blurbSize: "20×20 icons.",
    flat: true,
  },
];

/** Groups a class's entries by `family`, sorted alphabetically by family name. */
export function familiesOf(entries: GalleryEntry[], classId: string): [string, GalleryEntry[]][] {
  const map = new Map<string, GalleryEntry[]>();

  for (const e of entries.filter((e) => e.class === classId)) {
    map.set(e.family, [...(map.get(e.family) ?? []), e]);
  }

  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** The heading anchor id for a family group, e.g. `template-fuel-service`. */
export function familyAnchor(classId: string, family: string): string {
  return `${classId}-${family}`;
}

/** Title-cases a hyphenated slug: `camera-select` -> `Camera Select`. */
export function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

/**
 * The friendly display name for a template family: the generator-resolved
 * `familyName` carried by its entries (issue: gallery feedback wave, item 11),
 * falling back to a title-cased slug for safety (e.g. a stale/missing field).
 */
export function familyDisplayName(family: string, entries: GalleryEntry[]): string {
  const withName = entries.find((e) => e.family === family && e.familyName);

  return withName?.familyName ?? titleCaseSlug(family);
}

/** One node of the gallery's injected table-of-contents (item 3). */
export interface TocItem {
  depth: number;
  slug: string;
  text: string;
  children: TocItem[];
}

/**
 * Builds the page TOC entries for the gallery: one depth-2 item per class
 * section, with depth-3 family children ONLY for sections that render family
 * groups (`flat: false` — currently just `template`). Family placement (item
 * 10, the default-key-image cards) does not change the TOC.
 */
export function buildGalleryToc(entries: GalleryEntry[]): TocItem[] {
  return CLASS_SECTIONS.map((section) => {
    const children: TocItem[] = section.flat
      ? []
      : familiesOf(entries, section.id).map(([family]) => ({
          depth: 3,
          slug: familyAnchor(section.id, family),
          text: familyDisplayName(family, entries),
          children: [],
        }));

    return {
      depth: 2,
      slug: `class-${section.id}`,
      text: section.label,
      children,
    };
  });
}

/**
 * The template family's consuming action, for placement purposes. Shared by
 * {@link defaultKeyFor} and {@link defaultCategoryFor} (item 10, extended to
 * `category` by item 15) so the resolution rule lives in exactly one place.
 *
 * - Zero consumers -> undefined.
 * - Exactly one consumer -> that action.
 * - Multiple consumers -> the SAME-NAME TIE-BREAK (item 16): a family shared
 *   by several actions (e.g. `force-feedback`, imported by both the
 *   `force-feedback` and `cockpit-misc` actions) prefers the action whose
 *   folder name equals the family slug — that's the family's "home" action.
 *   Falls back to undefined (no placement) when no same-named consumer
 *   exists among the multiple candidates.
 */
function resolveFamilyAction(entries: GalleryEntry[], family: string): string | undefined {
  const actionNames = new Set<string>();

  for (const e of entries) {
    if (e.class !== "template" || e.family !== family) continue;

    for (const action of e.actions) actionNames.add(action);
  }

  if (actionNames.size === 0) return undefined;

  if (actionNames.size === 1) return [...actionNames][0];

  return actionNames.has(family) ? family : undefined;
}

/**
 * Resolves the entry of the given `cls` to render alongside a template
 * family — the "default icon" key card (item 10) or the family-heading
 * category glyph (item 15). Returns undefined when the family's consuming
 * action can't be resolved (see {@link resolveFamilyAction}), or when that
 * action has no entry of `cls`.
 */
function defaultEntryFor(entries: GalleryEntry[], family: string, cls: "key" | "category"): GalleryEntry | undefined {
  const action = resolveFamilyAction(entries, family);

  if (!action) return undefined;

  return entries.find((e) => e.class === cls && e.name === action);
}

/** The set of entry names of the given `cls` placed into a template family group. */
function computePlacedActions(entries: GalleryEntry[], cls: "key" | "category"): Set<string> {
  const placed = new Set<string>();

  for (const [family] of familiesOf(entries, "template")) {
    const hit = defaultEntryFor(entries, family, cls);

    if (hit) placed.add(hit.name);
  }

  return placed;
}

/** Entries of the given `cls` NOT placed into any template family group — the standalone-section remainder. */
function remainderOf(entries: GalleryEntry[], cls: "key" | "category"): GalleryEntry[] {
  const placed = computePlacedActions(entries, cls);

  return entries.filter((e) => e.class === cls && !placed.has(e.name));
}

/**
 * Resolves the `key`-class entry to render as a template family's "default
 * icon" card (item 10).
 */
export function defaultKeyFor(entries: GalleryEntry[], family: string): GalleryEntry | undefined {
  return defaultEntryFor(entries, family, "key");
}

/**
 * The set of `key`-class entry names placed into a template family group by
 * {@link defaultKeyFor}, across every template family present in `entries`.
 */
export function computePlacedKeyActions(entries: GalleryEntry[]): Set<string> {
  return computePlacedActions(entries, "key");
}

/**
 * `key`-class entries NOT placed into any template family group — the
 * remainder that keeps the standalone "Static default key images" section
 * (item 10). Empty when every key entry was placed.
 */
export function keyRemainder(entries: GalleryEntry[]): GalleryEntry[] {
  return remainderOf(entries, "key");
}

/**
 * Resolves the `category`-class entry to render as the small glyph chip
 * beside a template family's heading (item 15). Tries the same
 * consumer-resolution rule as {@link defaultKeyFor} first (including the item
 * 16 same-name tie-break); if that finds nothing, falls back to a
 * SAME-SLUG MATCH (owner follow-up refinement): a `category` entry whose
 * `name` equals the family slug, even when that action isn't the family's
 * actual import-consumer. This is what moves the `camera-focus` chip onto the
 * `camera-focus` template family's heading — the real consumer
 * (`camera-controls`) has no category icon, but the separate, same-named
 * `camera-focus` action folder does. Deliberately `category`-only: `key`
 * placement stays purely consumer-resolution based, so this fallback does not
 * apply to {@link defaultKeyFor}.
 */
export function defaultCategoryFor(entries: GalleryEntry[], family: string): GalleryEntry | undefined {
  return (
    defaultEntryFor(entries, family, "category") ?? entries.find((e) => e.class === "category" && e.name === family)
  );
}

/**
 * The set of `category`-class entry names placed beside a template family
 * heading by {@link defaultCategoryFor}, across every template family present
 * in `entries`.
 */
export function computePlacedCategoryActions(entries: GalleryEntry[]): Set<string> {
  const placed = new Set<string>();

  for (const [family] of familiesOf(entries, "template")) {
    const hit = defaultCategoryFor(entries, family);

    if (hit) placed.add(hit.name);
  }

  return placed;
}

/**
 * `category`-class entries NOT placed beside any template family heading —
 * the remainder that keeps the standalone "Category icons" section (item 15).
 * Empty when every category entry was placed.
 */
export function categoryRemainder(entries: GalleryEntry[]): GalleryEntry[] {
  const placed = computePlacedCategoryActions(entries);

  return entries.filter((e) => e.class === "category" && !placed.has(e.name));
}
