// packages/website/scripts/generate-icon-gallery.mts
/**
 * Generates the icon-gallery assets + metadata for the website.
 *
 * Outputs (both gitignored, regenerated on every `dev`/`build`):
 *   public/icon-gallery/<class>/.../*.svg   — composed, as-on-device renderings
 *   src/data/icon-gallery.json              — GalleryEntry[] for IconGallery.astro
 *
 * Run with tsx so the TypeScript imports resolve (same pattern as the root
 * scripts/generate-action-comms.mjs):  pnpm --filter @iracedeck/website generate:gallery
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import {
  assembleIcon,
  dataUriToSvg,
  isDataUri,
  parseIconLocked,
  parseIconTitleDefaults,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/icon-composer";

import { renderDialBox, resolveDialBoxColors } from "../../iracing-actions/src/shared/dial-box.ts";
import {
  DYNAMIC_SAMPLE_DATA,
  extractColorSlots,
  extractRawViewBox,
  parseIconImports,
  parseTitlesMaps,
  renderDynamicTemplate,
  type GalleryEntry,
} from "../src/gallery-gen/lib.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const ICONS_ROOT = path.join(REPO_ROOT, "packages", "icons");
const ACTIONS_ROOT = path.join(REPO_ROOT, "packages", "iracing-actions", "src", "actions");
const DYNAMIC_ROOT = path.join(REPO_ROOT, "packages", "iracing-actions", "icons");
const ASSETS_OUT = path.join(__dirname, "..", "public", "icon-gallery");
const JSON_OUT = path.join(__dirname, "..", "src", "data", "icon-gallery.json");

const NON_FAMILY_DIRS = new Set(["preview", "src", "node_modules"]);

function repoRel(p: string): string {
  return path.relative(REPO_ROOT, p).replaceAll(path.sep, "/");
}

function writeAsset(sitePath: string, svg: string): void {
  const dest = path.join(ASSETS_OUT, sitePath);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, svg, "utf-8");
}

function toRawSvg(rendered: string): string {
  return isDataUri(rendered) ? dataUriToSvg(rendered) : rendered;
}

// ---------------------------------------------------------------------------
// Scan action sources once: icon path → consuming actions, icon path → title.
// ---------------------------------------------------------------------------
const actionsByIcon = new Map<string, string[]>();
const titleByIcon = new Map<string, string>();

for (const dirent of readdirSync(ACTIONS_ROOT, { withFileTypes: true })) {
  if (!dirent.isDirectory() || dirent.name === "data" || dirent.name === "settings") continue;

  const sourcePath = path.join(ACTIONS_ROOT, dirent.name, `${dirent.name}.ts`);
  let source: string;
  try {
    source = readFileSync(sourcePath, "utf-8");
  } catch {
    continue;
  }

  const titles = parseTitlesMaps(source);

  for (const iconPath of parseIconImports(source)) {
    const consumers = actionsByIcon.get(iconPath) ?? [];
    if (!consumers.includes(dirent.name)) consumers.push(dirent.name);
    actionsByIcon.set(iconPath, consumers);

    const basename = iconPath.split("/").pop() ?? "";
    if (titles[basename] && !titleByIcon.has(iconPath)) titleByIcon.set(iconPath, titles[basename]);
  }
}

// ---------------------------------------------------------------------------
// Emit.
// ---------------------------------------------------------------------------
rmSync(ASSETS_OUT, { recursive: true, force: true });
const entries: GalleryEntry[] = [];

// 1. Key icon templates — full composition through the real pipeline.
for (const familyDirent of readdirSync(ICONS_ROOT, { withFileTypes: true })) {
  if (!familyDirent.isDirectory() || NON_FAMILY_DIRS.has(familyDirent.name)) continue;
  const family = familyDirent.name;

  for (const file of readdirSync(path.join(ICONS_ROOT, family))) {
    if (!file.endsWith(".svg")) continue;
    const name = file.slice(0, -4);
    const iconPath = `${family}/${name}`;
    const sourcePath = path.join(ICONS_ROOT, family, file);
    const svg = readFileSync(sourcePath, "utf-8");

    const runtimeTitle = titleByIcon.get(iconPath);
    const colors = resolveIconColors(svg, {}, undefined);
    const title = resolveTitleSettings(svg, {}, undefined, runtimeTitle);
    const border = resolveBorderSettings(svg, {}, undefined);
    const graphic = resolveGraphicSettings({}, undefined);
    const composed = toRawSvg(assembleIcon({ graphicSvg: svg, colors, title, border, graphic }));

    const sitePath = `template/${family}/${name}.svg`;
    writeAsset(sitePath, composed);
    entries.push({
      class: "template",
      family,
      name,
      path: repoRel(sourcePath),
      viewBox: extractRawViewBox(svg),
      slots: extractColorSlots(svg),
      locked: [...parseIconLocked(svg)],
      title: runtimeTitle ?? parseIconTitleDefaults(svg).text,
      actions: actionsByIcon.get(iconPath) ?? [],
      file: `/icon-gallery/${sitePath}`,
    });
  }
}

// 2. Dynamic templates — template frame with sample values; live content stays blank.
for (const file of readdirSync(DYNAMIC_ROOT)) {
  if (!file.endsWith(".svg")) continue;
  const name = file.slice(0, -4);
  const sourcePath = path.join(DYNAMIC_ROOT, file);
  const svg = readFileSync(sourcePath, "utf-8");

  const sitePath = `dynamic/${name}.svg`;
  writeAsset(sitePath, renderDynamicTemplate(svg, DYNAMIC_SAMPLE_DATA[name] ?? {}));
  entries.push({
    class: "dynamic",
    family: "dynamic-templates",
    name,
    path: repoRel(sourcePath),
    viewBox: extractRawViewBox(svg),
    slots: extractColorSlots(svg),
    locked: [...parseIconLocked(svg)],
    title: parseIconTitleDefaults(svg).text,
    actions: [],
    file: `/icon-gallery/${sitePath}`,
    sample: true,
  });
}

// 3–5. Static per-action files, shown as-is.
const STATIC_CLASSES = [
  { file: "key.svg", cls: "key" },
  { file: "dial.svg", cls: "dial" },
  { file: "icon.svg", cls: "category" },
] as const;

for (const dirent of readdirSync(ACTIONS_ROOT, { withFileTypes: true })) {
  if (!dirent.isDirectory() || dirent.name === "data" || dirent.name === "settings") continue;

  for (const { file, cls } of STATIC_CLASSES) {
    const sourcePath = path.join(ACTIONS_ROOT, dirent.name, file);
    let svg: string;
    try {
      svg = readFileSync(sourcePath, "utf-8");
    } catch {
      continue;
    }

    const sitePath = `${cls}/${dirent.name}.svg`;
    writeAsset(sitePath, svg);
    entries.push({
      class: cls,
      family: dirent.name,
      name: dirent.name,
      path: repoRel(sourcePath),
      viewBox: extractRawViewBox(svg),
      slots: extractColorSlots(svg),
      locked: [],
      actions: [dirent.name],
      file: `/icon-gallery/${sitePath}`,
    });
  }
}

// 6. One rendered dash-box sample so the dial touch-strip surface is represented.
const dashSvg = toRawSvg(
  renderDialBox({
    width: 200,
    height: 100,
    abbr: "BIAS",
    value: "52.4",
    colors: resolveDialBoxColors(undefined, "#00aaff"),
  }),
);
writeAsset("dial/dash-box-sample.svg", dashSvg);
entries.push({
  class: "dial",
  family: "shared",
  name: "dash-box-sample",
  path: "packages/iracing-actions/src/shared/dial-box.ts",
  slots: [],
  locked: [],
  actions: [],
  file: "/icon-gallery/dial/dash-box-sample.svg",
  sample: true,
});

mkdirSync(path.dirname(JSON_OUT), { recursive: true });
writeFileSync(JSON_OUT, JSON.stringify(entries, null, 2) + "\n", "utf-8");

const counts = entries.reduce<Record<string, number>>((acc, e) => {
  acc[e.class] = (acc[e.class] ?? 0) + 1;
  return acc;
}, {});
console.log(`Generated ${entries.length} gallery entries:`, counts);
