#!/usr/bin/env node

/**
 * One-off: pad an icon's viewBox by N pixels on every side and shift its
 * artwork coordinates by (+N, +N) so the artwork stays in place visually
 * while gaining `N` extra pixels of breathing room for stroke half-widths.
 *
 * Usage:
 *   node scripts/pad-icon-viewbox.mjs <pad> <file.svg> [<file.svg> ...]
 *   node scripts/pad-icon-viewbox.mjs <padL>,<padT>,<padR>,<padB> <file.svg> [...]
 *
 * Single number = uniform pad on all sides.
 * Comma form = asymmetric pad (left, top, right, bottom).
 *
 * Reuses the coordinate shifter from migrate-icons-to-trimmed-viewbox.mjs.
 */

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

if (args.length < 2) {
  console.error("Usage: node scripts/pad-icon-viewbox.mjs <pad|padL,padT,padR,padB> <file.svg> [...]");
  process.exit(1);
}

let padL, padT, padR, padB;

if (args[0].includes(",")) {
  const parts = args[0].split(",").map(Number);

  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    console.error("Asymmetric pad must be: padL,padT,padR,padB");
    process.exit(1);
  }

  [padL, padT, padR, padB] = parts;
} else {
  const p = Number(args[0]);

  if (!Number.isFinite(p)) {
    console.error("First argument must be a number");
    process.exit(1);
  }

  padL = padT = padR = padB = p;
}

const files = args.slice(1);

const NUM_RE_SRC = "-?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?";

function num(v) {
  if (Number.isInteger(v)) return String(v);

  const s = v.toFixed(4);

  return s.replace(/\.?0+$/, "");
}

function shiftPathData(d, sx, sy) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g) || [];
  const out = [];

  for (const token of tokens) {
    const cmd = token[0];
    const rest = token.slice(1).trim();
    const nums = rest.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
    const values = nums.map(Number);

    switch (cmd) {
      case "M":
      case "L":
      case "T":
        for (let i = 0; i + 1 < values.length; i += 2) {
          values[i] += sx;
          values[i + 1] += sy;
        }
        break;
      case "H":
        for (let i = 0; i < values.length; i++) values[i] += sx;
        break;
      case "V":
        for (let i = 0; i < values.length; i++) values[i] += sy;
        break;
      case "C":
        for (let i = 0; i + 5 < values.length; i += 6) {
          values[i] += sx; values[i + 1] += sy;
          values[i + 2] += sx; values[i + 3] += sy;
          values[i + 4] += sx; values[i + 5] += sy;
        }
        break;
      case "S": case "Q":
        for (let i = 0; i + 3 < values.length; i += 4) {
          values[i] += sx; values[i + 1] += sy;
          values[i + 2] += sx; values[i + 3] += sy;
        }
        break;
      case "A":
        for (let i = 0; i + 6 < values.length; i += 7) {
          values[i + 5] += sx; values[i + 6] += sy;
        }
        break;
      case "m":
        if (values.length >= 2 && out.length === 0) {
          values[0] += sx;
          values[1] += sy;
        }
        break;
    }

    out.push(cmd + (values.length > 0 ? values.map(num).join(",") : ""));
  }

  return out.join("");
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

function shiftBody(body, sx, sy) {
  let out = body;

  const xAttrRe = new RegExp(`\\b(x|x1|x2|cx)="(${NUM_RE_SRC})"`, "g");
  const yAttrRe = new RegExp(`\\b(y|y1|y2|cy)="(${NUM_RE_SRC})"`, "g");

  out = out.replace(xAttrRe, (_, name, v) => `${name}="${num(parseFloat(v) + sx)}"`);
  out = out.replace(yAttrRe, (_, name, v) => `${name}="${num(parseFloat(v) + sy)}"`);
  out = out.replace(/\bd="([^"]+)"/g, (_, dv) => `d="${shiftPathData(dv, sx, sy)}"`);
  out = out.replace(/\bpoints="([^"]+)"/g, (_, pts) => `points="${shiftPoints(pts, sx, sy)}"`);

  // translate(tx, ty) — shift center
  const translateXY = new RegExp(`translate\\s*\\(\\s*(${NUM_RE_SRC})\\s*[,\\s]\\s*(${NUM_RE_SRC})\\s*\\)`, "g");

  out = out.replace(translateXY, (_, tx, ty) => `translate(${num(parseFloat(tx) + sx)},${num(parseFloat(ty) + sy)})`);

  // rotate(angle, cx, cy) — shift center; angle may be a Mustache placeholder
  const rotateRe = new RegExp(
    `rotate\\s*\\(\\s*(${NUM_RE_SRC}|\\{\\{[^}]+\\}\\})\\s*[,\\s]\\s*(${NUM_RE_SRC})\\s*[,\\s]\\s*(${NUM_RE_SRC})\\s*\\)`,
    "g",
  );

  out = out.replace(
    rotateRe,
    (_, ang, cx, cy) => `rotate(${ang}, ${num(parseFloat(cx) + sx)}, ${num(parseFloat(cy) + sy)})`,
  );

  return out;
}

for (const filePath of files) {
  const svg = fs.readFileSync(filePath, "utf-8");
  const openMatch = svg.match(/<svg[^>]*>/);

  if (!openMatch) {
    console.warn(`skip (no <svg>): ${filePath}`);
    continue;
  }

  const vbMatch = openMatch[0].match(/viewBox="([^"]+)"/);

  if (!vbMatch) {
    console.warn(`skip (no viewBox): ${filePath}`);
    continue;
  }

  const [vx, vy, vw, vh] = vbMatch[1].trim().split(/[\s,]+/).map(Number);
  const newW = vw + padL + padR;
  const newH = vh + padT + padB;
  const newOpen = openMatch[0].replace(
    /viewBox="[^"]*"/,
    `viewBox="${num(vx)} ${num(vy)} ${num(newW)} ${num(newH)}"`,
  );

  const headerEnd = openMatch.index + openMatch[0].length;
  const closingIdx = svg.lastIndexOf("</svg>");
  const head = svg.slice(0, headerEnd).replace(openMatch[0], newOpen);
  const body = svg.slice(headerEnd, closingIdx);
  const tail = svg.slice(closingIdx);

  // Don't touch <desc> contents — content shifts by (padL, padT) so it stays
  // visually anchored to the top-left of the original viewBox region.
  const descRe = /<desc>.*?<\/desc>/s;
  const descMatch = body.match(descRe);
  let shifted;

  if (descMatch) {
    const before = body.slice(0, descMatch.index);
    const after = body.slice(descMatch.index + descMatch[0].length);

    shifted = shiftBody(before, padL, padT) + descMatch[0] + shiftBody(after, padL, padT);
  } else {
    shifted = shiftBody(body, padL, padT);
  }

  fs.writeFileSync(filePath, head + shifted + tail, "utf-8");
  const rel = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
  const padDesc = padL === padT && padT === padR && padR === padB ? `+${padL}` : `(${padL},${padT},${padR},${padB})`;

  console.log(`  padded ${padDesc}: ${rel}  vb ${vw}x${vh} → ${newW}x${newH}`);
}
