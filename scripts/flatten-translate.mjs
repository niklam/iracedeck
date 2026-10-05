#!/usr/bin/env node
/**
 * Flattens translate(0, -8) transforms in SVG files by applying the offset
 * directly to path coordinates using the svgpath library.
 */
import fs from "node:fs";
import SvgPath from "svgpath";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log("Usage: node scripts/flatten-translate.mjs <svg-files...>");
  process.exit(1);
}

for (const file of files) {
  const svg = fs.readFileSync(file, "utf-8");

  // Extract the translate values
  const gMatch = svg.match(/<g\s+transform="translate\(([^,)]+),\s*([^)]+)\)">/);
  if (!gMatch) {
    console.log(`${file}: no translate group found, skipping`);
    continue;
  }

  const tx = parseFloat(gMatch[1]);
  const ty = parseFloat(gMatch[2]);
  console.log(`${file}: flattening translate(${tx}, ${ty})`);

  let result = svg;

  // Apply translate to all path d attributes
  result = result.replace(/(<path[^>]*\sd=")([^"]+)(")/g, (match, pre, d, post) => {
    const transformed = new SvgPath(d).translate(tx, ty).round(2).toString();
    return pre + transformed + post;
  });

  // Apply translate to polygon points
  result = result.replace(/(<polygon[^>]*\spoints=")([^"]+)(")/g, (match, pre, points, post) => {
    const transformed = points
      .split(/\s+/)
      .map((pair) => {
        const [x, y] = pair.split(",").map(Number);
        return `${Math.round((x + tx) * 100) / 100},${Math.round((y + ty) * 100) / 100}`;
      })
      .join(" ");
    return pre + transformed + post;
  });

  // Remove the <g transform="translate(...)"> and its closing </g>
  result = result.replace(/\s*<g\s+transform="translate\([^)]+\)">\n?/, "\n");
  result = result.replace(/\s*<\/g>\n(\n<\/svg>)/, "\n$1");

  fs.writeFileSync(file, result, "utf-8");
  console.log(`  written`);
}
