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

import { renderAudioStripSvg } from "../../iracing-actions/src/actions/audio-controls/audio-dial-surface.ts";
import { renderBlackBoxStrip } from "../../iracing-actions/src/actions/black-box-selector/black-box-selector-dial-surface.ts";
import { renderCarCarousel } from "../../iracing-actions/src/actions/camera-controls/camera-dial-surface.ts";
import { renderStripCanvasSvg } from "../../iracing-actions/src/actions/fuel-service/fuel-dial-surface.ts";
import { statusBarOn } from "../../iracing-actions/src/icons/status-bar.ts";
import { renderDialBox, resolveDialBoxColors } from "../../iracing-actions/src/shared/dial-box.ts";
import {
  DYNAMIC_SAMPLE_DATA,
  extractColorSlots,
  extractRawViewBox,
  parseIconImports,
  parseTitlesMaps,
  renderDynamicTemplate,
  sampleTitle,
  type GalleryEntry,
} from "../src/gallery-gen/lib.js";
import { DYNAMIC_ONLY_ACTIONS, titleCaseSlug } from "../src/gallery-gen/sections.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const ICONS_ROOT = path.join(REPO_ROOT, "packages", "icons");
const ACTIONS_ROOT = path.join(REPO_ROOT, "packages", "iracing-actions", "src", "actions");
const DYNAMIC_ROOT = path.join(REPO_ROOT, "packages", "iracing-actions", "icons");
const MANIFEST_PATH = path.join(
  REPO_ROOT,
  "packages",
  "iracing-plugin-stream-deck",
  "com.iracedeck.sd.core.sdPlugin",
  "manifest.json",
);
const ASSETS_OUT = path.join(__dirname, "..", "public", "icon-gallery");
const JSON_OUT = path.join(__dirname, "..", "src", "data", "icon-gallery.json");

const NON_FAMILY_DIRS = new Set(["preview", "src", "node_modules"]);

/**
 * Dynamic templates whose owning action composes a tri-state status bar
 * (`statusBarOn`/`statusBarOff`/`statusBarNA` via `../../icons/status-bar.js`,
 * directly or through the shared `generateToggleStateSvg`) into `iconContent`
 * at runtime — verified against each owning action's source (issue: gallery
 * feedback wave, item 4):
 *   - car-control.ts: DRS, Pit Limiter, and Push-to-Pass all call statusBarOn/
 *     Off/NA directly (car-control-drs, car-control-pit-limiter, car-control-push-to-pass).
 *   - pit-quick-actions.ts: the base action plus both tri-state sub-actions call
 *     statusBarOn/Off/NA directly (pit-quick-actions, pit-quick-actions-fast-repair,
 *     pit-quick-actions-windshield).
 *   - setup-brakes.ts / setup-traction.ts: the ABS/TC toggle sub-actions route
 *     through the shared generateToggleStateSvg (setup-brakes-abs-toggle,
 *     setup-traction-tc-toggle).
 * Every other dynamic template's owning action (race-admin, session-info,
 * tire-service, adjust-styles, setup-view, telemetry-display) has no status-bar
 * import — confirmed by grep.
 */
const STATUS_BAR_TEMPLATES = new Set([
  "car-control-drs",
  "car-control-pit-limiter",
  "car-control-push-to-pass",
  "pit-quick-actions",
  "pit-quick-actions-fast-repair",
  "pit-quick-actions-windshield",
  "setup-brakes-abs-toggle",
  "setup-traction-tc-toggle",
]);

/**
 * Sample abbreviation/accent/value for each Setup dial surface's default
 * rotation setting (issue: gallery feedback wave, item 5). Each surface owns
 * its own unexported `MODE_ABBR`/`MODE_COLOR` maps, so these are read off the
 * source directly rather than imported. Source lines as of this change:
 *   - setup-brakes-dial-surface.ts: DialSettings.setting default "brake-bias"
 *     (setup-brakes-settings.ts) -> MODE_ABBR "BB", MODE_COLOR "#e74c3c";
 *     value-bearing (view-brake-bias formats via formatPercentRaw).
 *   - setup-traction-dial-surface.ts: default "tc-slot-1" -> MODE_ABBR "TC1",
 *     MODE_COLOR "#3498db"; value-bearing (view-tc-slot-1, formatInteger).
 *   - setup-fuel-dial-surface.ts: default "fuel-mixture" -> MODE_ABBR "MIX",
 *     MODE_COLOR "#e67e22"; value-bearing (view-fuel-mixture, formatInteger).
 *   - setup-engine-dial-surface.ts: default "engine-power" -> MODE_ABBR "POWER",
 *     MODE_COLOR "#e74c3c"; value-bearing (view-engine-power, formatInteger).
 *   - setup-aero-dial-surface.ts: default "front-wing" -> MODE_ABBR "FRONT",
 *     MODE_COLOR "#3498db"; value-bearing (view-front-wing, formatInteger).
 *   - setup-chassis-dial-surface.ts: default "differential-preload" -> MODE_ABBR
 *     "PRELD", MODE_COLOR "#3498db"; value-bearing (view-diff-preload, formatInteger).
 *   - setup-hybrid-dial-surface.ts: default "mguk-deploy-mode" -> MODE_ABBR
 *     "DEPLOY", MODE_COLOR "#3498db"; value-bearing (view-mguk-deploy-mode, formatInteger).
 */
/**
 * Pit Crew renders TWO of its three `mode` settings as tri-state toggle
 * buttons with a status-bar on/off indicator — `race-engineer` and `radar`
 * (pit-crew.ts `modePresentation()`, lines ~211-234: both return a
 * `stateIndicator` of `"on"`/`"off"`). The third mode, `radar-volume`, is a
 * +/- stepper with no status bar (`stateIndicator: null`) so it gets no
 * distinct sample (gallery restructure wave, item 2's investigation).
 *
 * pit-crew.svg (the physical dynamic template both modes share) exposes only
 * ONE `{{iconContent}}` placeholder — no separate `{{titleContent}}` token —
 * because the real action bakes title + artwork + status bar into
 * `iconContent` itself (`generatePitCrewSvg()`, lines ~243-303: `iconContent =
 * scaledGraphic + titleText + statusBar`). So each gallery sample supplies the
 * full `iconContent` as a sample title (bottomY 92, clear of the status bar,
 * matching `STATUS_BAR_TEMPLATES`' convention) plus `statusBarOn()`, leaving
 * the artwork blank like every other dynamic-template sample.
 */
const PIT_CREW_SAMPLES: { key: string; title: string }[] = [
  { key: "pit-crew-engineer", title: "RACE\nENGINEER" },
  { key: "pit-crew-radar", title: "RADAR" },
  { key: "pit-crew-corner-names", title: "CORNER\nNAMES" },
];

interface DialBoxSampleSpec {
  key: string;
  abbr: string;
  accent: string;
  value: string;
  /** Only meaningful for identity-only specs (`value: ""`) — see `renderDialBox`'s `identityLabelScale`. */
  identityLabelScale?: number;
}

const SETUP_DIAL_SAMPLES: DialBoxSampleSpec[] = [
  { key: "setup-brakes", abbr: "BB", accent: "#e74c3c", value: "52.4" },
  { key: "setup-traction", abbr: "TC1", accent: "#3498db", value: "5" },
  { key: "setup-fuel", abbr: "MIX", accent: "#e67e22", value: "3" },
  { key: "setup-engine", abbr: "POWER", accent: "#e74c3c", value: "8" },
  { key: "setup-aero", abbr: "FRONT", accent: "#3498db", value: "4" },
  { key: "setup-chassis", abbr: "PRELD", accent: "#3498db", value: "45" },
  { key: "setup-hybrid", abbr: "DEPLOY", accent: "#3498db", value: "2" },
];

/**
 * Sample abbreviation/accent/value for five of the seven newly merged
 * (#802–#807) dial surfaces that ALSO render through the shared
 * `renderDialBox` — same unexported-per-surface-map convention as
 * `SETUP_DIAL_SAMPLES` above (each surface owns its own `MODE_ABBR`/
 * `MODE_COLOR`, so these are read off the source directly). The other two new
 * surfaces (`camera-controls` / `camera-focus-dash` and `black-box-selector`)
 * own custom strip renderers and are emitted separately below. Source lines as
 * of this change:
 *   - force-feedback-dial-surface.ts: DialSettings.setting default "ffb-force"
 *     -> MODE_ABBR "FFB", MODE_COLOR "#4fc3f7"; value-bearing (formatDialValue
 *     formats the live `SteeringWheelMaxForceNm` as "XX.X Nm").
 *   - camera-editor-adjustments-dial-surface.ts: DialSettings.setting default
 *     "latitude" -> MODE_LABEL "Latitude" (the full mixed-case name is used
 *     verbatim as the dash-box abbr, not an acronym), MODE_COLOR "#3498db";
 *     identity-only (formatDialValue is a hardcoded "" — iRacing exposes no
 *     camera-tool telemetry), scale from identityLabelScaleFor("Latitude") =
 *     0.18 (length 8 <= 8).
 *   - cockpit-misc-dial-surface.ts: DialSettings.setting default "dash-page-1"
 *     -> MODE_ABBR "DASH 1", MODE_COLOR "#3498db"; value-bearing
 *     (formatDialValue reads the live `dcDashPage` field via the shared
 *     formatInteger from shared/setup-view.ts).
 *   - view-adjustment-dial-surface.ts: DialSettings.setting default "fov" ->
 *     MODE_ABBR "FOV", MODE_COLOR "#3498db"; identity-only (formatDialValue is
 *     a hardcoded "" — iRacing exposes no view-adjustment telemetry), scale
 *     0.24 (the renderFeedback call's explicit identityLabelScale).
 *   - splits-delta-cycle-dial-surface.ts: no `dial.setting` at all (a single
 *     rotation behavior) -> IDENTITY_ABBR "DELTA", ACCENT_COLOR "#9b59b6";
 *     identity-only (the surface never subscribes to telemetry), default
 *     scale 0.24 (renderFeedback omits identityLabelScale).
 */
const DIAL_BOX_SAMPLES: DialBoxSampleSpec[] = [
  { key: "force-feedback", abbr: "FFB", accent: "#4fc3f7", value: "46.4 Nm" },
  { key: "camera-editor-adjustments", abbr: "Latitude", accent: "#3498db", value: "", identityLabelScale: 0.18 },
  { key: "cockpit-misc", abbr: "DASH 1", accent: "#3498db", value: "2" },
  { key: "view-adjustment", abbr: "FOV", accent: "#3498db", value: "", identityLabelScale: 0.24 },
  { key: "splits-delta-cycle", abbr: "DELTA", accent: "#9b59b6", value: "", identityLabelScale: 0.24 },
];

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

/** The device screen color behind every dial touch-strip slot. */
const DIAL_SCREEN_BACKGROUND = "#0d0d0d";

/**
 * Bakes the device-black touch-strip screen into a dash-box render.
 * `renderDialBox`/`renderStripCanvasSvg`/`renderAudioStripSvg` all
 * deliberately leave the OUTER margin of their canvas transparent — on the
 * device that margin IS the black touch-strip screen, but on the web page the
 * transparency shows the page background through instead (issue: gallery
 * feedback wave, item 14). Inserts the background rect immediately after the
 * opening `<svg>` tag so it always paints first, beneath the real content.
 */
function bakeDialScreenBackground(svg: string, width: number, height: number): string {
  return svg.replace(
    /(<svg\b[^>]*>)/,
    `$1<rect x="0" y="0" width="${width}" height="${height}" fill="${DIAL_SCREEN_BACKGROUND}"/>`,
  );
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
// Parse the Elgato manifest once for human-friendly template family names
// (issue: gallery feedback wave, item 11). `actionDisplayName` is keyed by the
// UUID suffix (`com.iracedeck.sd.core.<suffix>` -> `Name`) exactly as the
// manifest declares it — which is USUALLY the action's folder name, but not
// always (see the `camera-focus` case documented at its use site below).
// ---------------------------------------------------------------------------
interface ManifestAction {
  UUID: string;
  Name: string;
  VisibleInActionsList?: boolean;
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as { Actions: ManifestAction[] };
const UUID_PREFIX = "com.iracedeck.sd.core.";
const actionDisplayName = new Map<string, string>();
/**
 * Action folder names (well, UUID suffixes — see the note above) hidden from
 * the deck app's action list (`VisibleInActionsList: false`, e.g. the legacy
 * Camera Cycle action and the three Replay sub-actions). The owner asked for
 * these off the gallery page too (issue: gallery feedback wave, item 13).
 */
const hiddenActions = new Set<string>();

for (const action of manifest.Actions) {
  if (!action.UUID.startsWith(UUID_PREFIX)) continue;
  const folder = action.UUID.slice(UUID_PREFIX.length);
  actionDisplayName.set(folder, action.Name);
  if (action.VisibleInActionsList === false) hiddenActions.add(folder);
}

/**
 * Resolves a template family's human-friendly display name: the manifest
 * `Name` when the family slug itself is a key in `actionDisplayName` (i.e. it
 * matches some action's UUID suffix), otherwise a title-cased fallback of the
 * slug — NEVER a consuming action's name for the fallback case, so sibling
 * families served by the same action (e.g. `camera-cycle` / `camera-select`)
 * can't collide (issue: gallery feedback wave, item 11).
 */
function resolveFamilyName(family: string): string {
  return actionDisplayName.get(family) ?? titleCaseSlug(family);
}

// ---------------------------------------------------------------------------
// Emit.
// ---------------------------------------------------------------------------
rmSync(ASSETS_OUT, { recursive: true, force: true });
const entries: GalleryEntry[] = [];
const skippedTemplates: string[] = [];
const excludedHidden: string[] = [];

// 1. Key icon templates — full composition through the real pipeline. Orphan
// templates (imported by no action) are skipped rather than shown as stale
// artwork in the designer inventory (issue: gallery feedback wave, item 8).
for (const familyDirent of readdirSync(ICONS_ROOT, { withFileTypes: true })) {
  if (!familyDirent.isDirectory() || NON_FAMILY_DIRS.has(familyDirent.name)) continue;
  const family = familyDirent.name;
  const familyName = resolveFamilyName(family);

  for (const file of readdirSync(path.join(ICONS_ROOT, family))) {
    if (!file.endsWith(".svg")) continue;
    const name = file.slice(0, -4);
    const iconPath = `${family}/${name}`;
    const consumers = actionsByIcon.get(iconPath) ?? [];

    if (consumers.length === 0) {
      skippedTemplates.push(iconPath);
      continue;
    }

    // Exclude when EVERY consuming action is hidden (issue: gallery feedback
    // wave, item 13) — e.g. replay-navigation/* is consumed solely by the
    // hidden replay-navigation action itself. OR exclude when the FAMILY slug
    // itself is a hidden action's folder name, regardless of consumers
    // (gallery restructure wave, item 1) — camera-cycle/* is consumed solely
    // by the VISIBLE "camera-controls" action (not by the separate hidden
    // legacy "Camera Cycle (Legacy)" action/UUID, which shares the family's
    // name but no longer imports its icons), so the consumer-based rule alone
    // doesn't catch it; the owner wants the whole family gone regardless of
    // who still imports it.
    if (hiddenActions.has(family) || consumers.every((action) => hiddenActions.has(action))) {
      excludedHidden.push(`template:${iconPath}`);
      continue;
    }

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
      actions: consumers,
      file: `/icon-gallery/${sitePath}`,
      familyName,
    });
  }
}

// 2. Dynamic templates — template frame with sample values; the tri-state
// toggle set additionally gets the real status bar composed into iconContent
// so the card matches what the device actually shows (issue: gallery feedback
// wave, item 4). Pit Crew, Session Info, and Telemetry Display
// (DYNAMIC_ONLY_ACTIONS) have no template-class family of their own (gallery
// restructure wave, item 2) — their entries are tagged with the action's own
// slug as `family` (and that action as their sole consumer) so
// buildTemplateGroups()/dynamicSectionEntries() in sections.ts attach them to
// a synthetic "action group" in the template section instead of the flat
// "Dynamic templates" section.
for (const file of readdirSync(DYNAMIC_ROOT)) {
  if (!file.endsWith(".svg")) continue;
  const name = file.slice(0, -4);
  const sourcePath = path.join(DYNAMIC_ROOT, file);
  const svg = readFileSync(sourcePath, "utf-8");

  if (name === "pit-crew") {
    for (const pitCrewSample of PIT_CREW_SAMPLES) {
      const sitePath = `dynamic/${pitCrewSample.key}.svg`;
      const iconContent = sampleTitle(pitCrewSample.title, 92) + statusBarOn();
      writeAsset(sitePath, renderDynamicTemplate(svg, { iconContent }));
      entries.push({
        class: "dynamic",
        family: "pit-crew",
        name: pitCrewSample.key,
        path: repoRel(sourcePath),
        viewBox: extractRawViewBox(svg),
        slots: extractColorSlots(svg),
        locked: [...parseIconLocked(svg)],
        title: pitCrewSample.title,
        actions: ["pit-crew"],
        file: `/icon-gallery/${sitePath}`,
        familyName: resolveFamilyName("pit-crew"),
        sample: true,
      });
    }
    continue;
  }

  const baseSample = DYNAMIC_SAMPLE_DATA[name] ?? {};
  const sample = STATUS_BAR_TEMPLATES.has(name)
    ? { ...baseSample, iconContent: (baseSample.iconContent ?? "") + statusBarOn() }
    : baseSample;

  const sitePath = `dynamic/${name}.svg`;
  writeAsset(sitePath, renderDynamicTemplate(svg, sample));

  const dynamicOnly = DYNAMIC_ONLY_ACTIONS.includes(name);

  entries.push({
    class: "dynamic",
    family: dynamicOnly ? name : "dynamic-templates",
    name,
    path: repoRel(sourcePath),
    viewBox: extractRawViewBox(svg),
    slots: extractColorSlots(svg),
    locked: [...parseIconLocked(svg)],
    title: parseIconTitleDefaults(svg).text,
    actions: dynamicOnly ? [name] : [],
    file: `/icon-gallery/${sitePath}`,
    ...(dynamicOnly ? { familyName: resolveFamilyName(name) } : {}),
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

    // Hidden actions (item 13) get no key/dial/category entry at all.
    if (hiddenActions.has(dirent.name)) {
      excludedHidden.push(`${cls}:${dirent.name}`);
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

// 6. Dial touch-strip dash-box samples — one per Setup dial surface plus five
// of the seven post-merge (#802–#807) dial surfaces (all twelve render
// through the shared renderDialBox), plus one representative frame each for
// the Fuel Service, Audio Controls, Camera Controls (camera-focus-dash), and
// Black Box Selector dial surfaces, which draw their own custom pixmaps but
// expose a pure, tsx-importable render function that needs no live
// host/context object (verified empirically — issue: gallery feedback wave,
// item 5; extended for the post-merge batch, task 10).
for (const spec of [...SETUP_DIAL_SAMPLES, ...DIAL_BOX_SAMPLES]) {
  const sourcePath = path.join(ACTIONS_ROOT, spec.key, `${spec.key}-dial-surface.ts`);
  const dashSvg = bakeDialScreenBackground(
    toRawSvg(
      renderDialBox({
        width: 200,
        height: 100,
        abbr: spec.abbr,
        value: spec.value,
        colors: resolveDialBoxColors(undefined, spec.accent),
        ...(spec.identityLabelScale !== undefined ? { identityLabelScale: spec.identityLabelScale } : {}),
      }),
    ),
    200,
    100,
  );
  const sitePath = `dial/${spec.key}-dash.svg`;
  writeAsset(sitePath, dashSvg);
  entries.push({
    class: "dial",
    family: "touch-strip",
    name: `${spec.key}-dash`,
    path: repoRel(sourcePath),
    slots: [],
    locked: [],
    actions: [],
    file: `/icon-gallery/${sitePath}`,
    sample: true,
  });
}

const fuelDashSvg = bakeDialScreenBackground(
  renderStripCanvasSvg("manual", "add-amount", "on", 40, 20, 60, 0, 80, 1),
  200,
  100,
);
const fuelSitePath = "dial/fuel-service-dash.svg";
writeAsset(fuelSitePath, fuelDashSvg);
entries.push({
  class: "dial",
  family: "touch-strip",
  name: "fuel-service-dash",
  path: repoRel(path.join(ACTIONS_ROOT, "fuel-service", "fuel-dial-surface.ts")),
  slots: [],
  locked: [],
  actions: [],
  file: `/icon-gallery/${fuelSitePath}`,
  sample: true,
});

const audioDashSvg = bakeDialScreenBackground(
  renderAudioStripSvg({
    category: "race-engineer",
    volume: 65,
    enabled: true,
    pttHeld: false,
    bindingMissing: false,
  }),
  200,
  100,
);
const audioSitePath = "dial/audio-controls-dash.svg";
writeAsset(audioSitePath, audioDashSvg);
entries.push({
  class: "dial",
  family: "touch-strip",
  name: "audio-controls-dash",
  path: repoRel(path.join(ACTIONS_ROOT, "audio-controls", "audio-dial-surface.ts")),
  slots: [],
  locked: [],
  actions: [],
  file: `/icon-gallery/${audioSitePath}`,
  sample: true,
});

/**
 * Camera Controls' dial surface (issue #803, camera-dial-surface.ts) owns its
 * own carousel renderers per `dial.mode` rather than the shared renderDialBox.
 * `renderCarCarousel` (exported for testing, lines ~512-544) is pure and needs
 * no live host — it renders the DEFAULT mode, "car-number" (DialSettings.mode
 * default, line ~177), with MODE_TITLE["car-number"] = "CAR #" (line ~163),
 * MODE_IDENTITY["car-number"] = "CAR #" (line ~127, unused here since a live
 * center is supplied), and MODE_COLOR["car-number"] = "#2ecc71" (line ~140).
 * `center`/`left`/`right` are plausible sample car numbers (sides per #884).
 *
 * This action's static assets (dial.svg/icon.svg/key.svg) live under the
 * `camera-focus` folder (a UUID alias, see camera-controls.ts
 * CAMERA_FOCUS_UUID === CAMERA_CONTROLS_UUID and sections.ts's same-slug
 * fallback), so the sample is named `camera-focus-dash` — matching that
 * folder's dial.svg (family === name === "camera-focus") — so
 * `dialEntriesFor` places it in the camera-focus template group.
 */
const cameraFocusDashSvg = bakeDialScreenBackground(
  renderCarCarousel({
    width: 200,
    height: 100,
    colors: resolveDialBoxColors(undefined, "#2ecc71"),
    title: "CAR #",
    identityLabel: "CAR #",
    center: "24",
    left: "12",
    right: "88",
  }),
  200,
  100,
);
const cameraFocusSitePath = "dial/camera-focus-dash.svg";
writeAsset(cameraFocusSitePath, cameraFocusDashSvg);
entries.push({
  class: "dial",
  family: "touch-strip",
  name: "camera-focus-dash",
  path: repoRel(path.join(ACTIONS_ROOT, "camera-controls", "camera-dial-surface.ts")),
  slots: [],
  locked: [],
  actions: [],
  file: `/icon-gallery/${cameraFocusSitePath}`,
  sample: true,
});

/**
 * Black Box Selector's dial surface (issue #808) draws its own static strip —
 * `renderBlackBoxStrip` (exported for testing, lines ~134-157) — a "BB" badge
 * + "BLACK BOX" wordmark with no live readback (iRacing exposes no open-box
 * telemetry, the #782 identity-only compromise), using the surface's own
 * ACCENT "#d4a017" (line ~45) and `bindingMissing: false` (the Cycle bindings
 * assumed configured for the sample, same convention as every other dash
 * sample above).
 */
const blackBoxDashSvg = bakeDialScreenBackground(
  renderBlackBoxStrip({
    colors: resolveDialBoxColors(undefined, "#d4a017"),
    bindingMissing: false,
  }),
  200,
  100,
);
const blackBoxSitePath = "dial/black-box-selector-dash.svg";
writeAsset(blackBoxSitePath, blackBoxDashSvg);
entries.push({
  class: "dial",
  family: "touch-strip",
  name: "black-box-selector-dash",
  path: repoRel(path.join(ACTIONS_ROOT, "black-box-selector", "black-box-selector-dial-surface.ts")),
  slots: [],
  locked: [],
  actions: [],
  file: `/icon-gallery/${blackBoxSitePath}`,
  sample: true,
});

mkdirSync(path.dirname(JSON_OUT), { recursive: true });
writeFileSync(JSON_OUT, JSON.stringify(entries, null, 2) + "\n", "utf-8");

const counts = entries.reduce<Record<string, number>>((acc, e) => {
  acc[e.class] = (acc[e.class] ?? 0) + 1;
  return acc;
}, {});
console.log(`Generated ${entries.length} gallery entries:`, counts);

if (skippedTemplates.length > 0) {
  console.log(`Skipped ${skippedTemplates.length} unused templates: ${skippedTemplates.join(", ")}`);
}

if (excludedHidden.length > 0) {
  console.log(`Excluded ${excludedHidden.length} entries for hidden actions: ${excludedHidden.join(", ")}`);
}

