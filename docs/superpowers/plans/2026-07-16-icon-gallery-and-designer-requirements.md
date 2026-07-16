# Icon Gallery & Designer Requirements Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two pages to iracedeck.com — a build-time-generated gallery of every icon (`/docs/development/icon-gallery/`) and an icon-designer requirements guide (`/docs/development/designing-icons/`).

**Architecture:** A tsx generator script in `packages/website` walks the five artwork classes (388 key templates, 16 dynamic templates, 36 static `key.svg`, 9 `dial.svg` + 1 rendered dash-box sample, 36 category `icon.svg`), composes each key template through the real icon-composer pipeline (`resolveIconColors → resolveTitleSettings → resolveBorderSettings → resolveGraphicSettings → assembleIcon`), and emits gitignored per-icon SVG assets under `public/icon-gallery/` plus one metadata JSON. An Astro component renders the searchable gallery from that JSON. The requirements page is hand-written content.

**Tech Stack:** Astro 7 + Starlight 0.41 (`packages/website`), `@iracedeck/icon-composer` (built dist at runtime, src alias under vitest), `tsx` 4.23.0 (repo-established pattern: `scripts/generate-action-comms.mjs`), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-16-icon-gallery-and-designer-requirements-design.md`

## Global Constraints

- Exact dependency versions only (`.npmrc` has `save-exact=true`); internal packages use `workspace:*`. `tsx` is pinned at `4.23.0` at the repo root — use the same version.
- Generated outputs are **gitignored, never committed**: `packages/website/public/icon-gallery/` and `packages/website/src/data/icon-gallery.json`.
- All fenced code blocks in Markdown content must carry a language identifier.
- Never use raw `\n`-prefixed leading title lines or inline styles in page content; follow existing website page conventions.
- Run `pnpm lint:fix` and `pnpm format:fix` before each commit (pre-commit hook runs lint-staged).
- After any `package.json` dependency change: `pnpm install` and **commit `pnpm-lock.yaml` in the same commit**.
- MDX pages: a bare `<` or `{` breaks the build — wrap literals like `<family>` in backticks.
- Do not touch `packages/icons/preview/` or any icon source.

---

### Task 1: Gallery generator library (pure functions + tests)

**Files:**
- Create: `packages/website/src/gallery-gen/lib.ts`
- Test: `packages/website/src/gallery-gen/lib.test.ts`

**Interfaces:**
- Consumes: `parseIconDefaults`, `parseIconTitleDefaults`, `parseIconLocked`, `renderIconTemplate` from `@iracedeck/icon-composer` (root `vitest.config.ts` already aliases the package to its `src/`, and `include` already covers `packages/*/src/**/*.test.ts` — no config changes needed).
- Produces (used by Task 2's script):
  - `interface GalleryEntry { class: "template" | "dynamic" | "key" | "dial" | "category"; family: string; name: string; path: string; viewBox?: string; slots: string[]; locked: string[]; title?: string; actions: string[]; file: string; sample?: boolean }`
  - `parseTitlesMaps(actionSource: string): Record<string, string>` — merged key→title entries from every `*_TITLES: Record<string, string>` map in one action source file (`\n` escapes decoded to real newlines).
  - `parseIconImports(actionSource: string): string[]` — `"<family>/<name>"` paths from `@iracedeck/icons/<family>/<name>.svg` imports.
  - `extractColorSlots(svg: string): string[]` — which of the four color slots appear as `{{...}}` placeholders.
  - `extractRawViewBox(svg: string): string | undefined` — the literal `viewBox` attribute value.
  - `renderDynamicTemplate(svg: string, sampleValues: Record<string, string>): string` — fills desc default colors + sample values, blanks every leftover `{{token}}`.
  - `DYNAMIC_SAMPLE_DATA: Record<string, Record<string, string>>` — per-template sample values keyed by file basename.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/website/src/gallery-gen/lib.test.ts
import { describe, expect, it } from "vitest";
import {
  DYNAMIC_SAMPLE_DATA,
  extractColorSlots,
  extractRawViewBox,
  parseIconImports,
  parseTitlesMaps,
  renderDynamicTemplate,
} from "./lib.js";

describe("parseTitlesMaps", () => {
  it("extracts quoted keys and decodes \\n escapes", () => {
    const src = `
const AUDIO_CONTROLS_TITLES: Record<string, string> = {
  "push-to-talk": "TALK",
  "voice-chat-volume-up": "VOL UP\\nVOICE",
};
`;
    expect(parseTitlesMaps(src)).toEqual({
      "push-to-talk": "TALK",
      "voice-chat-volume-up": "VOL UP\nVOICE",
    });
  });

  it("extracts unquoted identifier keys and merges multiple maps", () => {
    const src = `
const A_TITLES: Record<string, string> = {
  direct: "DIRECT",
};
const B_TITLES: Record<string, string> = {
  "next-cam": "NEXT\\nCAM",
};
`;
    expect(parseTitlesMaps(src)).toEqual({ direct: "DIRECT", "next-cam": "NEXT\nCAM" });
  });

  it("returns an empty object when no titles map exists", () => {
    expect(parseTitlesMaps("const x = 1;")).toEqual({});
  });
});

describe("parseIconImports", () => {
  it("collects family/name paths from icon imports", () => {
    const src = `
import a from "@iracedeck/icons/audio-controls/push-to-talk.svg";
import b from "@iracedeck/icons/fuel-service/add-fuel.svg";
import { z } from "zod";
`;
    expect(parseIconImports(src)).toEqual(["audio-controls/push-to-talk", "fuel-service/add-fuel"]);
  });

  it("returns an empty array when no icon imports exist", () => {
    expect(parseIconImports(`import { z } from "zod";`)).toEqual([]);
  });
});

describe("extractColorSlots", () => {
  it("returns only the color slots present", () => {
    const svg = `<svg><rect fill="{{backgroundColor}}"/><path fill="{{graphic1Color}}"/><path fill="{{graphic1Color}}"/></svg>`;
    expect(extractColorSlots(svg)).toEqual(["backgroundColor", "graphic1Color"]);
  });

  it("ignores non-color placeholders", () => {
    expect(extractColorSlots(`<svg>{{iconContent}}</svg>`)).toEqual([]);
  });
});

describe("extractRawViewBox", () => {
  it("returns the literal attribute value", () => {
    expect(extractRawViewBox(`<svg viewBox="0 0 110 96"></svg>`)).toBe("0 0 110 96");
  });

  it("returns undefined when absent", () => {
    expect(extractRawViewBox(`<svg></svg>`)).toBeUndefined();
  });
});

describe("renderDynamicTemplate", () => {
  const svg = `<svg viewBox="0 0 144 144"><desc>{"colors":{"backgroundColor":"#101820","textColor":"#ffffff"}}</desc><rect fill="{{backgroundColor}}"/>{{borderDefs}}{{borderContent}}<text fill="{{textColor}}">{{value}}</text>{{iconContent}}</svg>`;

  it("fills desc colors, sample values, and blanks leftover tokens", () => {
    const out = renderDynamicTemplate(svg, { value: "P12" });
    expect(out).toContain(`fill="#101820"`);
    expect(out).toContain(`fill="#ffffff"`);
    expect(out).toContain(">P12<");
    expect(out).not.toContain("{{");
  });

  it("lets sample values win over desc colors", () => {
    const out = renderDynamicTemplate(svg, { backgroundColor: "#000000" });
    expect(out).toContain(`fill="#000000"`);
  });
});

describe("DYNAMIC_SAMPLE_DATA", () => {
  it("has an entry for every known dynamic template", () => {
    expect(Object.keys(DYNAMIC_SAMPLE_DATA).sort()).toEqual([
      "adjust-style",
      "car-control-drs",
      "car-control-pit-limiter",
      "car-control-push-to-pass",
      "fuel-service",
      "pit-crew",
      "pit-quick-actions",
      "pit-quick-actions-fast-repair",
      "pit-quick-actions-windshield",
      "race-admin-car-selector",
      "session-info",
      "setup-brakes-abs-toggle",
      "setup-traction-tc-toggle",
      "setup-view",
      "telemetry-display",
      "tire-service",
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run packages/website/src/gallery-gen/lib.test.ts`
Expected: FAIL — `Cannot find module './lib.js'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

```typescript
// packages/website/src/gallery-gen/lib.ts
/**
 * Pure helpers for the icon-gallery generator (scripts/generate-icon-gallery.mts).
 * Everything here is node-free and unit-testable; the script owns all file IO.
 */
import { parseIconDefaults, renderIconTemplate } from "@iracedeck/icon-composer";

export interface GalleryEntry {
  class: "template" | "dynamic" | "key" | "dial" | "category";
  family: string;
  name: string;
  /** Repo-relative source path, e.g. packages/icons/fuel-service/add-fuel.svg */
  path: string;
  viewBox?: string;
  /** Color-slot placeholders present in the source SVG */
  slots: string[];
  /** Slots declared "locked" in the <desc> metadata */
  locked: string[];
  /** Resolved default title (runtime *_TITLES map entry, falling back to <desc>) */
  title?: string;
  /** Action folder names that import this icon */
  actions: string[];
  /** Site-absolute asset path, e.g. /icon-gallery/template/fuel-service/add-fuel.svg */
  file: string;
  /** True when the rendering used hand-picked sample values (dynamic templates, dash box) */
  sample?: boolean;
}

const COLOR_SLOTS = ["backgroundColor", "textColor", "graphic1Color", "graphic2Color"] as const;

const TITLES_MAP_RE = /const\s+[A-Z0-9_]*_TITLES\s*:\s*Record<string,\s*string>\s*=\s*\{([\s\S]*?)\n\};/g;
const TITLES_ENTRY_RE = /(?:["']([^"']+)["']|([A-Za-z0-9_$-]+))\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/** Merged key→title entries from every `*_TITLES: Record<string, string>` map in an action source file. */
export function parseTitlesMaps(actionSource: string): Record<string, string> {
  const titles: Record<string, string> = {};

  for (const mapMatch of actionSource.matchAll(TITLES_MAP_RE)) {
    for (const entry of mapMatch[1].matchAll(TITLES_ENTRY_RE)) {
      const key = entry[1] ?? entry[2];
      titles[key] = entry[3].replace(/\\n/g, "\n");
    }
  }

  return titles;
}

const ICON_IMPORT_RE = /from\s+["']@iracedeck\/icons\/([^"']+)\.svg["']/g;

/** `"<family>/<name>"` paths of every `@iracedeck/icons` SVG import in an action source file. */
export function parseIconImports(actionSource: string): string[] {
  return [...actionSource.matchAll(ICON_IMPORT_RE)].map((m) => m[1]);
}

/** Which of the four color slots appear as `{{...}}` placeholders in the SVG. */
export function extractColorSlots(svg: string): string[] {
  return COLOR_SLOTS.filter((slot) => svg.includes(`{{${slot}}}`));
}

/** The literal `viewBox` attribute value of the root SVG element. */
export function extractRawViewBox(svg: string): string | undefined {
  return svg.match(/<svg\b[^>]*\bviewBox\s*=\s*"([^"]+)"/i)?.[1];
}

/**
 * Renders a dynamic (telemetry-driven) template for the gallery: <desc> default
 * colors + hand-picked sample values, with every remaining `{{token}}` blanked
 * so no raw placeholder leaks into the output.
 */
export function renderDynamicTemplate(svg: string, sampleValues: Record<string, string>): string {
  const blanks: Record<string, string> = {};

  for (const token of svg.matchAll(/\{\{([A-Za-z0-9]+)\}\}/g)) {
    blanks[token[1]] = "";
  }

  return renderIconTemplate(svg, { ...blanks, ...parseIconDefaults(svg), ...sampleValues });
}

/**
 * Sample values per dynamic template (keyed by file basename). Text-bearing
 * tokens get representative values; artwork tokens (iconContent, graphicContent,
 * warningContent, …) stay blank — that content is drawn live from telemetry, and
 * the gallery card is captioned accordingly.
 */
export const DYNAMIC_SAMPLE_DATA: Record<string, Record<string, string>> = {
  "adjust-style": {},
  "car-control-drs": { titleContent: sampleTitle("DRS") },
  "car-control-pit-limiter": { titleContent: sampleTitle("PIT\nLIMITER") },
  "car-control-push-to-pass": { titleContent: sampleTitle("P2P") },
  "fuel-service": { titleContent: sampleTitle("FUEL\n+10 L") },
  "pit-crew": {},
  "pit-quick-actions": { titleContent: sampleTitle("PIT\nACTIONS") },
  "pit-quick-actions-fast-repair": { titleContent: sampleTitle("FAST\nREPAIR") },
  "pit-quick-actions-windshield": { titleContent: sampleTitle("TEAROFF") },
  "race-admin-car-selector": { titleContent: sampleTitle("CAR") },
  "session-info": { value: "P12", valueFontSize: "64", valueY: "88", titleContent: sampleTitle("POSITION") },
  "setup-brakes-abs-toggle": { titleContent: sampleTitle("ABS") },
  "setup-traction-tc-toggle": { titleContent: sampleTitle("TC") },
  "setup-view": { value: "52.4", valueFontSize: "48", valueY: "84", titleContent: sampleTitle("BIAS") },
  "telemetry-display": { titleContent: sampleTitle("SPEED") },
  "tire-service": { textElement: "" },
};

/** A minimal centered title block matching the composed-icon look (18px bold, bottom-anchored). */
function sampleTitle(text: string): string {
  const lines = text.split("\n");

  return lines
    .map(
      (line, i) =>
        `<text x="72" y="${118 + i * 20 - (lines.length - 1) * 20}" font-family="Arial, sans-serif" font-size="18" font-weight="bold" fill="#ffffff" text-anchor="middle">${line}</text>`,
    )
    .join("");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/website/src/gallery-gen/lib.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Lint, format, commit**

```bash
pnpm lint:fix && pnpm format:fix
git add packages/website/src/gallery-gen/
git commit -m "feat(website): icon gallery generator library"
```

---

### Task 2: Generator script — compose and emit assets + metadata

**Files:**
- Create: `packages/website/scripts/generate-icon-gallery.mts`
- Modify: `packages/website/package.json` (devDependencies + `generate:gallery` script)
- Modify: `packages/website/.gitignore` (generated outputs)
- Modify: `pnpm-lock.yaml` (via `pnpm install`)

**Interfaces:**
- Consumes: everything Task 1 `Produces`; `assembleIcon`, `resolveIconColors`, `resolveTitleSettings`, `resolveBorderSettings`, `resolveGraphicSettings`, `parseIconTitleDefaults`, `parseIconLocked`, `isDataUri`, `dataUriToSvg` from `@iracedeck/icon-composer`; `renderDialBox`, `resolveDialBoxColors` from `packages/iracing-actions/src/shared/dial-box.ts` (relative TS import — tsx compiles it; its own `@iracedeck/deck-core`/`zod` imports resolve from that package's node_modules).
- Produces: `packages/website/public/icon-gallery/<class>/.../*.svg` assets and `packages/website/src/data/icon-gallery.json` (a `GalleryEntry[]`), consumed by Task 4's Astro component.

- [ ] **Step 1: Add dependencies and gitignore entries**

In `packages/website/package.json`, add to `"scripts"`:

```json
"generate:gallery": "tsx scripts/generate-icon-gallery.mts"
```

and add a `devDependencies` section (keep `firebase-tools` where it is):

```json
"devDependencies": {
  "@iracedeck/deck-core": "workspace:*",
  "@iracedeck/icon-composer": "workspace:*",
  "firebase-tools": "15.23.0",
  "tsx": "4.23.0"
}
```

(`@iracedeck/deck-core` and `@iracedeck/icon-composer` exist so turbo's `^build` builds both dists before any website task; `dial-box.ts` needs deck-core's dist at generator runtime.)

Append to `packages/website/.gitignore`:

```gitignore
# Generated icon gallery (regenerated on every build — see scripts/generate-icon-gallery.mts)
public/icon-gallery/
src/data/icon-gallery.json
```

Run: `pnpm install`
Expected: lockfile updates, no errors.

- [ ] **Step 2: Write the generator script**

```typescript
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
      locked: parseIconLocked(svg),
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
    locked: parseIconLocked(svg),
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
```

- [ ] **Step 3: Build workspace deps, run the generator, verify counts**

```bash
pnpm --filter @iracedeck/icon-composer --filter @iracedeck/deck-core build
pnpm --filter @iracedeck/website generate:gallery
```

Expected output (exact counts as of this plan; if icons were added since, numbers may be slightly higher — the split must still be template/dynamic/key/dial/category):

```text
Generated 486 gallery entries: { template: 388, dynamic: 16, key: 36, dial: 10, category: 36 }
```

- [ ] **Step 4: Spot-check three emitted assets**

```bash
head -c 300 packages/website/public/icon-gallery/template/fuel-service/add-fuel.svg
head -c 300 packages/website/public/icon-gallery/dynamic/session-info.svg
head -c 300 packages/website/public/icon-gallery/dial/dash-box-sample.svg
```

Expected: each is a raw `<svg ...>` document (no `{{` placeholders, no `data:` prefix); `template/fuel-service/add-fuel.svg` contains a `<text` element (the composed "ADD FUEL" title); open one in a browser and confirm it looks like a real key.

- [ ] **Step 5: Verify git ignores the outputs, then commit**

```bash
git status --porcelain packages/website/public/icon-gallery packages/website/src/data/icon-gallery.json
```

Expected: no output (both paths ignored).

```bash
pnpm lint:fix && pnpm format:fix
git add packages/website/scripts/generate-icon-gallery.mts packages/website/package.json packages/website/.gitignore pnpm-lock.yaml
git commit -m "feat(website): icon gallery generator script"
```

---

### Task 3: Wire the generator into the website dev/build scripts

**Files:**
- Modify: `packages/website/package.json` (scripts)

**Interfaces:**
- Consumes: Task 2's `generate:gallery` script.
- Produces: `pnpm --filter @iracedeck/website build` (and `dev`) always regenerate the gallery first — Tasks 4–6 rely on this.

- [ ] **Step 1: Chain the generator into dev and build**

In `packages/website/package.json`, change the scripts (pnpm does not run npm `pre` scripts by default, so chain explicitly):

```json
"scripts": {
  "dev": "pnpm generate:gallery && astro dev",
  "build": "pnpm generate:gallery && astro build",
  "generate:gallery": "tsx scripts/generate-icon-gallery.mts",
  "preview": "astro preview",
  "deploy": "pnpm build && firebase deploy --only hosting"
}
```

(Note `deploy` now routes through the package's own `build` so a deploy can never ship without regenerating.)

- [ ] **Step 2: Verify the full website build passes**

Run: `pnpm --filter @iracedeck/website build`
Expected: generator counts line, then `astro build` completes with no errors (the JSON/data isn't consumed by any page yet — this proves the chain and that Astro tolerates the new files).

- [ ] **Step 3: Commit**

```bash
git add packages/website/package.json
git commit -m "feat(website): regenerate icon gallery on every dev/build"
```

---

### Task 4: Gallery component, page, and sidebar entry

**Files:**
- Create: `packages/website/src/components/IconGallery.astro`
- Create: `packages/website/src/content/docs/docs/development/icon-gallery.mdx`
- Modify: `packages/website/astro.config.mjs` (sidebar `Development` items, around line 214)

**Interfaces:**
- Consumes: `src/data/icon-gallery.json` (`GalleryEntry[]`, Task 2).
- Produces: the `/docs/development/icon-gallery/` page.

- [ ] **Step 1: Write the component**

```astro
---
// packages/website/src/components/IconGallery.astro
// Renders the generated icon inventory (src/data/icon-gallery.json) as a
// searchable, per-family grouped gallery. Assets live in /icon-gallery/.
import entries from "../data/icon-gallery.json";

interface Entry {
  class: string;
  family: string;
  name: string;
  path: string;
  viewBox?: string;
  slots: string[];
  locked: string[];
  title?: string;
  actions: string[];
  file: string;
  sample?: boolean;
}

const CLASS_SECTIONS: { id: string; label: string; blurb: string }[] = [
  { id: "template", label: "Key icon templates", blurb: "The main icon library — artwork snippets composed with titles, colors, and borders at runtime, shown here with their defaults." },
  { id: "dynamic", label: "Dynamic templates", blurb: "Telemetry-driven full-canvas templates. Cards show the template frame with sample values; live content is drawn from telemetry at runtime." },
  { id: "key", label: "Static default key images", blurb: "The default key image each action shows before it renders." },
  { id: "dial", label: "Dial icons", blurb: "Per-action encoder icons plus a sample of the shared touch-strip dash box." },
  { id: "category", label: "Category icons", blurb: "The small 20×20 icons shown in the deck app's action list." },
];

const all = entries as Entry[];

function familiesOf(cls: string): [string, Entry[]][] {
  const map = new Map<string, Entry[]>();
  for (const e of all.filter((e) => e.class === cls)) {
    map.set(e.family, [...(map.get(e.family) ?? []), e]);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function searchText(e: Entry): string {
  return [e.name, e.family, e.title ?? "", ...e.actions].join(" ").toLowerCase();
}
---

<div class="icon-gallery">
  <p>
    <input id="icon-gallery-filter" type="search" placeholder="Filter by name, family, action, or title…" aria-label="Filter icons" />
    <span id="icon-gallery-count">{all.length} icons</span>
  </p>

  {CLASS_SECTIONS.map((section) => (
    <section class="gallery-class" data-class={section.id}>
      <h2 id={`class-${section.id}`}>{section.label}</h2>
      <p>{section.blurb}</p>
      {familiesOf(section.id).map(([family, icons]) => (
        <div class="gallery-family">
          <h3>{family} <span class="family-count">({icons.length})</span></h3>
          <div class="gallery-grid">
            {icons.map((e) => (
              <details class="icon-card" data-search={searchText(e)}>
                <summary>
                  <span class="icon-tile"><img src={e.file} alt={e.name} loading="lazy" width="72" height="72" /></span>
                  <span class="icon-name">{e.name}{e.sample && <em> (sample)</em>}</span>
                </summary>
                <dl>
                  <dt>Path</dt><dd><code>{e.path}</code></dd>
                  {e.viewBox && <><dt>viewBox</dt><dd><code>{e.viewBox}</code></dd></>}
                  {e.slots.length > 0 && <><dt>Color slots</dt><dd><code>{e.slots.join(", ")}</code></dd></>}
                  {e.locked.length > 0 && <><dt>Locked slots</dt><dd><code>{e.locked.join(", ")}</code></dd></>}
                  {e.title && <><dt>Default title</dt><dd class="title-text">{e.title}</dd></>}
                  {e.actions.length > 0 && <><dt>Used by</dt><dd>{e.actions.join(", ")}</dd></>}
                </dl>
              </details>
            ))}
          </div>
        </div>
      ))}
    </section>
  ))}
</div>

<script>
  const filter = document.getElementById("icon-gallery-filter") as HTMLInputElement | null;
  const count = document.getElementById("icon-gallery-count");

  filter?.addEventListener("input", () => {
    const q = filter.value.trim().toLowerCase();
    let visible = 0;

    for (const card of document.querySelectorAll<HTMLElement>(".icon-card")) {
      const hit = !q || (card.dataset.search ?? "").includes(q);
      card.hidden = !hit;
      if (hit) visible++;
    }
    for (const group of document.querySelectorAll<HTMLElement>(".gallery-family")) {
      group.hidden = !group.querySelector(".icon-card:not([hidden])");
    }
    for (const section of document.querySelectorAll<HTMLElement>(".gallery-class")) {
      section.hidden = !section.querySelector(".icon-card:not([hidden])");
    }
    if (count) count.textContent = `${visible} icons`;
  });
</script>

<style>
  #icon-gallery-filter {
    width: 100%;
    max-width: 24rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--sl-color-gray-4);
    border-radius: 0.4rem;
    background: var(--sl-color-bg);
    color: var(--sl-color-text);
  }
  #icon-gallery-count {
    margin-left: 0.75rem;
    color: var(--sl-color-gray-3);
    font-size: var(--sl-text-sm);
  }
  .gallery-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
    gap: 0.5rem;
  }
  .icon-card {
    border: 1px solid var(--sl-color-gray-5);
    border-radius: 0.5rem;
    padding: 0.4rem;
  }
  .icon-card summary {
    cursor: pointer;
    list-style: none;
    text-align: center;
  }
  .icon-tile {
    display: inline-block;
    background: #0d0d0d;
    border-radius: 0.6rem;
    padding: 0.4rem;
    line-height: 0;
  }
  .icon-tile img {
    width: 72px;
    height: 72px;
    max-width: 100%;
    object-fit: contain;
  }
  .icon-name {
    display: block;
    margin-top: 0.3rem;
    font-size: var(--sl-text-xs);
    word-break: break-word;
  }
  .icon-card dl {
    font-size: var(--sl-text-xs);
    margin: 0.5rem 0 0;
  }
  .icon-card dt {
    font-weight: 600;
    margin-top: 0.3rem;
  }
  .icon-card dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .title-text {
    white-space: pre-line;
  }
  .family-count {
    color: var(--sl-color-gray-3);
    font-weight: normal;
  }
</style>
```

- [ ] **Step 2: Write the page**

```mdx
---
title: Icon Gallery
description: Every icon shipped with iRaceDeck — key icon templates, dynamic templates, static key images, dial icons, and category icons — with technical metadata for designers.
---

import IconGallery from "../../../../components/IconGallery.astro";

Every icon that ships with iRaceDeck, rendered through the same composition pipeline the plugin uses on a real deck (default colors, titles, and borders). Click any card for its technical details — source path, viewBox, color slots, locked slots, default title, and the actions that use it.

Designing icons for iRaceDeck? Read the [designing icons guide](/docs/development/designing-icons/) for the format and file-structure requirements.

This page is generated from the icon sources on every site build, so it always matches the current release branch.

<IconGallery />
```

Save as `packages/website/src/content/docs/docs/development/icon-gallery.mdx`. (The relative import depth is `content/docs/docs/development` → four levels up to `src/`.)

- [ ] **Step 3: Add the sidebar entry**

In `packages/website/astro.config.mjs`, inside the `label: "Development"` items array (after `{ slug: "docs/development/feature-flags" }`):

```javascript
{ slug: "docs/development/feature-flags" },
{ slug: "docs/development/icon-gallery" },
```

- [ ] **Step 4: Build and verify the page**

Run: `pnpm --filter @iracedeck/website build`
Expected: build succeeds.

```bash
grep -c "icon-card" packages/website/dist/docs/development/icon-gallery/index.html
grep -o "add-fuel" packages/website/dist/docs/development/icon-gallery/index.html | head -1
```

Expected: first command prints a number in the hundreds (≥ 400); second prints `add-fuel`. Then `pnpm --filter @iracedeck/website preview` and eyeball `/docs/development/icon-gallery/` in both themes: tiles render, filter box narrows cards, a card expands to its metadata.

- [ ] **Step 5: Commit**

```bash
pnpm lint:fix && pnpm format:fix
git add packages/website/src/components/IconGallery.astro packages/website/src/content/docs/docs/development/icon-gallery.mdx packages/website/astro.config.mjs
git commit -m "feat(website): icon gallery page in the developer docs"
```

---

### Task 5: Designing-icons guide page

**Files:**
- Create: `packages/website/src/content/docs/docs/development/designing-icons.md`
- Modify: `packages/website/astro.config.mjs` (sidebar entry after `icon-gallery`)

**Interfaces:**
- Consumes: links to Task 4's `/docs/development/icon-gallery/`.
- Produces: the `/docs/development/designing-icons/` page.

- [ ] **Step 1: Write the page (complete content below)**

````markdown
---
title: Designing Icons
description: Format, file structure, and technical requirements for designing icons or a full alternative icon set for iRaceDeck.
---

Want to design icons for iRaceDeck — a few replacements or a whole alternative set? This page is the contract: what an icon file must look like, how files are named and organized, and what happens to your artwork at runtime. The [icon gallery](/docs/development/icon-gallery/) is the authoritative inventory of everything a set can cover.

## Icons are artwork snippets, not finished keys

An iRaceDeck icon is **only the artwork**. The plugin composes the final key at runtime: it places your artwork on a background, adds the title text, and draws an optional border — all user-configurable. That means:

- **No background rectangle.** The plugin draws the background; your SVG contains just the graphic.
- **No title text baked into the artwork.** Titles are rendered by the plugin (users can restyle, move, or hide them). Text that is an integral part of the *graphic* (like the word "START" on a starter button) is fine.
- **Trimmed viewBox.** The `viewBox` hugs the artwork extent plus a 1-unit margin on every side so strokes don't clip. Don't leave a full-canvas viewBox around small artwork — the composer scales artwork by its viewBox.
- **Stroke weights at reference scale.** Author strokes as if the canvas were 144×144: 4–5px for main shapes, 2–3px for details. The composer keeps proportions correct at any trimmed size.

## Color slots

Icons can expose up to four recolorable slots as literal `{{placeholder}}` strings in fill/stroke attributes. Users can then recolor your set globally or per key:

| Slot | Placeholder | Typical use |
|------|-------------|-------------|
| Background | `{{backgroundColor}}` | Background rect fill (rare inside artwork) |
| Text | `{{textColor}}` | Label text fills |
| Primary graphic | `{{graphic1Color}}` | Main artwork strokes/fills |
| Secondary graphic | `{{graphic2Color}}` | Accent shapes (rare) |

Fixed colors are equally valid — semantic data colors must stay fixed: green `#2ecc71`, red `#e74c3c`, yellow `#f39c12`, blue `#3498db`, purple `#9b59b6`, white `#ffffff`, gray `#888888`.

## The `<desc>` metadata block

Every icon carries a first-child `<desc>` element with a JSON object declaring its defaults:

```json
{
  "colors": { "backgroundColor": "#3a2a2a", "textColor": "#ffffff", "graphic1Color": "#ffffff" },
  "locked": ["graphic1Color"],
  "title": { "text": "ADD FUEL\n+1 L" },
  "border": { "color": "#6a5a5a" }
}
```

- `colors` — the default value for each slot the icon uses.
- `locked` — slots that global color presets must not override (use when your artwork mixes a recolorable slot with hardcoded semantic colors that would clash under user presets).
- `title.text` — the icon's default title (`\n` for a second line; never start with `\n`).
- `border.color` — the default border color when the user enables borders.

## Renderer constraints

Icons are rasterized by [resvg](https://github.com/linebender/resvg). Safe, always-supported features: basic shapes, paths, `text`/`tspan`, gradients, `defs`/`use`/`g`, transforms, opacity, stroke properties, `viewBox`. **Never use:** `<style>` elements or CSS classes, `textPath`, animations, scripts, or external references. Keep effects like filters and masks to progressive enhancement — they must not carry essential information.

## File structure and naming — mirror the default set exactly

The default set lives in family folders, one SVG per icon variant:

```text
<family>/<variant>.svg        e.g. fuel-service/add-fuel.svg
```

An alternative icon set must **mirror these paths and names exactly** — the path is the key the plugin uses to match your icon to its slot, and any icon your set doesn't provide falls back to the default artwork. Browse every family, name, and current design in the [icon gallery](/docs/development/icon-gallery/).

## Scope of a v1 icon set

- **In scope:** the key icon templates (the "Key icon templates" section of the gallery — the vast majority of what users see).
- **Out of scope for now (stays default):** dynamic telemetry-driven templates, static default key images, dial icons, and category icons. These are documented in the gallery for completeness and may open up to sets later.

## How a set ships

Alternative icon sets are bundled with the plugin and selected via a dropdown in the plugin's global settings. Matching is per icon with automatic fallback to the default set — so a partial set works fine, and a set can grow release by release.

## Delivering a set

Hand over a zip (or a pull request) preserving the `family/variant.svg` structure. Artwork you contribute ships inside the plugin, so it needs a license compatible with redistribution — talk to us on [Discord](https://discord.gg/c6nRYywpah) and we'll sort out attribution and terms together.
````

- [ ] **Step 2: Add the sidebar entry**

In `packages/website/astro.config.mjs`, directly after the entry added in Task 4:

```javascript
{ slug: "docs/development/icon-gallery" },
{ slug: "docs/development/designing-icons" },
```

- [ ] **Step 3: Build and verify**

Run: `pnpm --filter @iracedeck/website build`
Expected: build succeeds; `packages/website/dist/docs/development/designing-icons/index.html` exists and contains "mirror these paths".

```bash
grep -o "mirror these paths" packages/website/dist/docs/development/designing-icons/index.html
```

- [ ] **Step 4: Commit**

```bash
pnpm lint:fix && pnpm format:fix
git add packages/website/src/content/docs/docs/development/designing-icons.md packages/website/astro.config.mjs
git commit -m "docs(website): designing-icons guide for icon set contributors"
```

---

### Task 6: Changelog entry and docs sync

**Files:**
- Modify: `packages/website/src/content/docs/changelog.mdx` (the `## 2.2.0` section)
- Check/modify: `.claude/skills/website/SKILL.md` (only if it enumerates development pages)

**Interfaces:**
- Consumes: nothing new.
- Produces: the release-notes line for this change.

- [ ] **Step 1: Add the changelog line**

In `packages/website/src/content/docs/changelog.mdx`, under `## 2.2.0`, add an `**Improvements**` section between the existing `**Features**` and `**Bug Fixes**` sections (the fixed category order is Features, Improvements, Bug Fixes, Breaking changes, Maintenance):

```markdown
**Improvements**

- The developer documentation on iracedeck.com now includes a searchable gallery of every icon shipped with the plugin, plus a designing-icons guide for contributing custom icons or a full alternative icon set.
```

- [ ] **Step 2: Sync the website skill if needed**

```bash
grep -n "development" .claude/skills/website/SKILL.md
```

If the skill lists the development docs pages, add `icon-gallery` and `designing-icons` entries in the same style; if it only describes the site generally (expected), no change. `README.md` and the architecture page need no update: no package, seam, or action count changed (the generator is website-internal tooling).

- [ ] **Step 3: Build and commit**

Run: `pnpm --filter @iracedeck/website build`
Expected: success (changelog MDX still parses).

```bash
git add packages/website/src/content/docs/changelog.mdx .claude/skills/website/SKILL.md
git commit -m "docs(changelog): icon gallery and designing-icons pages"
```

(Drop the SKILL.md path from `git add` if it wasn't modified.)

---

### Task 7: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full workspace checks**

```bash
pnpm build
pnpm test
pnpm lint
pnpm format
```

Expected: all pass. (If the deck host app is running and the native build fails with EPERM on `iracing_native.node`, quit the host app and rerun — known lock issue.)

- [ ] **Step 2: Fidelity spot-check against the plugin**

Open `/docs/development/icon-gallery/` via `pnpm --filter @iracedeck/website preview` and compare three known keys (e.g. `fuel-service/add-fuel`, `black-box-selector` family, one `setup-*` icon) against how the same actions render on the deck / in the #827 review-gallery artifact. Titles, colors, and borders must match the plugin defaults.

- [ ] **Step 3: Verify the worktree is clean and the branch is push-ready**

```bash
git status
git log --oneline master..HEAD
```

Expected: clean tree; one commit per completed task. **Stop here — no push, no PR, until Niklas has reviewed the pages locally** (per workflow rules).

---

## Self-Review Notes

- **Spec coverage:** gallery pipeline (Tasks 1–3), gallery page (Task 4), requirements page including v1 scope + how-it-ships + licensing (Task 5), changelog + docs sync (Task 6), verification incl. fidelity spot-check (Task 7). The icon-set feature itself is spec'd as direction-only — deliberately absent here.
- **Dynamic templates:** rendered as template frame + sample text values with live-content tokens blank, captioned "(sample)" — matches the spec's "representative sample data" honestly without inventing fake telemetry artwork.
- **Counts** (388/16/36/9+1/36 = 486) are as of 2026-07-16; the expected-output note in Task 2 allows for icons added later.
