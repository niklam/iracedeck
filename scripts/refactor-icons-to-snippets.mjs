#!/usr/bin/env node
/**
 * Converts icon SVGs from self-contained files to graphic snippets.
 *
 * For each SVG in packages/icons/ that contains {{mainLabel}} or {{subLabel}}:
 * 1. Removes the background <rect> with {{backgroundColor}}
 * 2. Removes {{mainLabel}} and {{subLabel}} <text> elements
 * 3. Removes the <g filter="url(#activity-state)"> wrapper (keeps inner content)
 * 4. Removes <defs> containing the activity-state filter
 * 5. Keeps: the <svg> wrapper, <desc> metadata, and all graphic artwork
 *
 * Skips files that don't have {{mainLabel}}/{{subLabel}} (not label icons).
 * Skips the preview/ directory.
 *
 * Usage:
 *   node scripts/refactor-icons-to-snippets.mjs --dry-run   # preview only
 *   node scripts/refactor-icons-to-snippets.mjs              # apply changes
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, relative } from "path";

const ROOT = join(import.meta.dirname, "..");
const ICONS_DIR = join(ROOT, "packages", "icons");

const isDryRun = process.argv.includes("--dry-run");

let processed = 0;
let skipped = 0;
let total = 0;

function processDirectory(dir) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      // Skip the preview directory
      if (entry === "preview") continue;
      processDirectory(fullPath);
    } else if (entry.endsWith(".svg")) {
      processSvg(fullPath);
    }
  }
}

function processSvg(filePath) {
  total++;
  const content = readFileSync(filePath, "utf-8");

  // Only process files that have label placeholders
  if (!content.includes("{{mainLabel}}") && !content.includes("{{subLabel}}")) {
    skipped++;
    return;
  }

  const result = transformSvg(content);
  const relPath = relative(ICONS_DIR, filePath);

  if (result === content) {
    console.log(`UNCHANGED: ${relPath}`);
    skipped++;
    return;
  }

  if (isDryRun) {
    console.log(`DRY-RUN: Would update ${relPath}`);
    console.log("--- BEFORE (first 300 chars) ---");
    console.log(content.substring(0, 300));
    console.log("--- AFTER (first 300 chars) ---");
    console.log(result.substring(0, 300));
    console.log("---");
  } else {
    writeFileSync(filePath, result);
    console.log(`Updated: ${relPath}`);
  }
  processed++;
}

/**
 * Transforms an SVG from self-contained to graphic snippet.
 *
 * Removes:
 * - background <rect x="0" y="0" width="144" height="144" fill="{{backgroundColor}}"/>
 * - <text> elements containing {{mainLabel}} or {{subLabel}}
 * - <g filter="url(#activity-state)"> wrapper (keeps children, removes the wrapping g)
 * - <defs> blocks containing activity-state filter
 * - Trailing HTML comments (<!-- ... -->) that are on their own line
 * - Extra blank lines (collapse to at most one)
 *
 * Keeps: svg element, desc element, all graphic artwork
 */
function transformSvg(content) {
  let result = content;

  // 1. Remove background rect with {{backgroundColor}}
  result = result.replace(/[ \t]*<rect[^>]*fill="{{backgroundColor}}"[^/]*(\/?>|>.*?<\/rect>)\n?/gs, "");

  // 2. Remove <text> elements containing {{mainLabel}} or {{subLabel}}
  // Handle both single-line and multi-line text elements
  result = result.replace(/[ \t]*<text[^>]*>{{mainLabel}}<\/text>\n?/g, "");
  result = result.replace(/[ \t]*<text[^>]*>{{subLabel}}<\/text>\n?/g, "");
  // Multi-line text elements (where attributes span multiple lines)
  result = result.replace(/[ \t]*<text[\s\S]*?>\s*{{mainLabel}}\s*<\/text>\n?/g, "");
  result = result.replace(/[ \t]*<text[\s\S]*?>\s*{{subLabel}}\s*<\/text>\n?/g, "");

  // 3. Remove <g filter="url(#activity-state)"> opening tag
  result = result.replace(/[ \t]*<g filter="url\(#activity-state\)">\n?/g, "");

  // 4. Remove the matching closing </g> at the end (last one before </svg>)
  // This removes the closing tag of the activity-state wrapper group
  result = result.replace(/[ \t]*<\/g>\s*(<\/svg>)/g, "\n$1");

  // 5. Remove <defs> containing activity-state filter
  result = result.replace(/[ \t]*<defs>[\s\S]*?<\/defs>\n?/g, "");

  // 6. Remove HTML comments that are on their own line
  result = result.replace(/[ \t]*<!--[^-][\s\S]*?-->\n?/g, "");

  // 7. Collapse multiple consecutive blank lines into one
  result = result.replace(/\n{3,}/g, "\n\n");

  // 8. Ensure clean ending (single newline after </svg>)
  result = result.trimEnd() + "\n";

  return result;
}

processDirectory(ICONS_DIR);

if (isDryRun) {
  console.log(`\nDRY-RUN complete. Would update ${processed} of ${total} files (${skipped} skipped).`);
} else {
  console.log(`\nDone. Updated ${processed} of ${total} files (${skipped} skipped/unchanged).`);
}
