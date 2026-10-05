#!/usr/bin/env node
/**
 * Flattens <g transform="..."> wrappers in icon SVGs to native coordinates.
 * Uses svgpath for path transforms, manual math for other elements.
 * Handles nested groups by processing innermost first.
 */
import fs from "node:fs";
import path from "node:path";
import SvgPath from "svgpath";

const ICONS_DIR = path.resolve("packages/icons");
const SKIP_DIRS = new Set(["preview", "node_modules", "src", "dist"]);
let totalFlattened = 0;

function parseMatrix(transformStr) {
  let m = [1, 0, 0, 1, 0, 0]; // identity
  const ops = transformStr.match(/(translate|scale|rotate|matrix)\([^)]+\)/g);
  if (!ops) return null;
  for (const op of ops) {
    const fn = op.match(/^(\w+)/)[1];
    const nums = op
      .match(/\(([^)]+)\)/)[1]
      .split(/[\s,]+/)
      .map(Number);
    let om;
    switch (fn) {
      case "translate":
        om = [1, 0, 0, 1, nums[0] || 0, nums[1] || 0];
        break;
      case "scale": {
        const sx = nums[0],
          sy = nums[1] ?? sx;
        om = [sx, 0, 0, sy, 0, 0];
        break;
      }
      case "rotate": {
        const rad = (nums[0] * Math.PI) / 180,
          c = Math.cos(rad),
          s = Math.sin(rad);
        if (nums.length === 3) {
          const cx = nums[1],
            cy = nums[2];
          om = [c, s, -s, c, cx - cx * c + cy * s, cy - cx * s - cy * c];
        } else {
          om = [c, s, -s, c, 0, 0];
        }
        break;
      }
      case "matrix":
        om = nums.slice(0, 6);
        break;
      default:
        return null;
    }
    m = mul(m, om);
  }
  return m;
}

function mul(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function pt(x, y, m) {
  return [R(m[0] * x + m[2] * y + m[4]), R(m[1] * x + m[3] * y + m[5])];
}

function det(m) {
  return Math.abs(m[0] * m[3] - m[1] * m[2]);
}
function scaleOf(m) {
  return Math.sqrt(det(m));
}
function R(n) {
  return Math.round(n * 100) / 100;
}

function getAttr(attrs, name) {
  const m = attrs.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

function setAttr(attrs, name, val) {
  const re = new RegExp(`(${name}=")([^"]*)(")`);
  return re.test(attrs) ? attrs.replace(re, `$1${val}$3`) : attrs;
}

function removeAttr(attrs, name) {
  return attrs.replace(new RegExp(`\\s*${name}="[^"]*"`), "");
}

function transformContent(content, matrix) {
  let out = content;

  // Paths: use svgpath library
  out = out.replace(/(<path\s)([^>]*?)(\/?>)/g, (full, tag, attrs, close) => {
    const d = getAttr(attrs, "d");
    if (!d) return full;

    // If path has its own transform, compose it
    let m = matrix;
    const elT = getAttr(attrs, "transform");
    if (elT) {
      const elM = parseMatrix(elT);
      if (elM) m = mul(matrix, elM);
      attrs = removeAttr(attrs, "transform");
    }

    const newD = new SvgPath(d).matrix(m).round(2).toString();
    attrs = setAttr(attrs, "d", newD);

    // Scale stroke-width
    const sw = getAttr(attrs, "stroke-width");
    if (sw) attrs = setAttr(attrs, "stroke-width", String(R(parseFloat(sw) * scaleOf(m))));

    return `${tag}${attrs}${close}`;
  });

  // Lines
  out = out.replace(/(<line\s)([^>]*?)(\/?>)/g, (full, tag, attrs, close) => {
    const [nx1, ny1] = pt(parseFloat(getAttr(attrs, "x1") || 0), parseFloat(getAttr(attrs, "y1") || 0), matrix);
    const [nx2, ny2] = pt(parseFloat(getAttr(attrs, "x2") || 0), parseFloat(getAttr(attrs, "y2") || 0), matrix);
    attrs = setAttr(attrs, "x1", String(nx1));
    attrs = setAttr(attrs, "y1", String(ny1));
    attrs = setAttr(attrs, "x2", String(nx2));
    attrs = setAttr(attrs, "y2", String(ny2));
    const sw = getAttr(attrs, "stroke-width");
    if (sw) attrs = setAttr(attrs, "stroke-width", String(R(parseFloat(sw) * scaleOf(matrix))));
    attrs = removeAttr(attrs, "transform");
    return `${tag}${attrs}${close}`;
  });

  // Circles
  out = out.replace(/(<circle\s)([^>]*?)(\/?>)/g, (full, tag, attrs, close) => {
    let m = matrix;
    const elT = getAttr(attrs, "transform");
    if (elT) {
      const elM = parseMatrix(elT);
      if (elM) m = mul(matrix, elM);
      attrs = removeAttr(attrs, "transform");
    }
    const [ncx, ncy] = pt(parseFloat(getAttr(attrs, "cx") || 0), parseFloat(getAttr(attrs, "cy") || 0), m);
    const nr = R(parseFloat(getAttr(attrs, "r") || 0) * scaleOf(m));
    attrs = setAttr(attrs, "cx", String(ncx));
    attrs = setAttr(attrs, "cy", String(ncy));
    attrs = setAttr(attrs, "r", String(nr));
    return `${tag}${attrs}${close}`;
  });

  // Ellipses
  out = out.replace(/(<ellipse\s)([^>]*?)(\/?>)/g, (full, tag, attrs, close) => {
    let m = matrix;
    const elT = getAttr(attrs, "transform");
    if (elT) {
      const elM = parseMatrix(elT);
      if (elM) m = mul(matrix, elM);
      attrs = removeAttr(attrs, "transform");
    }
    const [ncx, ncy] = pt(parseFloat(getAttr(attrs, "cx") || 0), parseFloat(getAttr(attrs, "cy") || 0), m);
    const sx = Math.sqrt(m[0] * m[0] + m[1] * m[1]);
    const sy = Math.sqrt(m[2] * m[2] + m[3] * m[3]);
    attrs = setAttr(attrs, "cx", String(ncx));
    attrs = setAttr(attrs, "cy", String(ncy));
    attrs = setAttr(attrs, "rx", String(R(parseFloat(getAttr(attrs, "rx") || 0) * sx)));
    attrs = setAttr(attrs, "ry", String(R(parseFloat(getAttr(attrs, "ry") || 0) * sy)));
    return `${tag}${attrs}${close}`;
  });

  // Rects
  out = out.replace(/(<rect\s)([^>]*?)(\/?>)/g, (full, tag, attrs, close) => {
    let m = matrix;
    const elT = getAttr(attrs, "transform");
    if (elT) {
      const elM = parseMatrix(elT);
      if (elM) m = mul(matrix, elM);
      attrs = removeAttr(attrs, "transform");
    }
    const [nx, ny] = pt(parseFloat(getAttr(attrs, "x") || 0), parseFloat(getAttr(attrs, "y") || 0), m);
    const sx = Math.sqrt(m[0] * m[0] + m[1] * m[1]);
    const sy = Math.sqrt(m[2] * m[2] + m[3] * m[3]);
    attrs = setAttr(attrs, "x", String(nx));
    attrs = setAttr(attrs, "y", String(ny));
    const w = getAttr(attrs, "width");
    if (w) attrs = setAttr(attrs, "width", String(R(parseFloat(w) * sx)));
    const h = getAttr(attrs, "height");
    if (h) attrs = setAttr(attrs, "height", String(R(parseFloat(h) * sy)));
    const rx = getAttr(attrs, "rx");
    if (rx) attrs = setAttr(attrs, "rx", String(R(parseFloat(rx) * Math.min(sx, sy))));
    const sw = getAttr(attrs, "stroke-width");
    if (sw) attrs = setAttr(attrs, "stroke-width", String(R(parseFloat(sw) * scaleOf(m))));
    return `${tag}${attrs}${close}`;
  });

  // Polygons / Polylines
  out = out.replace(/(<poly(?:gon|line)\s)([^>]*?)(\/?>)/g, (full, tag, attrs, close) => {
    const points = getAttr(attrs, "points");
    if (!points) return full;
    const transformed = points
      .trim()
      .split(/\s+/)
      .map((pair) => {
        const parts = pair.split(",").map(Number);
        const [nx, ny] = pt(parts[0], parts[1], matrix);
        return `${nx},${ny}`;
      })
      .join(" ");
    attrs = setAttr(attrs, "points", transformed);
    const sw = getAttr(attrs, "stroke-width");
    if (sw) attrs = setAttr(attrs, "stroke-width", String(R(parseFloat(sw) * scaleOf(matrix))));
    attrs = removeAttr(attrs, "transform");
    return `${tag}${attrs}${close}`;
  });

  // Text elements
  out = out.replace(/(<text\s)([^>]*?)(>)/g, (full, tag, attrs, close) => {
    const [nx, ny] = pt(parseFloat(getAttr(attrs, "x") || 0), parseFloat(getAttr(attrs, "y") || 0), matrix);
    attrs = setAttr(attrs, "x", String(nx));
    attrs = setAttr(attrs, "y", String(ny));
    const fs = getAttr(attrs, "font-size");
    if (fs) attrs = setAttr(attrs, "font-size", String(R(parseFloat(fs) * scaleOf(matrix))));
    attrs = removeAttr(attrs, "transform");
    return `${tag}${attrs}${close}`;
  });

  return out;
}

function flattenSvg(svg) {
  let result = svg;
  // Process innermost <g transform> groups first, repeating until none remain
  for (let i = 0; i < 10; i++) {
    // Match innermost <g ...transform="..."...> that contains no nested <g>
    const re = /<g\s([^>]*transform="([^"]+)"[^>]*)>((?:(?!<\/?g[\s>])[\s\S])*?)<\/g>/;
    const m = result.match(re);
    if (!m) break;

    const gAttrs = m[1];
    const transformStr = m[2];
    const inner = m[3];

    const matrix = parseMatrix(transformStr);
    if (!matrix) {
      console.warn(`    Could not parse: ${transformStr}`);
      break;
    }

    // Collect non-transform attributes from the <g> to propagate to children
    let inheritAttrs = gAttrs.replace(/transform="[^"]*"/, "").trim();

    // Transform the inner content
    let transformed = transformContent(inner, matrix);

    // If the <g> had fill/stroke attrs, propagate them to child elements that don't have them
    if (inheritAttrs) {
      const fillMatch = inheritAttrs.match(/fill="([^"]*)"/);
      const strokeMatch = inheritAttrs.match(/stroke="([^"]*)"/);
      const strokeLCMatch = inheritAttrs.match(/stroke-linecap="([^"]*)"/);
      const strokeLJMatch = inheritAttrs.match(/stroke-linejoin="([^"]*)"/);

      if (fillMatch) {
        transformed = transformed.replace(
          /(<(?:path|circle|ellipse|rect|polygon|polyline|line)\s)([^>]*?)(\/?>)/g,
          (full, tag, attrs, close) => {
            if (!getAttr(attrs, "fill")) return `${tag}fill="${fillMatch[1]}" ${attrs}${close}`;
            return full;
          },
        );
      }
      if (strokeMatch) {
        transformed = transformed.replace(
          /(<(?:path|circle|ellipse|rect|polygon|polyline|line)\s)([^>]*?)(\/?>)/g,
          (full, tag, attrs, close) => {
            if (!getAttr(attrs, "stroke")) return `${tag}stroke="${strokeMatch[1]}" ${attrs}${close}`;
            return full;
          },
        );
      }
      if (strokeLCMatch) {
        transformed = transformed.replace(
          /(<(?:path|circle|ellipse|rect|polygon|polyline|line)\s)([^>]*?)(\/?>)/g,
          (full, tag, attrs, close) => {
            if (!getAttr(attrs, "stroke-linecap")) return `${tag}stroke-linecap="${strokeLCMatch[1]}" ${attrs}${close}`;
            return full;
          },
        );
      }
      if (strokeLJMatch) {
        transformed = transformed.replace(
          /(<(?:path|circle|ellipse|rect|polygon|polyline|line)\s)([^>]*?)(\/?>)/g,
          (full, tag, attrs, close) => {
            if (!getAttr(attrs, "stroke-linejoin"))
              return `${tag}stroke-linejoin="${strokeLJMatch[1]}" ${attrs}${close}`;
            return full;
          },
        );
      }
    }

    result = result.replace(m[0], transformed);
  }
  return result;
}

function processFile(filePath) {
  const svg = fs.readFileSync(filePath, "utf-8");
  if (!/transform="/.test(svg)) return;

  const relPath = path.relative(ICONS_DIR, filePath);
  const result = flattenSvg(svg);

  if (result !== svg) {
    // Clean up extra blank lines
    const cleaned = result.replace(/\n{3,}/g, "\n\n");
    fs.writeFileSync(filePath, cleaned, "utf-8");
    totalFlattened++;
    console.log(`  ${relPath}`);
  }
}

function walkDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full);
    else if (entry.name.endsWith(".svg")) processFile(full);
  }
}

console.log("Flattening transforms...");
walkDir(ICONS_DIR);
console.log(`\nFlattened: ${totalFlattened} icons`);
