#!/usr/bin/env node

/**
 * Icon viewBox Trimmer (one-off migration for issue #373)
 *
 * Reads the `artworkBounds` declared in each icon's `<desc>` JSON, shifts every
 * coordinate in the artwork by `-(bounds.x, bounds.y)`, replaces the outer
 * `viewBox="0 0 144 144"` with `viewBox="0 0 bounds.width bounds.height"`, and
 * drops the `artworkBounds` field from `<desc>`.
 *
 * After this migration runs successfully, the `<desc>` no longer carries
 * artworkBounds, the viewBox dimensions ARE the artwork extent, and downstream
 * scaling math reads them directly from the SVG root.
 *
 * Usage:
 *   node scripts/migrate-icons-to-trimmed-viewbox.mjs            # Apply
 *   node scripts/migrate-icons-to-trimmed-viewbox.mjs --dry-run  # Preview
 */

import fs from "node:fs";
import path from "node:path";

const ICONS_DIR = path.resolve("packages/icons");
const SKIP_DIRS = new Set(["preview", "node_modules", "src", "dist"]);
// Icons that mix dynamic action-rendered content (in old 144-coord space) on
// top of the static artwork — migrating their viewBox would silently misplace
// the dynamic content. Action code that owns these icons supplies its own
// bounds explicitly.
const SKIP_FILES = new Set([
  // tire-service overlays four tire rects in old 144-coord space
  path.join("tire-service", "toggle-tires.svg").replace(/\\/g, "/"),
]);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

let totalProcessed = 0;
let totalSkipped = 0;
let totalWritten = 0;
let totalErrors = 0;

// Matches SVG numbers including leading-decimal ("0.5", ".5", "-.5") and scientific notation
const NUM_RE_SRC = "-?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?";

/**
 * Apply a coordinate shift function to all numeric coordinates inside an
 * SVG content string. The shift function receives the coordinate role
 * (`"x"` or `"y"`) and the original value.
 */
function shiftCoordinates(content, shiftX, shiftY) {
  let out = content;

  // Simple attribute-based coordinates: x, y, x1, y1, x2, y2, cx, cy
  const xAttrRe = new RegExp(`\\b(x|x1|x2|cx)="(${NUM_RE_SRC})"`, "g");
  const yAttrRe = new RegExp(`\\b(y|y1|y2|cy)="(${NUM_RE_SRC})"`, "g");

  out = out.replace(xAttrRe, (_, name, val) => `${name}="${num(parseFloat(val) + shiftX)}"`);
  out = out.replace(yAttrRe, (_, name, val) => `${name}="${num(parseFloat(val) + shiftY)}"`);

  // Path d attributes
  out = out.replace(/\bd="([^"]+)"/g, (_, dval) => `d="${shiftPathData(dval, shiftX, shiftY)}"`);

  // Polygon/polyline points
  out = out.replace(/\bpoints="([^"]+)"/g, (_, pts) => `points="${shiftPoints(pts, shiftX, shiftY)}"`);

  // Transforms — translate(tx, ty) shifts by (shiftX, shiftY); rotate(a, cx, cy) shifts the center
  out = out.replace(/\btransform="([^"]+)"/g, (_, tval) => `transform="${shiftTransform(tval, shiftX, shiftY)}"`);

  return out;
}

/**
 * Format a number cleanly: integers stay integers, floats keep up to 4
 * decimal places trimmed of trailing zeros. Avoids artifacts like "8.000000001".
 */
function num(v) {
  if (Number.isInteger(v)) return String(v);

  const s = v.toFixed(4);

  return s.replace(/\.?0+$/, "");
}

function shiftPoints(pointsStr, sx, sy) {
  const tokens = pointsStr.trim().split(/[\s,]+/).map(Number);

  if (tokens.length % 2 !== 0) return pointsStr;

  const out = [];

  for (let i = 0; i < tokens.length; i += 2) {
    out.push(`${num(tokens[i] + sx)},${num(tokens[i + 1] + sy)}`);
  }

  return out.join(" ");
}

/**
 * Shift coordinates in path data. Only the first `M`/`m` and absolute commands
 * (M, L, H, V, C, S, Q, T, A) shift; relative commands carry deltas that need
 * no shifting. Lowercase `m` is special: only the FIRST coordinate pair is a
 * move-to (absolute when it starts the path); subsequent pairs in `m` are
 * relative line-to.
 *
 * The path tokenizer is the same as scripts/generate-artwork-bounds.mjs.
 */
function shiftPathData(d, sx, sy) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g) || [];
  const out = [];

  for (const token of tokens) {
    const cmd = token[0];
    const rest = token.slice(1).trim();
    // Match numbers including leading-decimal forms (".8", "-.5") used by tight SVG path data
    const nums = rest.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
    const values = nums.map(Number);

    switch (cmd) {
      case "M":
      case "L":
      case "T": {
        // pairs of (x, y), all absolute
        for (let i = 0; i + 1 < values.length; i += 2) {
          values[i] += sx;
          values[i + 1] += sy;
        }
        break;
      }
      case "H": {
        for (let i = 0; i < values.length; i++) values[i] += sx;
        break;
      }
      case "V": {
        for (let i = 0; i < values.length; i++) values[i] += sy;
        break;
      }
      case "C": {
        // (x1,y1, x2,y2, x,y) absolute
        for (let i = 0; i + 5 < values.length; i += 6) {
          values[i] += sx;
          values[i + 1] += sy;
          values[i + 2] += sx;
          values[i + 3] += sy;
          values[i + 4] += sx;
          values[i + 5] += sy;
        }
        break;
      }
      case "S":
      case "Q": {
        // (x1,y1, x,y) absolute
        for (let i = 0; i + 3 < values.length; i += 4) {
          values[i] += sx;
          values[i + 1] += sy;
          values[i + 2] += sx;
          values[i + 3] += sy;
        }
        break;
      }
      case "A": {
        // (rx ry x-axis-rotation large-arc-flag sweep-flag x y) — only x,y are absolute coords
        for (let i = 0; i + 6 < values.length; i += 7) {
          values[i + 5] += sx;
          values[i + 6] += sy;
        }
        break;
      }
      case "m": {
        // First pair is the implicit move (treat as absolute when it starts the path).
        // For paths starting with `m`, the spec says the first pair is treated as
        // absolute. Subsequent pairs are relative line-to deltas (no shift needed).
        if (values.length >= 2 && out.length === 0) {
          values[0] += sx;
          values[1] += sy;
        }
        break;
      }
      // Relative commands (l, h, v, c, s, q, t, a) carry deltas — no shifting.
      // Z/z close path — no coords.
    }

    out.push(cmd + (values.length > 0 ? values.map(num).join(",") : ""));
  }

  return out.join("");
}

function shiftTransform(t, sx, sy) {
  // translate(tx) or translate(tx, ty) — shift the translate vector
  // Note: a translate inside an element under shifted parent coords needs the
  // translate's components shifted, since the translate is added to the parent
  // origin which has moved.
  let out = t;

  const translateXY = new RegExp(`translate\\s*\\(\\s*(${NUM_RE_SRC})\\s*[,\\s]\\s*(${NUM_RE_SRC})\\s*\\)`, "g");
  const translateX = new RegExp(`translate\\s*\\(\\s*(${NUM_RE_SRC})\\s*\\)`, "g");

  out = out.replace(translateXY, (_m, tx, ty) => {
    return `translate(${num(parseFloat(tx) + sx)},${num(parseFloat(ty) + sy)})`;
  });
  out = out.replace(translateX, (_m, tx) => {
    return `translate(${num(parseFloat(tx) + sx)},${num(sy)})`;
  });

  // rotate(angle) — no center, no shift needed
  // rotate(angle, cx, cy) — center moves with the parent, shift cx,cy
  const rotateRe = new RegExp(
    `rotate\\s*\\(\\s*(${NUM_RE_SRC}|\\{\\{[^}]+\\}\\})\\s*[,\\s]\\s*(${NUM_RE_SRC})\\s*[,\\s]\\s*(${NUM_RE_SRC})\\s*\\)`,
    "g",
  );

  out = out.replace(
    rotateRe,
    (_m, angle, cx, cy) => `rotate(${angle}, ${num(parseFloat(cx) + sx)}, ${num(parseFloat(cy) + sy)})`,
  );

  return out;
}

function processIcon(filePath) {
  const svg = fs.readFileSync(filePath, "utf-8");
  const relPath = path.relative(ICONS_DIR, filePath).replace(/\\/g, "/");

  if (SKIP_FILES.has(relPath)) {
    console.log(`  skip-special: ${relPath}`);
    totalSkipped++;
    return;
  }

  const descMatch = svg.match(/<desc>(.*?)<\/desc>/s);

  if (!descMatch) {
    totalSkipped++;
    return;
  }

  let meta;

  try {
    meta = JSON.parse(descMatch[1]);
  } catch {
    totalSkipped++;
    return;
  }

  const bounds = meta.artworkBounds;

  if (!bounds || typeof bounds.x !== "number" || typeof bounds.y !== "number" ||
      typeof bounds.width !== "number" || typeof bounds.height !== "number") {
    totalSkipped++;
    return;
  }

  totalProcessed++;

  const shiftX = -bounds.x;
  const shiftY = -bounds.y;
  const newW = bounds.width;
  const newH = bounds.height;

  // Shift only the artwork content (keep the <svg> wrapper and <desc> intact).
  const svgOpenMatch = svg.match(/<svg[^>]*>/);

  if (!svgOpenMatch) {
    console.warn(`  no-svg-tag: ${relPath}`);
    totalErrors++;
    return;
  }

  const headerEnd = svgOpenMatch.index + svgOpenMatch[0].length;
  const closingIdx = svg.lastIndexOf("</svg>");

  if (closingIdx < 0) {
    console.warn(`  no-svg-close: ${relPath}`);
    totalErrors++;
    return;
  }

  const head = svg.slice(0, headerEnd);
  const body = svg.slice(headerEnd, closingIdx);
  const tail = svg.slice(closingIdx);

  // Drop <desc> from body before shifting (it has its own coordinate-free JSON).
  const bodyNoDesc = body.replace(/<desc>.*?<\/desc>/s, "");
  const shiftedBody = shiftCoordinates(bodyNoDesc, shiftX, shiftY);

  // Update viewBox in head (replace any viewBox value, not just the 144x144 case).
  const newHead = svgOpenMatch[0].replace(/viewBox="[^"]*"/, `viewBox="0 0 ${num(newW)} ${num(newH)}"`);

  // Rebuild <desc> without artworkBounds.
  const { artworkBounds: _drop, ...metaWithoutBounds } = meta;
  void _drop;
  const newDesc = `<desc>${JSON.stringify(metaWithoutBounds)}</desc>`;

  const newSvg = head.replace(svgOpenMatch[0], newHead) + "\n  " + newDesc + shiftedBody + tail;

  if (dryRun) {
    console.log(`  ${relPath}: viewBox 0 0 144 144 → 0 0 ${num(newW)} ${num(newH)} (shift ${shiftX},${shiftY})`);
    totalWritten++;
    return;
  }

  fs.writeFileSync(filePath, newSvg, "utf-8");
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

console.log(`${dryRun ? "[DRY RUN] " : ""}Trimming icon viewBoxes in ${ICONS_DIR}`);

walkDir(ICONS_DIR);

console.log();
console.log(`Processed: ${totalProcessed}`);
console.log(`Written:   ${totalWritten}`);
console.log(`Skipped:   ${totalSkipped}`);
if (totalErrors > 0) console.log(`Errors:    ${totalErrors}`);
