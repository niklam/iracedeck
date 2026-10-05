#!/usr/bin/env node
/**
 * Generates icon-defaults.json for PI templates.
 *
 * Scans icon SVGs for <desc> metadata and creates a JSON file
 * keyed by action category with color and border default values.
 *
 * Usage: node scripts/generate-icon-defaults.mjs
 */
import fs from "node:fs";
import path from "node:path";

const ICONS_DIR = path.resolve("packages/icons");
const DYNAMIC_ICONS_DIR = path.resolve("packages/iracing-actions/icons");
const OUTPUT_FILE = path.resolve("packages/iracing-actions/src/actions/data/icon-defaults.json");

const defaults = {};

function extractDefaults(svgPath) {
  const svg = fs.readFileSync(svgPath, "utf-8");
  const descMatch = svg.match(/<desc>(.*?)<\/desc>/s);

  if (!descMatch) return null;

  try {
    const parsed = JSON.parse(descMatch[1]);
    const result = {};

    if (parsed.colors) {
      Object.assign(result, parsed.colors);
    }

    if (parsed.border?.color) {
      result.borderColor = parsed.border.color;
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

// Scan packages/icons/ (static graphic snippets, one category per directory)
for (const entry of fs.readdirSync(ICONS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "preview" || entry.name === "node_modules" || entry.name === "src") {
    continue;
  }

  const category = entry.name;
  const categoryDir = path.join(ICONS_DIR, category);
  const svgFiles = fs.readdirSync(categoryDir).filter((f) => f.endsWith(".svg"));

  if (svgFiles.length === 0) continue;

  const result = extractDefaults(path.join(categoryDir, svgFiles[0]));

  if (result) {
    defaults[category] = result;
  }
}

// Scan packages/iracing-actions/icons/ (dynamic templates, named by action)
if (fs.existsSync(DYNAMIC_ICONS_DIR)) {
  for (const file of fs.readdirSync(DYNAMIC_ICONS_DIR).filter((f) => f.endsWith(".svg"))) {
    const actionName = file.replace(".svg", "");

    // Skip if already covered by a static icon category
    if (defaults[actionName]) continue;

    const result = extractDefaults(path.join(DYNAMIC_ICONS_DIR, file));

    if (result) {
      defaults[actionName] = result;
    }
  }
}

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(defaults, null, 2) + "\n", "utf-8");

console.log(`Generated ${OUTPUT_FILE}`);
console.log(`Categories: ${Object.keys(defaults).length}`);
