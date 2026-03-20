#!/usr/bin/env node

/**
 * Generates color-defaults.json for PI templates.
 *
 * Scans icon SVGs for <desc> color metadata and creates a JSON file
 * keyed by action category with the default color values.
 *
 * Usage: node scripts/generate-color-defaults.mjs
 */

import fs from "node:fs";
import path from "node:path";

const ICONS_DIR = path.resolve("packages/icons");
const OUTPUT_FILE = path.resolve("packages/stream-deck-plugin/src/pi/data/color-defaults.json");

const defaults = {};

for (const entry of fs.readdirSync(ICONS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "preview" || entry.name === "node_modules" || entry.name === "src") {
    continue;
  }

  const category = entry.name;
  const categoryDir = path.join(ICONS_DIR, category);
  const svgFiles = fs.readdirSync(categoryDir).filter((f) => f.endsWith(".svg"));

  if (svgFiles.length === 0) continue;

  // Read the first SVG to get defaults (all icons in a category share the same defaults)
  const svg = fs.readFileSync(path.join(categoryDir, svgFiles[0]), "utf-8");
  const descMatch = svg.match(/<desc>(.*?)<\/desc>/s);

  if (!descMatch) continue;

  try {
    const parsed = JSON.parse(descMatch[1]);

    if (parsed.colors) {
      defaults[category] = parsed.colors;
    }
  } catch {
    // skip
  }
}

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(defaults, null, 2) + "\n", "utf-8");

console.log(`Generated ${OUTPUT_FILE}`);
console.log(`Categories: ${Object.keys(defaults).length}`);
