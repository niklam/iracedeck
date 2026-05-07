#!/usr/bin/env node

/**
 * Icon Bounds Checker
 *
 * Computes the bounding box of each icon's drawable content and compares it
 * to the declared viewBox. Reports any icon whose artwork extends past the
 * viewBox edges or whose viewBox has unused empty space.
 *
 * Usage:
 *   node scripts/check-icon-bounds.mjs <dir-or-file> [<dir-or-file> ...]
 */

import fs from "node:fs";
import path from "node:path";

const TOLERANCE = 0.5; // pixels — accept sub-pixel rounding

const targets = process.argv.slice(2);

if (targets.length === 0) {
  console.error("Usage: node scripts/check-icon-bounds.mjs <path> [...]");
  process.exit(1);
}

function parsePoints(attrs) {
  const m = attrs.match(/points="([^"]+)"/);
  if (!m) return [];
  const nums = m[1].trim().split(/[\s,]+/).map(Number);
  const out = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push({ x: nums[i], y: nums[i + 1] });
  return out;
}

function num(attrs, name, fallback = 0) {
  const m = attrs.match(new RegExp(`\\b${name}="([-+\\d.eE]+)"`));
  return m ? parseFloat(m[1]) : fallback;
}

function parsePath(d) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g) || [];
  let curX = 0, curY = 0, startX = 0, startY = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let any = false;

  function update(x, y) {
    any = true;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  for (const tok of tokens) {
    const cmd = tok[0];
    const nums = (tok.slice(1).match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);
    switch (cmd) {
      case "M":
        for (let i = 0; i + 1 < nums.length; i += 2) {
          curX = nums[i]; curY = nums[i + 1];
          if (i === 0) { startX = curX; startY = curY; }
          update(curX, curY);
        }
        break;
      case "m":
        for (let i = 0; i + 1 < nums.length; i += 2) {
          curX += nums[i]; curY += nums[i + 1];
          if (i === 0) { startX = curX; startY = curY; }
          update(curX, curY);
        }
        break;
      case "L":
        for (let i = 0; i + 1 < nums.length; i += 2) { curX = nums[i]; curY = nums[i + 1]; update(curX, curY); }
        break;
      case "l":
        for (let i = 0; i + 1 < nums.length; i += 2) { curX += nums[i]; curY += nums[i + 1]; update(curX, curY); }
        break;
      case "H": for (const v of nums) { curX = v; update(curX, curY); } break;
      case "h": for (const v of nums) { curX += v; update(curX, curY); } break;
      case "V": for (const v of nums) { curY = v; update(curX, curY); } break;
      case "v": for (const v of nums) { curY += v; update(curX, curY); } break;
      case "C":
        for (let i = 0; i + 5 < nums.length; i += 6) {
          update(nums[i], nums[i + 1]); update(nums[i + 2], nums[i + 3]);
          curX = nums[i + 4]; curY = nums[i + 5]; update(curX, curY);
        }
        break;
      case "c":
        for (let i = 0; i + 5 < nums.length; i += 6) {
          update(curX + nums[i], curY + nums[i + 1]); update(curX + nums[i + 2], curY + nums[i + 3]);
          curX += nums[i + 4]; curY += nums[i + 5]; update(curX, curY);
        }
        break;
      case "S": case "Q":
        for (let i = 0; i + 3 < nums.length; i += 4) {
          update(nums[i], nums[i + 1]); curX = nums[i + 2]; curY = nums[i + 3]; update(curX, curY);
        }
        break;
      case "s": case "q":
        for (let i = 0; i + 3 < nums.length; i += 4) {
          update(curX + nums[i], curY + nums[i + 1]); curX += nums[i + 2]; curY += nums[i + 3]; update(curX, curY);
        }
        break;
      case "T":
        for (let i = 0; i + 1 < nums.length; i += 2) { curX = nums[i]; curY = nums[i + 1]; update(curX, curY); }
        break;
      case "t":
        for (let i = 0; i + 1 < nums.length; i += 2) { curX += nums[i]; curY += nums[i + 1]; update(curX, curY); }
        break;
      case "A":
        for (let i = 0; i + 6 < nums.length; i += 7) { curX = nums[i + 5]; curY = nums[i + 6]; update(curX, curY); }
        break;
      case "a":
        for (let i = 0; i + 6 < nums.length; i += 7) { curX += nums[i + 5]; curY += nums[i + 6]; update(curX, curY); }
        break;
      case "Z": case "z": curX = startX; curY = startY; break;
    }
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

function unionBounds(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
  };
}

function computeBounds(svg) {
  // Strip <desc>
  let body = svg.replace(/<desc>[\s\S]*?<\/desc>/, "");

  let bounds = null;
  let m;

  const rectRe = /<rect\b([^/>]*)\/?>/g;
  while ((m = rectRe.exec(body)) !== null) {
    const a = m[1];
    const x = num(a, "x"), y = num(a, "y"), w = num(a, "width"), h = num(a, "height");
    if (w > 0 || h > 0) bounds = unionBounds(bounds, { minX: x, minY: y, maxX: x + w, maxY: y + h });
  }

  const circleRe = /<circle\b([^/>]*)\/?>/g;
  while ((m = circleRe.exec(body)) !== null) {
    const a = m[1];
    const cx = num(a, "cx"), cy = num(a, "cy"), r = num(a, "r");
    if (r > 0) bounds = unionBounds(bounds, { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r });
  }

  const ellipseRe = /<ellipse\b([^/>]*)\/?>/g;
  while ((m = ellipseRe.exec(body)) !== null) {
    const a = m[1];
    const cx = num(a, "cx"), cy = num(a, "cy"), rx = num(a, "rx"), ry = num(a, "ry");
    bounds = unionBounds(bounds, { minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry });
  }

  const lineRe = /<line\b([^/>]*)\/?>/g;
  while ((m = lineRe.exec(body)) !== null) {
    const a = m[1];
    const x1 = num(a, "x1"), y1 = num(a, "y1"), x2 = num(a, "x2"), y2 = num(a, "y2");
    bounds = unionBounds(bounds, { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) });
  }

  const polyRe = /<poly(?:line|gon)\b([^/>]*)\/?>/g;
  while ((m = polyRe.exec(body)) !== null) {
    const pts = parsePoints(m[1]);
    for (const p of pts) bounds = unionBounds(bounds, { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y });
  }

  const pathRe = /<path\b[^>]*\bd="([^"]+)"/g;
  while ((m = pathRe.exec(body)) !== null) {
    const pb = parsePath(m[1]);
    bounds = unionBounds(bounds, pb);
  }

  const textRe = /<text\b([^>]*)>/g;
  while ((m = textRe.exec(body)) !== null) {
    const a = m[1];
    const x = num(a, "x"), y = num(a, "y"), fs = num(a, "font-size", 16);
    bounds = unionBounds(bounds, { minX: x - fs * 0.6, minY: y - fs / 2, maxX: x + fs * 0.6, maxY: y + fs / 2 });
  }

  return bounds;
}

function checkFile(filePath) {
  const svg = fs.readFileSync(filePath, "utf-8");
  const vbMatch = svg.match(/<svg[^>]*viewBox="([^"]+)"/);
  if (!vbMatch) {
    console.log(`  ${filePath}: NO VIEWBOX`);
    return;
  }
  const [vx, vy, vw, vh] = vbMatch[1].trim().split(/[\s,]+/).map(Number);

  const b = computeBounds(svg);
  if (!b) {
    console.log(`  ${filePath}: no drawable content`);
    return;
  }

  const issues = [];
  if (b.minX < vx - TOLERANCE) issues.push(`minX=${b.minX.toFixed(2)} < viewBox.x=${vx}`);
  if (b.minY < vy - TOLERANCE) issues.push(`minY=${b.minY.toFixed(2)} < viewBox.y=${vy}`);
  if (b.maxX > vx + vw + TOLERANCE) issues.push(`maxX=${b.maxX.toFixed(2)} > viewBox.x+w=${vx + vw}`);
  if (b.maxY > vy + vh + TOLERANCE) issues.push(`maxY=${b.maxY.toFixed(2)} > viewBox.y+h=${vy + vh}`);

  // Empty padding (artwork doesn't reach the edges)
  const padL = b.minX - vx;
  const padT = b.minY - vy;
  const padR = vx + vw - b.maxX;
  const padB = vy + vh - b.maxY;

  const pads = [];
  if (padL > 1.5) pads.push(`L:${padL.toFixed(1)}`);
  if (padT > 1.5) pads.push(`T:${padT.toFixed(1)}`);
  if (padR > 1.5) pads.push(`R:${padR.toFixed(1)}`);
  if (padB > 1.5) pads.push(`B:${padB.toFixed(1)}`);

  const status = issues.length > 0 ? "OVERFLOW" : pads.length > 0 ? "padding" : "OK";
  const detail = [...issues, ...(pads.length ? [`unused: ${pads.join(" ")}`] : [])].join("; ");

  if (status !== "OK" || process.env.VERBOSE) {
    const rel = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
    console.log(`  ${status.padEnd(8)} ${rel}  vb=${vw}x${vh} bounds=(${b.minX.toFixed(1)},${b.minY.toFixed(1)})-(${b.maxX.toFixed(1)},${b.maxY.toFixed(1)})  ${detail}`);
  }
}

function walk(target) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      const full = path.join(target, entry);
      const s = fs.statSync(full);
      if (s.isDirectory() && entry !== "preview" && entry !== "node_modules") walk(full);
      else if (s.isFile() && entry.endsWith(".svg")) checkFile(full);
    }
  } else if (stat.isFile() && target.endsWith(".svg")) {
    checkFile(target);
  }
}

for (const t of targets) walk(t);
