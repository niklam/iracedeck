/**
 * Pure helpers for the icon-gallery generator (scripts/generate-icon-gallery.mts).
 * Everything here is node-free and unit-testable; the script owns all file IO.
 */
import { parseIconDefaults, renderIconTemplate } from "@iracedeck/icon-composer";

export interface GalleryEntry {
  class: "template" | "dynamic" | "key" | "dial" | "category";
  family: string;
  name: string;
  /** Repo-relative source path, e.g. packages/icons/fuel-service/add-fuel.svg */
  path: string;
  viewBox?: string;
  /** Color-slot placeholders present in the source SVG */
  slots: string[];
  /** Slots declared "locked" in the <desc> metadata */
  locked: string[];
  /** Resolved default title (runtime *_TITLES map entry, falling back to <desc>) */
  title?: string;
  /** Action folder names that import this icon */
  actions: string[];
  /** Site-absolute asset path, e.g. /icon-gallery/template/fuel-service/add-fuel.svg */
  file: string;
  /**
   * True when the rendering used hand-picked sample values (dynamic templates, dash box, and a
   * template icon that draws a value in its artwork, such as Switch by Car Number's `42`)
   */
  sample?: boolean;
  /**
   * Human-friendly display name for `template`-class entries' family (issue: gallery
   * feedback wave, item 11). The manifest `Name` when the family slug is exactly a
   * known action folder name, otherwise a title-cased fallback of the slug — see
   * `titleCaseSlug` in `sections.ts`. Also set on `dynamic`-class entries for the
   * three dynamic-only action groups. Unset for `key` and `category` entries.
   */
  familyName?: string;
}

const COLOR_SLOTS = ["backgroundColor", "textColor", "graphic1Color", "graphic2Color"] as const;

const TITLES_MAP_RE =
  /(?:export\s+)?const\s+[A-Z0-9_]*_TITLES\s*:\s*(?:Partial<)?Record<[A-Za-z0-9_$]+,\s*string>>?\s*=\s*\{([\s\S]*?)\n\};/g;
const TITLES_ENTRY_RE = /(?:["']([^"']+)["']|([A-Za-z0-9_$-]+))\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * Merged key→title entries from every string-valued `*_TITLES` map in an action
 * source file — `Record<string, string>`, typed-key `Record<SomeUnion, string>`,
 * and `Partial<Record<..., string>>` variants are all matched.
 */
export function parseTitlesMaps(actionSource: string): Record<string, string> {
  const titles: Record<string, string> = {};

  for (const mapMatch of actionSource.matchAll(TITLES_MAP_RE)) {
    for (const entry of mapMatch[1].matchAll(TITLES_ENTRY_RE)) {
      const key = entry[1] ?? entry[2];
      titles[key] = entry[3].replace(/\\n/g, "\n");
    }
  }

  return titles;
}

const ICON_IMPORT_RE = /from\s+["']@iracedeck\/icons\/([^"']+)\.svg["']/g;

/** `"<family>/<name>"` paths of every `@iracedeck/icons` SVG import in an action source file. */
export function parseIconImports(actionSource: string): string[] {
  return [...actionSource.matchAll(ICON_IMPORT_RE)].map((m) => m[1]);
}

/** Which of the four color slots appear as `{{...}}` placeholders in the SVG. */
export function extractColorSlots(svg: string): string[] {
  return COLOR_SLOTS.filter((slot) => svg.includes(`{{${slot}}}`));
}

/** The literal `viewBox` attribute value of the root SVG element. */
export function extractRawViewBox(svg: string): string | undefined {
  return svg.match(/<svg\b[^>]*\bviewBox\s*=\s*"([^"]+)"/i)?.[1];
}

const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;

/**
 * The names of a standalone icon's `{{...}}` placeholders that are not one of
 * the four color slots, each once, in source order — the values an action
 * fills at runtime (`{{value}}`, `{{needleAngle}}`, …) and the gallery has to
 * fill with a sample. Deliberately wider than the `[A-Za-z0-9]+` a template
 * key is made of: a mistyped `{{value-y}}` is still something that would
 * reach the page as text.
 */
export function extractValuePlaceholders(svg: string): string[] {
  const colorSlots: readonly string[] = COLOR_SLOTS;
  const names = [...svg.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);

  return [...new Set(names)].filter((name) => !colorSlots.includes(name));
}

/**
 * The sample values a template-class icon is rendered with (#1352):
 * `undefined` for an icon with color slots only — it is composed exactly as on
 * a device, so it is no sample — and otherwise its entry in `samples`.
 *
 * Throws when that entry is missing or leaves a placeholder uncovered, naming
 * the icon and the tokens, and when it holds a value no placeholder of the icon
 * uses (a colour slot included: `assembleIcon` lets the colours win anyway). Unlike {@link renderDynamicTemplate}, which blanks
 * what it has no sample for, a standalone icon's placeholder is drawn into its
 * artwork, so blanking it would publish a key with a hole in it: the next icon
 * to gain one fails the build until somebody decides what the gallery shows.
 *
 * @param iconPath - `<family>/<name>`, the key into `samples`
 * @param samples - Sample values per icon path; an `undefined` entry counts as missing
 */
export function resolveTemplateSample(
  iconPath: string,
  svg: string,
  samples: Readonly<Record<string, Record<string, string> | undefined>>,
): Record<string, string> | undefined {
  const tokens = extractValuePlaceholders(svg);

  if (tokens.length === 0) return undefined;

  const sample = samples[iconPath] ?? {};
  const uncovered = tokens.filter((token) => !Object.hasOwn(sample, token));

  if (uncovered.length > 0) {
    throw new Error(
      `Template icon ${iconPath} has no gallery sample value for ${uncovered.map((t) => `{{${t}}}`).join(", ")}. ` +
        "Give it one in the generator's template samples: left unfilled, the placeholder is published as literal text.",
    );
  }

  const unused = Object.keys(sample).filter((key) => !tokens.includes(key));

  if (unused.length > 0) {
    throw new Error(
      `Template icon ${iconPath}'s gallery sample has values no placeholder of the icon uses: ${unused.join(", ")}. ` +
        "Remove them: a key left behind by a renamed placeholder reads as covering something.",
    );
  }

  return sample;
}

/**
 * What is left of a template in a finished gallery asset: every distinct
 * `{{token}}` still in it, plus a bare `{{` for one that never closes or whose
 * name no template key could have. Empty for a clean asset. The generator
 * refuses to write an asset this finds anything in, whichever class it is.
 */
export function findLeftoverPlaceholders(asset: string): string[] {
  return [...new Set(asset.match(/\{\{(?:[A-Za-z0-9_.-]*\}\})?/g) ?? [])];
}

/**
 * Renders a dynamic (telemetry-driven) template for the gallery: <desc> default
 * colors + hand-picked sample values, with every remaining `{{token}}` blanked
 * so no raw placeholder leaks into the output.
 */
export function renderDynamicTemplate(svg: string, sampleValues: Record<string, string>): string {
  const blanks: Record<string, string> = {};

  for (const token of svg.matchAll(/\{\{([A-Za-z0-9]+)\}\}/g)) {
    blanks[token[1]] = "";
  }

  return renderIconTemplate(svg, { ...blanks, ...parseIconDefaults(svg), ...sampleValues });
}

/**
 * Sample values per dynamic template (keyed by file basename). Text-bearing
 * tokens get representative values; artwork tokens (iconContent, graphicContent,
 * warningContent, …) stay blank — that content is drawn live from telemetry, and
 * the gallery card is captioned accordingly.
 */
export const DYNAMIC_SAMPLE_DATA: Record<string, Record<string, string>> = {
  "adjust-style": {},
  "car-control-drs": { titleContent: sampleTitle("DRS", 92) },
  "car-control-pit-limiter": { titleContent: sampleTitle("PIT\nLIMITER", 92) },
  "car-control-push-to-pass": { titleContent: sampleTitle("P2P", 92) },
  "fuel-service": { titleContent: sampleTitle("FUEL\n+10 L") },
  "pit-quick-actions": { titleContent: sampleTitle("PIT\nACTIONS", 92) },
  "pit-quick-actions-fast-repair": { titleContent: sampleTitle("FAST\nREPAIR", 92) },
  "pit-quick-actions-windshield": { titleContent: sampleTitle("TEAROFF", 92) },
  "race-admin-car-selector": { titleContent: sampleTitle("CAR") },
  "session-info": { value: "P12", valueFontSize: "64", valueY: "88", titleContent: sampleTitle("POSITION") },
  "setup-brakes-abs-toggle": { titleContent: sampleTitle("ABS", 92) },
  "setup-traction-tc-toggle": { titleContent: sampleTitle("TC", 92) },
  "setup-view": { value: "52.4", valueFontSize: "48", valueY: "84", titleContent: sampleTitle("BIAS") },
  "telemetry-display": { titleContent: sampleTitle("SPEED") },
  "tire-service": { textElement: "" },
};

/**
 * A minimal centered title block matching the composed-icon look (18px bold, bottom-anchored).
 * @param text - The text to render (newline-separated for multi-line titles)
 * @param bottomY - The baseline y-coordinate for the last line (default 118); each prior line sits 20px above the one below it
 * @internal Exported for testing
 */
export function sampleTitle(text: string, bottomY: number = 118): string {
  const lines = text.split("\n");

  return lines
    .map(
      (line, i) =>
        `<text x="72" y="${bottomY - (lines.length - 1 - i) * 20}" font-family="Arial, sans-serif" font-size="18" font-weight="bold" fill="#ffffff" text-anchor="middle">${line}</text>`,
    )
    .join("");
}
