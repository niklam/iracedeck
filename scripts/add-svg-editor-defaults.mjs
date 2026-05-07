#!/usr/bin/env node

/**
 * SVG Editor Defaults
 *
 * Adds IDE-only conveniences to every static icon in packages/icons/**\/*.svg
 * so the artwork is visible in IDE preview panes (where the {{graphicNColor}}
 * Mustache placeholders don't resolve to a color):
 *
 * 1. Root <svg> gets `stroke-width="0.5" stroke="#fff" fill="#fff"`. The
 *    stroke-width is normalized — any existing root stroke-width is replaced
 *    with 0.5 so every icon previews at the same hairline weight. `stroke=` and
 *    `fill=` are added only when absent (author-set colors are preserved).
 * 2. Any drawable element with an explicit `fill=` but no `stroke=` gets
 *    `stroke="none"`. Without this, filled paths inherit the root `stroke=#fff`
 *    and tiny path artifacts (zero-length `h0` segments, `s-w,0,-w,0`
 *    reverse-Beziers, etc.) render as visible spikes/dots in IDE previews.
 * 3. Each <text> element without a `stroke=` attribute gets `stroke="none"` —
 *    otherwise the root stroke would draw an outline around every glyph.
 *
 * Re-runs are safe: the script is a no-op once every icon already has the
 * canonical attributes.
 *
 * The attributes only affect IDE rendering — `extractGraphicContent()` strips
 * the outer <svg> tag at render time, so root attributes never reach the
 * Stream Deck, and `stroke="none"` on inner elements matches the SVG default
 * (no stroke when none is declared) so it's a no-op at runtime.
 *
 * Usage:
 *   node scripts/add-svg-editor-defaults.mjs            # Apply
 *   node scripts/add-svg-editor-defaults.mjs --dry-run  # Preview
 */

import fs from "node:fs";
import path from "node:path";

const ICONS_DIR = path.resolve("packages/icons");
const SKIP_DIRS = new Set(["preview", "node_modules", "src", "dist"]);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

let totalProcessed = 0;
let totalSkipped = 0;
let totalWritten = 0;

const STROKE_WIDTH = "0.5";
const STROKE = "#fff";
const FILL = "#fff";

function patchRootSvg(svg) {
  const openMatch = svg.match(/<svg\b([^>]*)>/);

  if (!openMatch) return { svg, changed: false };

  let attrs = openMatch[1];
  let changed = false;

  // stroke-width: normalize to STROKE_WIDTH (replace if present, else append).
  if (/\bstroke-width="[^"]*"/.test(attrs)) {
    const replaced = attrs.replace(/\bstroke-width="[^"]*"/, `stroke-width="${STROKE_WIDTH}"`);

    if (replaced !== attrs) {
      attrs = replaced;
      changed = true;
    }
  } else {
    attrs = `${attrs} stroke-width="${STROKE_WIDTH}"`;
    changed = true;
  }

  // stroke: add only when absent (author-set colors win).
  if (!/\bstroke="/.test(attrs)) {
    attrs = `${attrs} stroke="${STROKE}"`;
    changed = true;
  }

  // fill: add only when absent.
  if (!/\bfill="/.test(attrs)) {
    attrs = `${attrs} fill="${FILL}"`;
    changed = true;
  }

  if (!changed) return { svg, changed: false };

  return { svg: svg.replace(openMatch[0], `<svg${attrs}>`), changed: true };
}

function patchTextElements(svg) {
  let changed = false;
  const next = svg.replace(/<text\b([^>]*)>/g, (match, attrs) => {
    if (/\bstroke=/.test(attrs)) return match;

    changed = true;

    return `<text${attrs} stroke="none">`;
  });

  return { svg: next, changed };
}

/**
 * Adds stroke="none" to drawable elements that have an explicit fill= but
 * no stroke=. These elements would otherwise inherit the root stroke and
 * render path-data artifacts (h0, redundant control points) as visible dots.
 */
function patchFilledElements(svg) {
  const drawable = "(?:path|rect|circle|ellipse|polygon|polyline|line)";
  const re = new RegExp(`<${drawable}\\b([^/>]*)(/?)>`, "g");

  let changed = false;
  const next = svg.replace(re, (match, attrs, selfClose) => {
    if (/\bstroke=/.test(attrs)) return match;
    if (!/\bfill=/.test(attrs)) return match;

    changed = true;

    const tagName = match.match(/<(\w+)/)[1];
    const trimmed = attrs.replace(/\s+$/, "");

    return `<${tagName}${trimmed} stroke="none"${selfClose ? "/" : ""}>`;
  });

  return { svg: next, changed };
}

function processIcon(filePath) {
  const svg = fs.readFileSync(filePath, "utf-8");
  const relPath = path.relative(ICONS_DIR, filePath).replace(/\\/g, "/");

  const rootResult = patchRootSvg(svg);
  const textResult = patchTextElements(rootResult.svg);
  const filledResult = patchFilledElements(textResult.svg);

  if (!rootResult.changed && !textResult.changed && !filledResult.changed) {
    totalSkipped++;
    return;
  }

  totalProcessed++;

  if (dryRun) {
    const tags = [
      rootResult.changed && "root",
      textResult.changed && "text",
      filledResult.changed && "filled",
    ]
      .filter(Boolean)
      .join("+");

    console.log(`  ${relPath} (${tags})`);
    totalWritten++;
    return;
  }

  fs.writeFileSync(filePath, filledResult.svg, "utf-8");
  totalWritten++;
}

function walkDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walkDir(fullPath);
    } else if (entry.name.endsWith(".svg")) {
      processIcon(fullPath);
    }
  }
}

console.log(`${dryRun ? "[DRY RUN] " : ""}Adding editor defaults to icons in ${ICONS_DIR}`);

walkDir(ICONS_DIR);

console.log();
console.log(`Processed: ${totalProcessed}`);
console.log(`Written:   ${totalWritten}`);
console.log(`Skipped:   ${totalSkipped}`);
