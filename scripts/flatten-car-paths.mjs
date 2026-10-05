#!/usr/bin/env node
/**
 * Flattens the toggle-tires car SVG from 512-space + complex transform chain
 * to native 144x144 coordinates using the svgpath library for accurate
 * path data transformation.
 *
 * Transform matrix: x' = 0.176*py + 26.944, y' = -0.176*px + 98.056
 * SVG matrix(a,b,c,d,e,f) = matrix(0, -0.176, 0.176, 0, 26.944, 98.056)
 */
import SvgPath from "svgpath";

// The combined transform matrix coefficients
// matrix(a, b, c, d, e, f) where:
//   x' = a*x + c*y + e = 0*x + 0.176*y + 26.944
//   y' = b*x + d*y + f = -0.176*x + 0*y + 98.056
const MATRIX = [0, -0.176, 0.176, 0, 26.944, 98.056];

// Original paths from the 512-space SVG
const paths = {
  rightTopPanel: "M448.118,351.402h47.018v-75.629c-11.104,2.554-29.453,6.744-47.008,10.593L448.118,351.402z",
  rightBottomPanel: "M495.136,160.599h-47.008v65.035c17.555,3.85,35.904,8.03,47.008,10.584V160.599z",
  mainBody:
    "M503.763,245.781c0,0-66.446-15.465-92.844-20.383c-26.399-4.899-91.51-16.42-91.51-16.42s-3.008-11.18-4.606-20.27c-2.771-15.672-16.59-31.335-51.624-31.335c-35.024,0-47.018,0-66.369,0c-50.697,0-42.374,48.852-73.067,48.852c-30.692,0-54.215,0-54.215,0v99.549c0,0,23.523,0,54.215,0c30.693,0,22.37,48.863,73.067,48.863c19.351,0,31.335,0,66.369,0s48.853-15.673,51.624-31.346c1.598-9.08,4.606-20.278,4.606-20.278s65.111-11.511,91.51-16.42c26.398-4.91,92.844-20.373,92.844-20.373c4.814-1.06,8.237-5.307,8.237-10.215C512,251.087,508.576,246.83,503.763,245.781z",
  window:
    "M295.895,280.275c-22.983,0-28.896-10.867-28.896-24.27c0-13.412,5.912-24.28,28.896-24.28c22.984,0,41.617,10.868,41.617,24.28C337.512,269.408,318.88,280.275,295.895,280.275z",
};

console.log("=== Transformed paths (using svgpath library) ===\n");

for (const [name, d] of Object.entries(paths)) {
  const transformed = new SvgPath(d).matrix(MATRIX).round(2).toString();
  console.log(`<!-- ${name} -->`);
  console.log(`<path fill="{{graphic1Color}}" d="${transformed}"/>`);
  console.log();
}

// Window uses background fill (cutout)
const windowTransformed = new SvgPath(paths.window).matrix(MATRIX).round(2).toString();
console.log(`<!-- Window (background color fill) -->`);
console.log(`<path fill="#3a2a2a" d="${windowTransformed}"/>`);

// Transform polygon points
function transformPoint(px, py) {
  return [
    Math.round((0.176 * py + 26.944) * 100) / 100,
    Math.round((-0.176 * px + 98.056) * 100) / 100,
  ];
}

const polygonPoints = [
  [57.147, 175.343],
  [0.009, 175.343],
  [0, 336.647],
  [57.147, 336.647],
];

const transformedPolygon = polygonPoints.map(([px, py]) => {
  const [x, y] = transformPoint(px, py);
  return `${x},${y}`;
});

console.log(`\n<!-- Left side panel -->`);
console.log(`<polygon fill="{{graphic1Color}}" points="${transformedPolygon.join(" ")}"/>`);

// Tire indicator rects
console.log("\n=== Tire indicator rects (for action code) ===");
const tireRects = [
  { id: "lf", cx: 381, cy: 114, hw: 34.25, hh: 24.5 },
  { id: "rf", cx: 381, cy: 398, hw: 34.25, hh: 24.5 },
  { id: "lr", cx: 98, cy: 107, hw: 36.1, hh: 28.5 },
  { id: "rr", cx: 98, cy: 405, hw: 36.1, hh: 28.5 },
];

for (const t of tireRects) {
  const [x1, y1] = transformPoint(t.cx - t.hh, t.cy - t.hw);
  const [x2, y2] = transformPoint(t.cx + t.hh, t.cy + t.hw);
  const x = Math.round(Math.min(x1, x2) * 100) / 100;
  const y = Math.round(Math.min(y1, y2) * 100) / 100;
  const w = Math.round(Math.abs(x2 - x1) * 100) / 100;
  const h = Math.round(Math.abs(y2 - y1) * 100) / 100;
  console.log(
    `${t.id}: <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="COLOR" stroke="#888888" stroke-width="1"/>`,
  );
}

// Overall bounds (car body + tires)
console.log("\n=== Overall bounds estimate ===");
const allPoints = [];
for (const [, d] of Object.entries(paths)) {
  // Get bounds from transformed path
  const tp = new SvgPath(d).matrix(MATRIX);
  // Iterate segments to find bounds
  tp.iterate((segment) => {
    for (let i = 1; i < segment.length; i += 2) {
      if (i + 1 < segment.length) {
        allPoints.push({ x: segment[i], y: segment[i + 1] });
      }
    }
  });
}
// Add polygon points
for (const [px, py] of polygonPoints) {
  const [x, y] = transformPoint(px, py);
  allPoints.push({ x, y });
}
// Add tire corners
for (const t of tireRects) {
  const [x1, y1] = transformPoint(t.cx - t.hh, t.cy - t.hw);
  const [x2, y2] = transformPoint(t.cx + t.hh, t.cy + t.hw);
  allPoints.push({ x: x1, y: y1 }, { x: x2, y: y2 });
}

const minX = Math.min(...allPoints.map((p) => p.x));
const maxX = Math.max(...allPoints.map((p) => p.x));
const minY = Math.min(...allPoints.map((p) => p.y));
const maxY = Math.max(...allPoints.map((p) => p.y));
console.log(`Content: x=${minX.toFixed(1)} to ${maxX.toFixed(1)}, y=${minY.toFixed(1)} to ${maxY.toFixed(1)}`);
console.log(`Size: ${(maxX - minX).toFixed(1)} x ${(maxY - minY).toFixed(1)}`);
const pad = 4;
console.log(
  `artworkBounds (with ${pad}px pad): {"x":${Math.floor(minX - pad)},"y":${Math.floor(minY - pad)},"width":${Math.ceil(maxX - minX + 2 * pad)},"height":${Math.ceil(maxY - minY + 2 * pad)}}`,
);
