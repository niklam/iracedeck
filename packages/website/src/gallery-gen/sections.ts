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
   * `true` renders the section as ONE flat grid with no group `<h3>` sub-groups
   * — used by classes where family === the card's own name/a single artificial
   * family. Only `template` keeps grouping (gallery restructure wave, item 6:
   * the group list now includes both template families and the synthetic
   * dynamic-only action groups built by {@link buildTemplateGroups}).
   */
  flat: boolean;
}

/**
 * Only two classes render a top-level section as of the gallery restructure
 * wave: `key`, `dial`, and `category` were dissolved — their entries now
 * attach to a template-section group instead (item 2's action groups, item
 * 3's dial sub-rows, and the item-4 key/category same-slug unification below
 * that finally empties the old remainder sections). Per-device size facts
 * those sections used to carry live in `SIZE_FACTS` (item 5) so the numbers
 * aren't lost.
 */
export const CLASS_SECTIONS: ClassSection[] = [
  {
    id: "template",
    label: "Key icon templates",
    blurb:
      "The main icon library — artwork snippets composed with titles, colors, and borders at runtime, shown here grouped by the action that uses them, with their defaults. Pit Crew, Session Info, and Telemetry Display have no icon library of their own — they get a group here too, showing their dynamic template's sample render in place of a template grid.",
    blurbSize:
      "Composed onto a 144×144 key canvas, then rasterized to PNG per device: 144px (Stream Deck), 160px (Mini), 192px (XL / Neo), 240px (Stream Deck +); Mirabox and Ulanzi devices use the 144px default.",
    flat: false,
  },
  {
    id: "dynamic",
    label: "Dynamic templates",
    blurb:
      "Telemetry-driven full-canvas templates for actions that already have a template family above (car-control-*, pit-quick-actions-*, fuel-service, the Setup toggle sub-actions, tire-service, race-admin-car-selector, adjust-style, setup-view) — these render inside those actions' keys and are shown here with sample values.",
    blurbSize: "Full 144×144 canvas, rasterized per device exactly like the key icon templates above.",
    flat: true,
  },
];

/**
 * Per-device size facts that used to live in the now-dissolved "Static default
 * key images", "Category icons", and "Dial icons" section blurbs (item 5,
 * gallery restructure wave). Rendered as a compact list in the page intro,
 * above the first section — every number those sections carried is preserved
 * here.
 */
export const SIZE_FACTS: string[] = [
  "A group's default key image — shown before its icon templates (or, for a dynamic-only action group, its runtime content) first render — is a 72×72 SVG.",
  "A group's category-list glyph — the small icon shown in the deck app's action list, and as the chip beside the group heading above — is a 20×20 icon.",
  "A dial-capable action's group also shows its 72×72 encoder icon (the Elgato app UI) and a sample of its 200×100 touch-strip dash box; touch-strip pixmaps are rasterized at 200px width.",
];

/**
 * The three actions whose keys render entirely from a dynamic template, with
 * no static key-icon-template family of their own — Pit Crew, Session Info,
 * and Telemetry Display. Each gets a synthetic "action group" alongside the
 * real template families in {@link buildTemplateGroups}, sorted alphabetically
 * among them by display name (gallery restructure wave, item 2).
 */
export const DYNAMIC_ONLY_ACTIONS: readonly string[] = ["pit-crew", "session-info", "telemetry-display"];

/**
 * Explanatory paragraph rendered inside every action-only group (item 2),
 * styled like the section blurbs.
 */
export const DYNAMIC_ONLY_BLURB =
  "This action has no static icon templates — its keys are drawn at runtime from the dynamic template(s) below, shown here with sample values.";

/** Groups a class's entries by `family`, sorted alphabetically by family name. */
export function familiesOf(entries: GalleryEntry[], classId: string): [string, GalleryEntry[]][] {
  const map = new Map<string, GalleryEntry[]>();

  for (const e of entries.filter((e) => e.class === classId)) {
    map.set(e.family, [...(map.get(e.family) ?? []), e]);
  }

  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** The heading anchor id for a template-section group, e.g. `template-fuel-service`. */
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
 * The friendly display name for a template-section group (family or action):
 * the generator-resolved `familyName` carried by its entries (issue: gallery
 * feedback wave, item 11), falling back to a title-cased slug for safety
 * (e.g. a stale/missing field).
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
 * section, with depth-3 children ONLY for the template section — one per
 * group from {@link buildTemplateGroups} (family groups AND the three
 * dynamic-only action groups, gallery restructure wave item 6). The dynamic
 * section stays flat (no children).
 */
export function buildGalleryToc(entries: GalleryEntry[]): TocItem[] {
  return CLASS_SECTIONS.map((section) => {
    const children: TocItem[] = section.flat
      ? []
      : buildTemplateGroups(entries).map((group) => ({
          depth: 3,
          slug: group.anchor,
          text: group.displayName,
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
 * Resolves the entry of the given `cls` to render alongside a template-section
 * group — the "default icon" key card (item 10) or the heading's category
 * glyph (item 15). Tries the group's resolved consumer first
 * ({@link resolveFamilyAction}, including the item 16 same-name tie-break);
 * when that finds no entry — no consumer resolved, or the resolved consumer
 * has no entry of `cls` — falls back to a SAME-SLUG MATCH: an entry of `cls`
 * whose `name` equals the family/action slug directly, even when that's a
 * different action folder than the actual import-consumer.
 *
 * This same-slug fallback is what moves the `camera-focus` KEY card (and
 * category chip) onto the `camera-focus` template family's heading — the real
 * consumer (`camera-controls`) has no key.svg/icon.svg of its own, but a
 * same-named `camera-focus` action folder does, because the two are the SAME
 * real-world action split across two folders by a pre-rename UUID/asset path
 * (`CAMERA_FOCUS_UUID === CAMERA_CONTROLS_UUID` in camera-controls.ts) — the
 * key/icon assets never moved when the source folder was renamed. Both `key`
 * and `category` share this fallback as of the gallery restructure wave
 * (previously category-only, item 15's "owner follow-up refinement" — see
 * git history); unifying it both fixes the `camera-focus` key placement
 * (needed to make the old "Static default key images" remainder section
 * genuinely empty, item 4) and lets a dynamic-only action group (item 2, which
 * has NO template-class entries at all, so `resolveFamilyAction` always
 * returns undefined for it) resolve its default-icon row and category chip
 * through this exact same function — no separate resolution code needed.
 */
function defaultEntryFor(entries: GalleryEntry[], family: string, cls: "key" | "category"): GalleryEntry | undefined {
  const action = resolveFamilyAction(entries, family);
  const consumerMatch = action ? entries.find((e) => e.class === cls && e.name === action) : undefined;

  return consumerMatch ?? entries.find((e) => e.class === cls && e.name === family);
}

/** Every group slug that renders in the template section — real template families plus the {@link DYNAMIC_ONLY_ACTIONS}. */
function allGroupSlugs(entries: GalleryEntry[]): string[] {
  return [...familiesOf(entries, "template").map(([family]) => family), ...DYNAMIC_ONLY_ACTIONS];
}

/** The set of entry names of the given `cls` placed into a template-section group. */
function computePlacedActions(entries: GalleryEntry[], cls: "key" | "category"): Set<string> {
  const placed = new Set<string>();

  for (const slug of allGroupSlugs(entries)) {
    const hit = defaultEntryFor(entries, slug, cls);

    if (hit) placed.add(hit.name);
  }

  return placed;
}

/** Entries of the given `cls` NOT placed into any template-section group — genuine orphans. */
function remainderOf(entries: GalleryEntry[], cls: "key" | "category"): GalleryEntry[] {
  const placed = computePlacedActions(entries, cls);

  return entries.filter((e) => e.class === cls && !placed.has(e.name));
}

/**
 * Resolves the `key`-class entry to render as a template-section group's
 * "default icon" card (item 10; item 2 for action groups).
 */
export function defaultKeyFor(entries: GalleryEntry[], family: string): GalleryEntry | undefined {
  return defaultEntryFor(entries, family, "key");
}

/**
 * The set of `key`-class entry names placed into a template-section group by
 * {@link defaultKeyFor}, across every group present in `entries`.
 */
export function computePlacedKeyActions(entries: GalleryEntry[]): Set<string> {
  return computePlacedActions(entries, "key");
}

/**
 * `key`-class entries NOT placed into any template-section group — genuine
 * orphans with no group of their own (e.g. an action folder with a key.svg
 * but no template family, no dynamic template, and no manifest entry among
 * {@link DYNAMIC_ONLY_ACTIONS}). Expected empty on the real dataset as of the
 * gallery restructure wave (item 4) — the old standalone "Static default key
 * images" section was removed because of it; kept here as the regression
 * guard/safety net rather than silently dropping a future real orphan.
 */
export function keyRemainder(entries: GalleryEntry[]): GalleryEntry[] {
  return remainderOf(entries, "key");
}

/**
 * Resolves the `category`-class entry to render as the small glyph chip
 * beside a template-section group's heading (item 15; item 2 for action
 * groups). Shares {@link defaultEntryFor}'s same-slug fallback with
 * {@link defaultKeyFor} as of the gallery restructure wave.
 */
export function defaultCategoryFor(entries: GalleryEntry[], family: string): GalleryEntry | undefined {
  return defaultEntryFor(entries, family, "category");
}

/**
 * The set of `category`-class entry names placed beside a template-section
 * group's heading by {@link defaultCategoryFor}, across every group present in
 * `entries`.
 */
export function computePlacedCategoryActions(entries: GalleryEntry[]): Set<string> {
  return computePlacedActions(entries, "category");
}

/**
 * `category`-class entries NOT placed beside any template-section group's
 * heading — genuine orphans. Expected empty on the real dataset (item 4); see
 * {@link keyRemainder}.
 */
export function categoryRemainder(entries: GalleryEntry[]): GalleryEntry[] {
  return remainderOf(entries, "category");
}

/**
 * `dynamic`-class entries NOT tagged with a {@link DYNAMIC_ONLY_ACTIONS}
 * action's own slug as `family` — the flat "Dynamic templates" section's grid
 * content (item 4). The excluded entries (Pit Crew's two tri-state samples,
 * Session Info, Telemetry Display) render inside their action group instead
 * (item 2).
 */
export function dynamicSectionEntries(entries: GalleryEntry[]): GalleryEntry[] {
  return entries.filter((e) => e.class === "dynamic" && e.family === "dynamic-templates");
}

/**
 * The `dial`-class entries (encoder icon + touch-strip dash sample, in that
 * order) belonging to a given template-section group's slug — dial.svg is
 * filed with `family === name === slug`; the dash sample is filed under
 * `touch-strip` with `name === "<slug>-dash"` (gallery restructure wave, item
 * 3). Either or both may be absent — most groups have neither.
 */
export function dialEntriesFor(entries: GalleryEntry[], slug: string): GalleryEntry[] {
  const icon = entries.find((e) => e.class === "dial" && e.family === slug && e.name === slug);
  const dash = entries.find((e) => e.class === "dial" && e.name === `${slug}-dash`);

  return [icon, dash].filter((e): e is GalleryEntry => e !== undefined);
}

/**
 * `dial`-class entries not attached to any template-section group via
 * {@link dialEntriesFor} — the item 3 safety net. Expected empty on the real
 * dataset; if non-empty, the component keeps a rump "Dials" section for the
 * leftovers rather than silently dropping them.
 */
export function dialRemainder(entries: GalleryEntry[]): GalleryEntry[] {
  const claimed = new Set<string>();

  for (const slug of allGroupSlugs(entries)) {
    for (const e of dialEntriesFor(entries, slug)) claimed.add(e.file);
  }

  return entries.filter((e) => e.class === "dial" && !claimed.has(e.file));
}

/**
 * One group rendered in the template section — either a real template family
 * (`kind: "family"`) or a synthetic action group for one of the
 * {@link DYNAMIC_ONLY_ACTIONS} (`kind: "action"`, gallery restructure wave
 * item 2). The two kinds share one rendering shape in the component: a
 * heading (category chip + display name + slug), an optional blurb
 * (action groups only), an optional "default icon" row, a main grid
 * (template entries for a family, the action's dynamic-template sample
 * render(s) for an action group), and an optional dial sub-row (item 3).
 */
export interface TemplateGroup {
  kind: "family" | "action";
  /** The family or action folder slug, e.g. `fuel-service` or `pit-crew`. Shown beneath the heading. */
  slug: string;
  /** The heading anchor id, e.g. `template-fuel-service`. */
  anchor: string;
  /** Friendly display name — resolved identically for both kinds (item 11 / item 2). */
  displayName: string;
  /** The group's main grid. */
  entries: GalleryEntry[];
  /** The "default icon" key card placed at the front of the group. */
  defaultKey?: GalleryEntry;
  /** The category-glyph chip shown beside the heading. */
  categoryIcon?: GalleryEntry;
  /** Dial sub-row entries (icon + dash sample) attached to this group — empty when the action isn't dial-capable. */
  dialEntries: GalleryEntry[];
  /** Explanatory paragraph shown inside an action-only group. Undefined for family groups. */
  blurb?: string;
}

/**
 * Builds the template section's full group list (gallery restructure wave,
 * item 2) — one entry per template family (unchanged shape/placement rules)
 * plus one synthetic action group per {@link DYNAMIC_ONLY_ACTIONS}, all sorted
 * together alphabetically by display name (item 2: "sorted alphabetically
 * among the families by display name"). A dial-capable group additionally
 * carries its dial.svg + dash-sample entries via {@link dialEntriesFor} (item
 * 3).
 */
export function buildTemplateGroups(entries: GalleryEntry[]): TemplateGroup[] {
  const familyGroups: TemplateGroup[] = familiesOf(entries, "template").map(([family, templates]) => ({
    kind: "family",
    slug: family,
    anchor: familyAnchor("template", family),
    displayName: familyDisplayName(family, entries),
    entries: templates,
    defaultKey: defaultKeyFor(entries, family),
    categoryIcon: defaultCategoryFor(entries, family),
    dialEntries: dialEntriesFor(entries, family),
  }));

  const actionGroups: TemplateGroup[] = DYNAMIC_ONLY_ACTIONS.map((action) => ({
    kind: "action",
    slug: action,
    anchor: familyAnchor("template", action),
    displayName: familyDisplayName(action, entries),
    entries: dynamicEntriesForFamily(entries, action),
    defaultKey: defaultKeyFor(entries, action),
    categoryIcon: defaultCategoryFor(entries, action),
    dialEntries: dialEntriesFor(entries, action),
    blurb: DYNAMIC_ONLY_BLURB,
  }));

  return [...familyGroups, ...actionGroups].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** The `dynamic`-class entries belonging to a given family/action slug. */
function dynamicEntriesForFamily(entries: GalleryEntry[], family: string): GalleryEntry[] {
  return entries.filter((e) => e.class === "dynamic" && e.family === family);
}
