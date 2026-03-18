#!/usr/bin/env node

/**
 * Icon Migration Script
 *
 * Converts standalone 144x144 SVGs to use Mustache color placeholders:
 * 1. Adds <desc> JSON metadata with color defaults
 * 2. Replaces background rect fill with {{backgroundColor}}
 * 3. Replaces label text fills with {{textColor}}
 * 4. Removes rx from background rects
 * 5. Reports icons with white artwork for manual graphic slot classification
 *
 * Usage: node scripts/migrate-icons.mjs [--dry-run]
 */

import fs from "node:fs";
import path from "node:path";

const ICONS_DIR = path.resolve("packages/icons");
const DRY_RUN = process.argv.includes("--dry-run");

// Semantic colors that should never be replaced
const SEMANTIC_COLORS = new Set([
  "#2ecc71", "#e74c3c", "#f1c40f", "#f39c12", "#3498db",
  "#9b59b6", "#c0392b", "#888888", "#2d2510", "#4a3728",
]);

let totalProcessed = 0;
let totalModified = 0;
const manualReview = [];

function processIcon(filePath) {
  let svg = fs.readFileSync(filePath, "utf-8");
  const relPath = path.relative(ICONS_DIR, filePath);

  // Skip if already migrated
  if (svg.includes("<desc>")) {
    console.log(`  SKIP (already migrated): ${relPath}`);
    return;
  }

  totalProcessed++;

  const colors = {};

  // 1. Find and replace background rect fill
  // Background rect: first rect with full dimensions (144x144)
  const bgRectPattern = /(<rect[^>]*width="144"[^>]*height="144"[^>]*)fill="(#[0-9a-fA-F]{6})"([^>]*?)\s*\/>/;
  const bgMatch = svg.match(bgRectPattern);
  if (bgMatch) {
    colors.backgroundColor = bgMatch[2];
    // Replace fill and remove rx
    svg = svg.replace(bgRectPattern, (match, before, fillColor, after) => {
      let result = `${before}fill="{{backgroundColor}}"${after}/>`;
      // Remove rx="16" or rx="8" from background rect
      result = result.replace(/\s*rx="(?:16|8)"/, "");
      return result;
    });
  }

  // 2. Find and replace label text fills
  // Labels are text elements containing {{mainLabel}} or {{subLabel}}
  const labelPattern = /(<text[^>]*)fill="(#[0-9a-fA-F]{3,6})"([^>]*>{{(?:mainLabel|subLabel)}})/g;
  let labelMatch;
  while ((labelMatch = labelPattern.exec(svg)) !== null) {
    if (!colors.textColor) {
      colors.textColor = labelMatch[2];
    }
  }
  if (colors.textColor) {
    svg = svg.replace(
      /(<text[^>]*)fill="#[0-9a-fA-F]{3,6}"([^>]*>{{(?:mainLabel|subLabel)}})/g,
      '$1fill="{{textColor}}"$2',
    );
  }

  // 3. Check for white artwork elements (potential graphic slots)
  // Find non-label elements with fill="#ffffff" or stroke="#ffffff"
  const whiteArtwork = [];
  const artworkFillPattern = /fill="(#ffffff|#fff)"(?![^>]*>{{(?:mainLabel|subLabel)}})/gi;
  const artworkStrokePattern = /stroke="(#ffffff|#fff)"/gi;

  let artFillMatch;
  while ((artFillMatch = artworkFillPattern.exec(svg)) !== null) {
    // Check if this is inside a text element with a label placeholder
    const context = svg.substring(Math.max(0, artFillMatch.index - 200), artFillMatch.index + 100);
    if (!context.includes("{{mainLabel}}") && !context.includes("{{subLabel}}")) {
      whiteArtwork.push(`fill=${artFillMatch[1]}`);
    }
  }
  let artStrokeMatch;
  while ((artStrokeMatch = artworkStrokePattern.exec(svg)) !== null) {
    whiteArtwork.push(`stroke=${artStrokeMatch[1]}`);
  }

  if (whiteArtwork.length > 0) {
    manualReview.push({ file: relPath, elements: whiteArtwork });
  }

  // 4. Add <desc> metadata
  if (Object.keys(colors).length > 0) {
    const desc = `<desc>${JSON.stringify({ colors })}</desc>`;
    // Insert after opening <svg> tag
    svg = svg.replace(/<svg([^>]*)>/, `<svg$1>\n  ${desc}`);
  }

  if (!DRY_RUN) {
    fs.writeFileSync(filePath, svg, "utf-8");
  }

  totalModified++;
  console.log(`  ${DRY_RUN ? "WOULD MODIFY" : "MODIFIED"}: ${relPath} (${Object.keys(colors).join(", ")})`);
}

function walkDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "preview" && entry.name !== "node_modules") {
      walkDir(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".svg")) {
      processIcon(fullPath);
    }
  }
}

console.log(`\nMigrating icons in ${ICONS_DIR}${DRY_RUN ? " (DRY RUN)" : ""}...\n`);
walkDir(ICONS_DIR);

console.log(`\n--- Summary ---`);
console.log(`Processed: ${totalProcessed}`);
console.log(`Modified: ${totalModified}`);

if (manualReview.length > 0) {
  console.log(`\n--- Icons with white artwork (potential graphic slots) ---`);
  console.log(`These icons have white fill/stroke elements that could become {{graphic1Color}}.`);
  console.log(`Review manually to determine if they should be customizable:\n`);
  for (const { file, elements } of manualReview) {
    console.log(`  ${file}: ${elements.join(", ")}`);
  }
}

console.log(`\nDone.`);
