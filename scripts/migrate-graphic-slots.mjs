#!/usr/bin/env node

/**
 * Graphic Slot Migration Script
 *
 * Adds {{graphic1Color}} placeholders to icon SVGs for white artwork elements.
 * Skips categories/icons where white artwork is semantic and should stay fixed.
 *
 * Usage: node scripts/migrate-graphic-slots.mjs [--dry-run]
 */

import fs from "node:fs";
import path from "node:path";

const ICONS_DIR = path.resolve("packages/icons");
const DRY_RUN = process.argv.includes("--dry-run");

// Categories where ALL white artwork should stay fixed (complex inner graphics)
const SKIP_CATEGORIES = new Set([
  "black-box-selector", // inner data text, frames, values
]);

// Specific icons where white artwork should stay fixed
const SKIP_ICONS = new Set([
  "car-control/starter.svg",      // red START button has white "START" text
  "car-control/ignition.svg",     // key icon artwork is semantic
]);

let totalModified = 0;
let totalSkipped = 0;

function processIcon(filePath) {
  let svg = fs.readFileSync(filePath, "utf-8");
  const relPath = path.relative(ICONS_DIR, filePath).replace(/\\/g, "/");
  const category = relPath.split("/")[0];

  // Skip if no <desc> (not migrated)
  if (!svg.includes("<desc>")) {
    return;
  }

  // Skip excluded categories
  if (SKIP_CATEGORIES.has(category)) {
    totalSkipped++;
    return;
  }

  // Skip excluded individual icons
  if (SKIP_ICONS.has(relPath)) {
    totalSkipped++;
    console.log(`  SKIP (excluded): ${relPath}`);
    return;
  }

  // Find white artwork elements (not inside label text)
  // Match fill="#ffffff" or fill="#fff" or stroke="#ffffff" or stroke="#fff"
  // But NOT in text elements containing {{mainLabel}} or {{subLabel}}
  const hasWhiteFill = /fill="#(?:ffffff|fff)"/.test(svg);
  const hasWhiteStroke = /stroke="#(?:ffffff|fff)"/.test(svg);

  if (!hasWhiteFill && !hasWhiteStroke) {
    return; // No white artwork to convert
  }

  // Parse current <desc> colors
  const descMatch = svg.match(/<desc>(.*?)<\/desc>/s);
  if (!descMatch) return;

  let descData;
  try {
    descData = JSON.parse(descMatch[1]);
  } catch {
    return;
  }

  // Already has graphic1Color
  if (descData.colors?.graphic1Color) {
    return;
  }

  // Add graphic1Color to <desc>
  descData.colors.graphic1Color = "#ffffff";
  const newDesc = `<desc>${JSON.stringify(descData)}</desc>`;
  svg = svg.replace(/<desc>.*?<\/desc>/s, newDesc);

  // Replace white fills in non-label elements
  // Strategy: replace all #ffffff/#fff fills and strokes, then restore label text fills to {{textColor}}
  // (labels already use {{textColor}} from the previous migration, so we just need to handle artwork)

  // Replace fill="#ffffff" and fill="#fff" that are NOT in textColor positions
  // Since labels already use {{textColor}}, any remaining fill="#ffffff" is artwork
  svg = svg.replace(/fill="#(?:ffffff|fff)"/gi, 'fill="{{graphic1Color}}"');
  svg = svg.replace(/stroke="#(?:ffffff|fff)"/gi, 'stroke="{{graphic1Color}}"');

  if (!DRY_RUN) {
    fs.writeFileSync(filePath, svg, "utf-8");
  }

  totalModified++;
  console.log(`  ${DRY_RUN ? "WOULD MODIFY" : "MODIFIED"}: ${relPath}`);
}

function walkDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "preview" && entry.name !== "node_modules" && entry.name !== "src") {
      walkDir(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".svg")) {
      processIcon(fullPath);
    }
  }
}

console.log(`\nMigrating graphic slots${DRY_RUN ? " (DRY RUN)" : ""}...\n`);
walkDir(ICONS_DIR);

console.log(`\nModified: ${totalModified}`);
console.log(`Skipped: ${totalSkipped}`);
