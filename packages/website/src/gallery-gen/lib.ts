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
  /** True when the rendering used hand-picked sample values (dynamic templates, dash box) */
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
