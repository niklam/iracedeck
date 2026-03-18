#!/usr/bin/env node

/**
 * Icon Preview Generator
 *
 * Generates preview SVGs by rendering Mustache templates with their <desc> default colors.
 * Previews are placed in packages/icons/preview/ mirroring the source directory structure.
 *
 * Usage: node scripts/generate-icon-previews.mjs
 */

import fs from "node:fs";
import path from "node:path";

const ICONS_DIR = path.resolve("packages/icons");
const PREVIEW_DIR = path.join(ICONS_DIR, "preview");

let totalGenerated = 0;
let totalSkipped = 0;

function parseDesc(svg) {
  const match = svg.match(/<desc>(.*?)<\/desc>/s);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed.colors ?? null;
  } catch {
    return null;
  }
}

function renderTemplate(svg, values) {
  let result = svg;
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return result;
}

function processIcon(filePath) {
  const svg = fs.readFileSync(filePath, "utf-8");
  const relPath = path.relative(ICONS_DIR, filePath);
  const colors = parseDesc(svg);

  if (!colors) {
    totalSkipped++;
    return;
  }

  // Render template with default colors (leave non-color placeholders as-is)
  const preview = renderTemplate(svg, colors);

  // Write to preview directory
  const previewPath = path.join(PREVIEW_DIR, relPath);
  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  fs.writeFileSync(previewPath, preview, "utf-8");

  totalGenerated++;
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

// Clean preview dir
if (fs.existsSync(PREVIEW_DIR)) {
  fs.rmSync(PREVIEW_DIR, { recursive: true });
}

console.log(`Generating icon previews...\n`);
walkDir(ICONS_DIR);

console.log(`\nGenerated: ${totalGenerated}`);
console.log(`Skipped (no <desc>): ${totalSkipped}`);
console.log(`Output: ${PREVIEW_DIR}`);
