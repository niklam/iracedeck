#!/usr/bin/env node
/**
 * Injects default title metadata into icon SVG <desc> JSON.
 *
 * Reads icon-title-defaults.json and for each entry injects a "title" field
 * into the <desc> metadata of the corresponding SVG file.
 *
 * Format of icon-title-defaults.json:
 *   { "icon-dir/icon-name": "subLabel\nmainLabel" }
 *
 * The combined text is subLabel\nmainLabel (visual order: context on top, action word on bottom).
 *
 * Usage:
 *   node scripts/add-title-metadata-to-icons.mjs
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ICONS_DIR = join(import.meta.dirname, "..", "packages", "icons");
const titles = JSON.parse(readFileSync(join(import.meta.dirname, "data", "icon-title-defaults.json"), "utf-8"));

let updated = 0;
let notFound = 0;
let failed = 0;

for (const [iconPath, titleText] of Object.entries(titles)) {
  const svgPath = join(ICONS_DIR, iconPath + ".svg");
  let content;
  try {
    content = readFileSync(svgPath, "utf-8");
  } catch {
    console.warn(`Not found: ${svgPath}`);
    notFound++;
    continue;
  }

  const descMatch = content.match(/<desc>([\s\S]*?)<\/desc>/);
  if (!descMatch) {
    console.warn(`No <desc> in: ${iconPath}.svg`);
    failed++;
    continue;
  }

  try {
    const meta = JSON.parse(descMatch[1]);
    meta.title = { text: titleText };
    const newDesc = `<desc>${JSON.stringify(meta)}</desc>`;
    content = content.replace(/<desc>[\s\S]*?<\/desc>/, newDesc);
    writeFileSync(svgPath, content);
    console.log(`Updated: ${iconPath}.svg`);
    updated++;
  } catch (e) {
    console.warn(`Failed to parse <desc> in: ${iconPath}.svg — ${e.message}`);
    failed++;
  }
}

console.log(`\nDone. Updated ${updated} icons. Not found: ${notFound}. Failed: ${failed}.`);
