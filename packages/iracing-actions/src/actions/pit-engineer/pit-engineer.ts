import { getScenarioEngine } from "@iracedeck/audio-scenarios";
import {
  FLAG_SCENARIO_IDS,
  FUEL_SCENARIO_IDS,
  PIT_LIMITER_SCENARIO_IDS,
  setDriverNameResolver,
  TOGGLE_SCENARIO_IDS,
} from "@iracedeck/audio-scenarios/pit-engineer";
import { AudioBus, AudioChannel, getAudio } from "@iracedeck/audio-service";
import {
  applyGraphicTransform,
  CommonSettings,
  computeGraphicArea,
  ConnectionStateAwareAction,
  generateBorderParts,
  generateTitleText,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  renderIconTemplate,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
} from "@iracedeck/deck-core";
import { getEventBus, type SimEventOf } from "@iracedeck/event-bus";
import { getLatestTelemetry, getSessionType } from "@iracedeck/sim-events-iracing";
import path from "node:path";
import z from "zod";

import pitEngineerTemplate from "../../../icons/pit-engineer.svg";
import { borderColorForState, statusBarOff, statusBarOn } from "../../icons/status-bar.js";

// ─── Constants ─────────────────────────────────────────────────────────────────

const WHITE = "#ffffff";

/** @internal Exported for testing */
export const PIT_ENGINEER_UUID = "com.iracedeck.sd.core.pit-engineer";

// ─── Audio Channel Volumes ────────────────────────────────────────────────────
//
// Bus layout (sound groups):
//   Voice      — engineer messages, acks, connectors
//   Background — pit ambient loop + walkie ticks (intrinsic mix ratios live in deck-core)
//   Alerts     — directional spotter (independent of engineer volume)
//
// The PI "volume" slider drives the Voice + Background busses together (the
// "engineer" bus pair). The "spotterVolume" slider drives the Alerts bus.
// Per-channel attenuation (Ambient 0.8, SFX 0.7) is baked into the bus's
// channel mix ratios in audio-service.ts.

/** Applies volume-slider values to the audio busses. */
function applyChannelVolumes(): void {
  if (!globalSettings) return;

  const engineerVol = globalSettings.volume / 100;
  const spotterVol = globalSettings.spotterVolume / 100;

  getAudio().setBusVolume(AudioBus.Voice, engineerVol);
  getAudio().setBusVolume(AudioBus.Background, engineerVol);
  getAudio().setBusVolume(AudioBus.Alerts, spotterVol);
}

// ─── Tip Pool ────────────────────────────────────────────────────────────────

/**
 * @internal Exported for testing
 *
 * Full list of racing tips. Certain tips are restricted to either the
 * start-of-race window or mid-race only (see below). The rest are eligible
 * at any point.
 */
export const TIP_POOL = [
  "pit-engineer/tips/IRD-pit-engineer-tip-1.mp3",
  "pit-engineer/tips/IRD-pit-engineer-tip-2.mp3",
  "pit-engineer/tips/IRD-pit-engineer-tip-3.mp3",
  "pit-engineer/tips/IRD-pit-engineer-tip-4.mp3",
  "pit-engineer/tips/IRD-pit-engineer-tip-5.mp3",
  "pit-engineer/tips/IRD-pit-engineer-tip-6.mp3",
  "pit-engineer/tips/IRD-pit-engineer-tip-7.mp3",
  "pit-engineer/tips/IRD-pit-engineer-tip-8.mp3",
  "pit-engineer/tips/IRD-pit-engineer-tip-9.mp3",
  "pit-engineer/tips/IRD-pit-engineer-tip-10.mp3",
  "pit-engineer/tips/IRD-pit-engineer-tip-11.mp3",
];

/**
 * @internal Exported for testing
 *
 * Tips that should only be played during the start-of-race window
 * (formation/pace lap through lap 1). Excluded from the mid-race pool.
 */
export const START_ONLY_TIPS: ReadonlySet<string> = new Set([
  "pit-engineer/tips/IRD-pit-engineer-tip-6.mp3",
  "pit-engineer/tips/IRD-pit-engineer-tip-7.mp3",
]);

/**
 * @internal Exported for testing
 *
 * Tips that should only be played mid-race (after the start window closes).
 * Excluded from the start-of-race pool.
 */
export const MID_RACE_ONLY_TIPS: ReadonlySet<string> = new Set([
  "pit-engineer/tips/IRD-pit-engineer-tip-11.mp3",
]);

/**
 * @internal Exported for testing
 *
 * Returns the subset of tips eligible for the given race phase.
 * - Start window: excludes MID_RACE_ONLY_TIPS
 * - Mid-race: excludes START_ONLY_TIPS
 */
export function getEligibleTips(isStartWindow: boolean): string[] {
  const excluded = isStartWindow ? MID_RACE_ONLY_TIPS : START_ONLY_TIPS;

  return TIP_POOL.filter((tip) => !excluded.has(tip));
}

// ─── Driver Name ──────────────────────────────────────────────────────────────
//
// The driver name file is selected from the pit-engineer/names/ folder.
// Multiple names can be added (e.g., IRD-name-john.mp3, IRD-name-mike.mp3).
//
// To add a new name:
//   1. Place the mp3 file named `IRD-name-<lowercase>.mp3` in all three dirs:
//        - packages/audio-assets/pit-engineer/names/
//        - packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/assets/audio/pit-engineer/names/
//        - packages/mirabox-plugin/com.iracedeck.sd.core.sdPlugin/assets/audio/pit-engineer/names/
//      (Mirabox rollup does not copy from audio-assets/, so the plugin dirs must have it.)
//   2. Add an entry to the NAMES array in
//      packages/stream-deck-plugin/src/pi/pit-engineer.ejs — keep alphabetical.
//        { value: '<lowercase>', label: '<TitleCase>' }
//      (Mirabox reuses the same EJS via piTemplatePlugin — no separate edit needed.)
//   3. Build + pack both plugins:
//        pnpm build
//        cd packages/mirabox-plugin && pnpm pack:plugin
//        cd packages/stream-deck-plugin && npx streamdeck pack com.iracedeck.sd.core.sdPlugin --force --ignore-validation -o ../../local

/** Returns the configured driver name audio file, or null if no name is set. */
function getDriverNameFile(): string | null {
  const name = globalSettings?.driverName;

  if (!name || name === "none") return null;

  return `pit-engineer/names/IRD-name-${name}.mp3`;
}

// Expose the driver-name resolver to scenarios that use the `{{name}}` variable
// (the welcome scenario today; others may reuse it later). The closure reads
// the latest `globalSettings` at fire time, so no re-registration on settings
// changes is needed.
setDriverNameResolver(getDriverNameFile);

// ─── Settings ──────────────────────────────────────────────────────────────────

/** Zod-safe boolean that handles string "true"/"false" from PI checkboxes. */
const zBool = z.union([z.boolean(), z.string()]).transform((val) => val === true || val === "true");

const Settings = CommonSettings.extend({
  spotterEnabled: zBool.default(true),
  pitApproachEnabled: zBool.default(true),
  pitServiceReminderEnabled: zBool.default(true),
  pitDepartureEnabled: zBool.default(true),
  pitExitEnabled: zBool.default(true),
  pitLimiterWarning: zBool.default(true),
  incidentAlert: zBool.default(false),
  toggleAudioEnabled: zBool.default(false),
  overtakeAndTipsEnabled: zBool.default(true),
  flagAlertsEnabled: zBool.default(true),
  // Fuel sub-feature — all off by default while marked Work-In-Progress.
  fuelWarningsEnabled: zBool.default(false),
  fuelStintOpenEnabled: zBool.default(false),
  fuelSaveCoachingEnabled: zBool.default(false),
  fuelMidStintEnabled: zBool.default(false),
  spotterVolume: z.coerce.number().min(5).max(100).default(100),
  volume: z.coerce.number().min(5).max(100).default(45),
  driverName: z.string().default("none"),
});

type PitEngineerSettings = z.infer<typeof Settings>;

// ─── Spotter State ─────────────────────────────────────────────────────────────

/** Visual state of the spotter for icon rendering. */
export type SpotterVisualState = "clear" | "left" | "right" | "both" | "two-left" | "two-right";

/** Audio file names for each directional state. */
const SPOTTER_AUDIO: Record<string, string> = {
  left: "pit-engineer/spotter/IRD-spotter-left.mp3",
  right: "pit-engineer/spotter/IRD-spotter-right.mp3",
  both: "pit-engineer/spotter/IRD-spotter-both.mp3",
  "two-left": "pit-engineer/spotter/IRD-spotter-left.mp3",
  "two-right": "pit-engineer/spotter/IRD-spotter-right.mp3",
};

/** Stops the current spotter tick loop (if any). Safe to call when idle. */
function stopSpotterTickLoop(): void {
  if (globalSpotterTickTimer !== null) {
    clearTimeout(globalSpotterTickTimer);
    globalSpotterTickTimer = null;
  }
}

/**
 * Starts a self-scheduling spotter tick loop for the given visual state.
 * The interval is looked up from SPOTTER_TICK_INTERVALS. No-op for "clear".
 * Always stops any existing loop before starting.
 */
function startSpotterTickLoop(state: SpotterVisualState): void {
  stopSpotterTickLoop();

  if (state === "clear") return;

  const audioFile = SPOTTER_AUDIO[state];

  if (!audioFile) return;

  const interval = SPOTTER_TICK_INTERVALS[state];

  const fire = (): void => {
    getAudio().playOnChannel(AudioChannel.Spotter, getAudioPath(audioFile));
    globalSpotterTickTimer = setTimeout(fire, interval);
  };

  fire();
}

// ─── Icon Generation ───────────────────────────────────────────────────────────

/** Artwork bounds of the mechanic SVG (source viewBox 0 0 71.457 71.457). */
const MECHANIC_BOUNDS = { x: 0, y: 0, width: 71.457, height: 71.457 };

/**
 * Returns the raw mechanic path SVG content (unscaled, in source coordinate space).
 */
function mechanicPathContent(graphicColor: string): string {
  return `<path fill="${graphicColor}" d="M19.538,23.485c0.02-0.685,0.082-2.768,1.558-3.325c1.46-0.551,2.964,0.948,3.251,1.254c0.377,0.403,0.356,1.036-0.047,1.414c-0.404,0.375-1.036,0.356-1.414-0.047c-0.347-0.367-0.897-0.734-1.106-0.741c0.014,0.028-0.208,0.349-0.243,1.504c-0.11,3.731,2.743,4.773,2.864,4.815c0.31,0.108,0.553,0.364,0.641,0.68l0.046,0.168c0.017,0.06,0.027,0.121,0.033,0.183c0.825,9.836,8.605,13.019,12.244,13.019s11.419-3.182,12.244-13.019c0.005-0.061,0.016-0.121,0.032-0.18l0.046-0.168c0.088-0.322,0.332-0.58,0.649-0.685c0.114-0.04,2.967-1.082,2.857-4.813c-0.038-1.272-0.303-1.533-0.306-1.536c-0.124,0.023-0.689,0.399-1.044,0.774c-0.379,0.4-1.011,0.419-1.413,0.042c-0.401-0.378-0.423-1.008-0.046-1.411c0.287-0.306,1.79-1.805,3.251-1.254c1.476,0.558,1.538,2.641,1.558,3.325c0.109,3.698-2.075,5.741-3.632,6.521c-1.051,9.93-8.88,14.403-14.195,14.403S24.221,39.936,23.17,30.005C21.613,29.226,19.429,27.184,19.538,23.485z M22.099,16.792C22.099,3.017,33.101,0,37.34,0c4.253,0,15.291,3.017,15.291,16.792c0,0.438-0.286,0.826-0.705,0.956l-1.558,0.481l-1.389,1.538c-0.19,0.211-0.46,0.33-0.742,0.33c-0.032,0-0.063-0.001-0.095-0.004c-0.309-0.03-0.585-0.2-0.75-0.461c-0.061-0.087-2.069-2.829-10.027-2.835c-8.044,0.006-10.008,2.809-10.027,2.837c-0.171,0.256-0.458,0.429-0.765,0.452c-0.306,0.028-0.614-0.088-0.821-0.317l-1.389-1.538l-1.558-0.481C22.384,17.619,22.099,17.231,22.099,16.792z M24.111,16.059l1.104,0.341c0.172,0.053,0.326,0.152,0.447,0.285l0.845,0.936c1.322-1.13,4.38-2.819,10.858-2.824c6.478,0.004,9.537,1.694,10.859,2.824l0.844-0.935c0.121-0.134,0.275-0.232,0.447-0.286l1.104-0.341C50.18,2.388,37.471,2,37.34,2C37.21,2,24.548,2.388,24.111,16.059z M26.405,13.627c-0.187-0.52,0.083-1.093,0.602-1.28c1.413-0.509,2.86-0.886,4.321-1.179c-0.227-0.8-0.455-1.6-0.665-2.403c-0.068-0.258-0.029-0.533,0.107-0.762c0.136-0.23,0.358-0.396,0.617-0.46c3.966-0.995,7.988-0.995,11.954,0c0.259,0.065,0.481,0.23,0.617,0.46c0.136,0.229,0.175,0.504,0.107,0.762c-0.21,0.802-0.438,1.602-0.665,2.403c1.461,0.293,2.908,0.67,4.321,1.179c0.52,0.187,0.789,0.76,0.602,1.28c-0.147,0.408-0.531,0.661-0.941,0.662c-0.112,0-0.227-0.02-0.339-0.06c-6.242-2.248-13.117-2.248-19.359,0C27.165,14.415,26.593,14.146,26.405,13.627z M33.31,10.841c2.692-0.359,5.417-0.359,8.109,0c0.151-0.528,0.303-1.055,0.446-1.584c-2.992-0.613-6.011-0.613-9.002,0C33.007,9.786,33.159,10.313,33.31,10.841z M70.32,32.224v5.108c0,0.536-0.286,1.031-0.75,1.299l-3.674,2.121v12.558c0,0.028-0.007,0.053-0.008,0.08c1.211,0.175,2.134,0.577,2.783,1.228c1.194,1.201,1.185,2.886,1.177,4.373l-0.001,6.939c0,3.005-2.445,5.45-5.45,5.45c-3.005,0-5.45-2.445-5.45-5.45l-0.001-6.939c-0.008-1.487-0.017-3.172,1.177-4.373c0.648-0.652,1.572-1.053,2.783-1.228c-0.001-0.027-0.008-0.053-0.008-0.08v-1.539c-1.027-3.481-3.123-6.704-5.941-9.243l-2.758,7.851v21.078H37.365H20.534V50.379l-2.859-8.137c-3.937,3.24-6.539,7.58-7.099,12.155c0.093,0.076,0.205,0.137,0.289,0.221c1.194,1.201,1.185,2.886,1.177,4.373l-0.001,6.94c0,3.005-2.445,5.45-5.45,5.45c-3.005,0-5.45-2.445-5.45-5.45l-0.001-6.939c-0.008-1.487-0.017-3.172,1.177-4.373c0.462-0.465,1.066-0.8,1.81-1.021v-5.294c0-0.552,0.448-1,1-1H5.84v-9.639c0-0.414,0.336-0.75,0.75-0.75s0.75,0.336,0.75,0.75v9.639h0.714c0.552,0,1,0.448,1,1v3.43c1.168-4.387,3.992-8.435,7.921-11.485l-0.296-0.842c-0.183-0.521,0.091-1.092,0.612-1.275c0.522-0.184,1.092,0.091,1.275,0.612l0.101,0.289c1.356-0.885,2.817-1.659,4.369-2.296c0.255-0.105,0.543-0.1,0.794,0.015c0.251,0.114,0.444,0.328,0.533,0.589c1.758,5.181,6.816,8.529,12.886,8.529c6.071,0,11.129-3.348,12.887-8.529c0.088-0.261,0.281-0.475,0.533-0.589c0.251-0.115,0.539-0.12,0.794-0.015c1.612,0.662,3.126,1.51,4.531,2.494l0.171-0.486c0.183-0.521,0.753-0.795,1.275-0.612c0.521,0.183,0.795,0.754,0.612,1.275l-0.385,1.096c2.118,1.782,3.894,3.914,5.229,6.253v-6.004l-3.674-2.121c-0.464-0.268-0.75-0.763-0.75-1.299v-5.108c0-0.829,0.671-1.5,1.5-1.5s1.5,0.671,1.5,1.5v4.242l2.924,1.688l2.924-1.688v-4.242c0-0.829,0.671-1.5,1.5-1.5S70.32,31.395,70.32,32.224z M6.126,52.618h0.928v-3.314H6.126V52.618z M9.735,67.334H7.698c-0.552,0-1-0.448-1-1s0.448-1,1-1h2.341l0-1.688H7.698c-0.552,0-1-0.448-1-1s0.448-1,1-1h2.342l0-1.822H7.698c-0.552,0-1-0.448-1-1s0.448-1,1-1h2.325c-0.041-0.741-0.171-1.387-0.577-1.795c-0.491-0.494-1.452-0.745-2.856-0.745s-2.365,0.25-2.856,0.745c-0.608,0.611-0.602,1.748-0.595,2.952l0.001,6.95c0,1.902,1.548,3.45,3.45,3.45C7.992,69.381,9.196,68.538,9.735,67.334z M23.625,52.599c0-0.352-0.286-0.638-0.638-0.638c-0.352,0-0.638,0.286-0.638,0.638c0,0.352,0.286,0.638,0.638,0.638C23.339,53.237,23.625,52.951,23.625,52.599z M46.393,62.333c0-0.552-0.448-1-1-1H29.337c-0.552,0-1,0.448-1,1s0.448,1,1,1h16.056C45.945,63.333,46.393,62.885,46.393,62.333z M37.365,53.237c0.352,0,0.638-0.286,0.638-0.638c0-0.352-0.286-0.638-0.638-0.638c-0.352,0-0.638,0.286-0.638,0.638C36.727,52.951,37.013,53.237,37.365,53.237z M52.381,52.599c0-0.352-0.286-0.638-0.638-0.638c-0.352,0-0.638,0.286-0.638,0.638c0,0.352,0.286,0.638,0.638,0.638C52.095,53.237,52.381,52.951,52.381,52.599z M55.304,41.191c-1.139-0.841-2.363-1.584-3.664-2.193c-2.32,5.424-7.85,8.871-14.392,8.871c-6.542,0-12.073-3.448-14.393-8.874c-1.242,0.571-2.412,1.241-3.505,1.986l3.223,9.175h14.79h14.79L55.304,41.191z M67.252,56.029c-0.491-0.494-1.453-0.745-2.856-0.745c-1.404,0-2.365,0.25-2.856,0.745c-0.406,0.409-0.536,1.054-0.577,1.795h2.325c0.552,0,1,0.448,1,1s-0.448,1-1,1h-2.343l0,1.822h2.343c0.552,0,1,0.448,1,1s-0.448,1-1,1h-2.342l0,1.688h2.342c0.552,0,1,0.448,1,1s-0.448,1-1,1H61.25c0.539,1.204,1.743,2.047,3.145,2.047c1.902,0,3.45-1.548,3.45-3.45l0.001-6.95C67.853,57.777,67.86,56.641,67.252,56.029z M37.979,24.528v4.953h-2.228c-0.552,0-1,0.448-1,1s0.448,1,1,1h3.228c0.552,0,1-0.448,1-1v-5.953c0-0.552-0.448-1-1-1S37.979,23.976,37.979,24.528z"/>`;
}

/**
 * @internal Exported for testing
 *
 * Generates a complete SVG data URI for the pit engineer icon.
 */
export function generatePitEngineerSvg(
  settings: PitEngineerSettings,
  spotterState: SpotterVisualState,
  enabled: boolean,
): string {
  const colors = resolveIconColors(pitEngineerTemplate, getGlobalColors(), settings.colorOverrides) as Record<
    string,
    string
  >;

  const graphicColor = colors.graphic1Color ?? WHITE;

  // Resolve graphic scale from PI overrides → global defaults → 100%
  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);
  const title = resolveTitleSettings(
    pitEngineerTemplate,
    getGlobalTitleSettings(),
    settings.titleOverrides,
    "PIT\nENGINEER",
  );

  // Status bar occupies y=100..144, so constrain graphic area to the upper region
  const STATUS_BAR_TOP = 100;
  const PADDING = 8;
  const fullGraphicArea = computeGraphicArea(title);
  const graphicArea = {
    ...fullGraphicArea,
    height: Math.min(fullGraphicArea.height, STATUS_BAR_TOP - PADDING - fullGraphicArea.y),
  };

  // Apply graphic transform with user scale
  const rawPath = mechanicPathContent(graphicColor);
  const scaledGraphic = title.showGraphics
    ? applyGraphicTransform(rawPath, MECHANIC_BOUNDS, graphicArea, graphic.scale)
    : "";

  // Generate title text
  const titleText = title.showTitle
    ? generateTitleText({
        text: title.titleText ?? "PIT\nENGINEER",
        fontSize: title.fontSize,
        bold: title.bold,
        position: title.position,
        customPosition: title.customPosition,
        fill: colors.textColor ?? WHITE,
      })
    : "";

  const statusBar = enabled ? statusBarOn() : statusBarOff();
  const iconContent = scaledGraphic + titleText + statusBar;

  const border = resolveBorderSettings(
    pitEngineerTemplate,
    getGlobalBorderSettings(),
    settings.borderOverrides,
    borderColorForState(enabled ? "on" : "off"),
  );
  const borderSvg = generateBorderParts(border);

  const svg = renderIconTemplate(pitEngineerTemplate, {
    iconContent,
    borderDefs: borderSvg.defs,
    borderContent: borderSvg.rects,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Resolves the absolute path to an audio file in the plugin's assets directory.
 */
function getAudioPath(filename: string): string {
  return path.join(process.cwd(), "assets", "audio", filename);
}

// ─── Global Pit Engineer State ────────────────────────────────────────────────
//
// The pit engineer runs globally — toggling ON keeps the telemetry subscription
// and audio playback alive even when the user navigates to a different page.
// Action instances only manage their icon display.
//
// MULTI-INSTANCE NOTE: When multiple Pit Engineer buttons exist on different
// pages, the last instance to appear or receive a settings update wins — its
// settings become the active `globalSettings`. This is intentional: all
// instances share the same global state and the user is expected to configure
// them identically. If instances have different feature toggles, the behavior
// depends on which was last seen by the runtime.

/** Global enabled flag — shared across all action instances. */
let globalEnabled = true;

/** Current global settings (merged from last-seen action instance). */
let globalSettings: PitEngineerSettings | null = null;

// ─── Spotter sub-feature state ───────────────────────────────────────────────

/** Current spotter visual state (for icon rendering on reappear). */
let globalSpotterState: SpotterVisualState = "clear";

/** Self-scheduling timer that drives the proximity-modulated spotter tick loop. */
let globalSpotterTickTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Tick intervals per spotter state. Single-car states tick at 250 ms (same as
 * the legacy 4 Hz replay). Two-cars-same-side is faster (180 ms) because being
 * sandwiched on one side is more dangerous. Cars-both-sides is slower than
 * two-same-side (230 ms) — you're locked between cars, holding a straight line.
 */
const SPOTTER_TICK_INTERVALS: Readonly<Record<Exclude<SpotterVisualState, "clear">, number>> = {
  left: 250,
  right: 250,
  "two-left": 180,
  "two-right": 180,
  both: 230,
};

/**
 * @internal Exported for testing
 *
 * Pit service toggle audio file mapping.
 */
export const PIT_SERVICE_TOGGLE_AUDIO: Record<string, { on: string; off: string }> = {
  fuel: { on: "pit-engineer/toggle/IRD-toggle-fuel-on.mp3", off: "pit-engineer/toggle/IRD-toggle-fuel-off.mp3" },
  windshield: {
    on: "pit-engineer/toggle/IRD-toggle-windshield-on.mp3",
    off: "pit-engineer/toggle/IRD-toggle-windshield-off.mp3",
  },
  fastRepair: {
    on: "pit-engineer/toggle/IRD-toggle-fast-repair-on.mp3",
    off: "pit-engineer/toggle/IRD-toggle-fast-repair-off.mp3",
  },
};

/**
 * @internal Exported for testing
 *
 * Tire toggle audio file mapping — pattern-aware.
 */
export const TIRE_TOGGLE_AUDIO: Record<string, { on: string; off: string }> = {
  all: {
    on: "pit-engineer/toggle/IRD-toggle-tires-all-on.mp3",
    off: "pit-engineer/toggle/IRD-toggle-tires-all-off.mp3",
  },
  front: {
    on: "pit-engineer/toggle/IRD-toggle-tires-front-on.mp3",
    off: "pit-engineer/toggle/IRD-toggle-tires-front-off.mp3",
  },
  rear: {
    on: "pit-engineer/toggle/IRD-toggle-tires-rear-on.mp3",
    off: "pit-engineer/toggle/IRD-toggle-tires-rear-off.mp3",
  },
  left: {
    on: "pit-engineer/toggle/IRD-toggle-tires-left-on.mp3",
    off: "pit-engineer/toggle/IRD-toggle-tires-left-off.mp3",
  },
  right: {
    on: "pit-engineer/toggle/IRD-toggle-tires-right-on.mp3",
    off: "pit-engineer/toggle/IRD-toggle-tires-right-off.mp3",
  },
  crossLfRr: {
    on: "pit-engineer/toggle/IRD-toggle-tires-lf-rr-on.mp3",
    off: "pit-engineer/toggle/IRD-toggle-tires-lf-rr-off.mp3",
  },
  crossRfLr: {
    on: "pit-engineer/toggle/IRD-toggle-tires-rf-lr-on.mp3",
    off: "pit-engineer/toggle/IRD-toggle-tires-rf-lr-off.mp3",
  },
  stayDry: {
    on: "pit-engineer/toggle/IRD-toggle-compound-stay-dry.mp3",
    off: "pit-engineer/toggle/IRD-toggle-compound-stay-dry.mp3",
  },
  stayWet: {
    on: "pit-engineer/toggle/IRD-toggle-compound-stay-wet.mp3",
    off: "pit-engineer/toggle/IRD-toggle-compound-stay-wet.mp3",
  },
  changeToDry: {
    on: "pit-engineer/toggle/IRD-toggle-compound-change-dry.mp3",
    off: "pit-engineer/toggle/IRD-toggle-compound-change-dry.mp3",
  },
  changeToWet: {
    on: "pit-engineer/toggle/IRD-toggle-compound-change-wet.mp3",
    off: "pit-engineer/toggle/IRD-toggle-compound-change-wet.mp3",
  },
  lf: { on: "pit-engineer/toggle/IRD-toggle-tires-lf-on.mp3", off: "pit-engineer/toggle/IRD-toggle-tires-lf-off.mp3" },
  rf: { on: "pit-engineer/toggle/IRD-toggle-tires-rf-on.mp3", off: "pit-engineer/toggle/IRD-toggle-tires-rf-off.mp3" },
  lr: { on: "pit-engineer/toggle/IRD-toggle-tires-lr-on.mp3", off: "pit-engineer/toggle/IRD-toggle-tires-lr-off.mp3" },
  rr: { on: "pit-engineer/toggle/IRD-toggle-tires-rr-on.mp3", off: "pit-engineer/toggle/IRD-toggle-tires-rr-off.mp3" },
};

/**
 * @internal Exported for testing
 *
 * Short tire name clips (no "change" prefix) for 3-tire combo announcements.
 */
export const TIRE_SHORT: Record<string, string> = {
  lf: "pit-engineer/toggle/IRD-toggle-tires-lf-short.mp3",
  rf: "pit-engineer/toggle/IRD-toggle-tires-rf-short.mp3",
  lr: "pit-engineer/toggle/IRD-toggle-tires-lr-short.mp3",
  rr: "pit-engineer/toggle/IRD-toggle-tires-rr-short.mp3",
};

/**
 * @internal Exported for testing
 *
 * Car control toggle audio file mapping.
 */
export const CAR_CONTROL_TOGGLE_AUDIO: Record<string, { on: string; off: string }> = {
  pushToPass: { on: "pit-engineer/toggle/IRD-toggle-p2p-on.mp3", off: "pit-engineer/toggle/IRD-toggle-p2p-off.mp3" },
  drs: { on: "pit-engineer/toggle/IRD-toggle-drs-on.mp3", off: "pit-engineer/toggle/IRD-toggle-drs-off.mp3" },
};

// NOTE: the old `resolvePitServiceToggleAudio` and `resolveCarControlToggleAudio`
// helpers were removed in Stage 4b when pit-engineer migrated to sim-events.
// The translator now emits a single-service / single-toggle event per change,
// so the resolvers (which diffed bitfields) no longer have the inputs they
// relied on. Tire pattern announcements (front/rear/all/3-tire/compound) are
// a behavior regression until the translator grows richer tire events — see
// TODO(4c) at the incident pool comment for the full follow-up list.

/**
 * Resets all audio state — cancels any in-flight voice sequence, stops every
 * channel, and stops the spotter tick loop. Called when the engineer is
 * toggled off.
 */
function resetAllAudioState(): void {
  stopSpotterTickLoop();
  getAudio().cancelVoiceSequence();
  getAudio().stopChannel(AudioChannel.SFX);
  getAudio().stopChannel(AudioChannel.Voice);
  getAudio().stopChannel(AudioChannel.Ambient);
  getAudio().stopChannel(AudioChannel.Spotter);
}

// ─── Action ────────────────────────────────────────────────────────────────────

export class PitEngineer extends ConnectionStateAwareAction<PitEngineerSettings> {
  /** Per-context settings cache (for visible instances only). Named settingsCache to avoid shadowing BaseAction.contexts. */
  private readonly settingsCache = new Map<string, PitEngineerSettings>();

  /** Per-context last rendered state key for icon dedup. */
  private readonly lastStateKey = new Map<string, string>();

  /** Set of currently visible context IDs. */
  private readonly visibleContexts = new Set<string>();

  /** Last engineer test volume timestamp to avoid replaying on every settings update. */
  private lastTestTimestamp = 0;

  /** Last spotter test volume timestamp. */
  private lastSpotterTestTimestamp = 0;

  /** Cycles through spotter test files: left → right → both. */
  private spotterTestIndex = 0;

  /** Active event-bus unsubscribe callbacks while the engineer is enabled. */
  private eventSubscriptions: Array<() => void> = [];

  /** Spotter test file rotation order. */
  private static readonly SPOTTER_TEST_FILES = [
    "pit-engineer/spotter/IRD-spotter-left.mp3",
    "pit-engineer/spotter/IRD-spotter-right.mp3",
    "pit-engineer/spotter/IRD-spotter-both.mp3",
  ];

  override async onWillAppear(ev: IDeckWillAppearEvent<PitEngineerSettings>): Promise<void> {
    await super.onWillAppear(ev);

    const raw = ev.payload.settings as Record<string, unknown>;
    const settings = Settings.parse(raw);
    const contextId = ev.action.id;

    this.settingsCache.set(contextId, settings);
    this.visibleContexts.add(contextId);
    globalSettings = settings;

    // Seed test timestamps so the first onDidReceiveSettings doesn't
    // falsely trigger playback for both test buttons
    this.lastTestTimestamp = (raw._testVolume as number) ?? 0;
    this.lastSpotterTestTimestamp = (raw._testSpotterVolume as number) ?? 0;

    // Show current global state
    await this.setKeyImage(ev, generatePitEngineerSvg(settings, globalSpotterState, globalEnabled));

    // Ensure event-bus subscriptions are active if the engineer is enabled.
    if (globalEnabled && this.eventSubscriptions.length === 0) {
      this.startEventSubscriptions();
    }

    this.applyScenarioGates(settings);

    // Provide regeneration callback for icon refresh (global color changes, etc.)
    this.setRegenerateCallback(contextId, () => {
      const s = this.settingsCache.get(contextId);

      if (!s) return "";

      return generatePitEngineerSvg(s, globalSpotterState, globalEnabled);
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<PitEngineerSettings>): Promise<void> {
    const contextId = ev.action.id;

    // Only clean up icon-related state — do NOT stop audio or unsubscribe
    this.settingsCache.delete(contextId);
    this.lastStateKey.delete(contextId);
    this.visibleContexts.delete(contextId);

    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<PitEngineerSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);

    const raw = ev.payload.settings as Record<string, unknown>;
    const settings = Settings.parse(raw);
    const contextId = ev.action.id;
    this.settingsCache.set(contextId, settings);
    globalSettings = settings;

    // Apply channel volumes whenever settings change
    applyChannelVolumes();

    // Sync PI toggles to the scenario engine's setEnabled.
    this.applyScenarioGates(settings);

    // Handle engineer test volume button from PI
    const testTimestamp = raw._testVolume as number | undefined;

    if (testTimestamp && testTimestamp !== this.lastTestTimestamp) {
      this.logger.info("Playing welcome message (engineer test)");
      getScenarioEngine().fire("pit-engineer.welcome");
    }

    this.lastTestTimestamp = testTimestamp ?? 0;

    // Handle spotter test volume button from PI — plays all 3: left → right → both
    const spotterTestTimestamp = raw._testSpotterVolume as number | undefined;

    if (spotterTestTimestamp && spotterTestTimestamp !== this.lastSpotterTestTimestamp) {
      this.logger.info("Playing spotter test: left → right → both");
      applyChannelVolumes();
      let idx = 0;
      const playNext = (): void => {
        if (idx >= PitEngineer.SPOTTER_TEST_FILES.length) return;

        const file = PitEngineer.SPOTTER_TEST_FILES[idx];
        idx++;
        getAudio().onChannelComplete(AudioChannel.Spotter, () => {
          setTimeout(() => playNext(), 250);
        });
        getAudio().playOnChannel(AudioChannel.Spotter, getAudioPath(file));
      };
      playNext();
    }

    this.lastSpotterTestTimestamp = spotterTestTimestamp ?? 0;

    // Force re-render
    this.lastStateKey.delete(contextId);
    await this.setKeyImage(ev, generatePitEngineerSvg(settings, globalSpotterState, globalEnabled));

    // Update regenerate callback with fresh settings
    this.setRegenerateCallback(contextId, () => {
      const s = this.settingsCache.get(contextId);

      if (!s) return "";

      return generatePitEngineerSvg(s, globalSpotterState, globalEnabled);
    });
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<PitEngineerSettings>): Promise<void> {
    globalEnabled = !globalEnabled;
    this.logger.info(`Pit Engineer ${globalEnabled ? "enabled" : "disabled"}`);

    if (globalEnabled) {
      const settings = Settings.parse(ev.payload.settings);
      globalSettings = settings;
      this.startEventSubscriptions();
      this.applyScenarioGates(settings);
    } else {
      this.stopEventSubscriptions();
      resetAllAudioState();
      this.disableAllScenarios();
    }

    // Update icon on all visible instances
    this.updateAllVisibleIcons();
  }

  /**
   * Sync PI toggles to the scenario engine. Each mapping translates a PI
   * setting to a scenario id; gates that are off also disable the scenario
   * here so in-flight fires are cancelled.
   */
  private applyScenarioGates(settings: PitEngineerSettings): void {
    const engine = getScenarioEngine();
    engine.setEnabled("pit-engineer.pit-approach", settings.pitApproachEnabled);
    engine.setEnabled("pit-engineer.service-reminder", settings.pitServiceReminderEnabled);
    engine.setEnabled("pit-engineer.pit-exit", settings.pitExitEnabled);
    engine.setEnabled("pit-engineer.stall-departure", settings.pitDepartureEnabled);
    engine.setEnabled("pit-engineer.incident-alerts", settings.incidentAlert);
    engine.setEnabled("pit-engineer.overtake", settings.overtakeAndTipsEnabled);

    for (const id of FLAG_SCENARIO_IDS) engine.setEnabled(id, settings.flagAlertsEnabled);

    for (const id of FUEL_SCENARIO_IDS) engine.setEnabled(id, settings.fuelWarningsEnabled);

    for (const id of TOGGLE_SCENARIO_IDS) engine.setEnabled(id, settings.toggleAudioEnabled);

    for (const id of PIT_LIMITER_SCENARIO_IDS) engine.setEnabled(id, settings.pitLimiterWarning);

    // Tips share the overtakeAndTipsEnabled gate with the overtake scenario.
    engine.setEnabled("pit-engineer.racing-tips", settings.overtakeAndTipsEnabled);
  }

  /** Disable every pit-engineer scenario — called when the engineer is toggled off. */
  private disableAllScenarios(): void {
    const engine = getScenarioEngine();

    for (const id of [
      "pit-engineer.welcome",
      "pit-engineer.pit-approach",
      "pit-engineer.service-reminder",
      "pit-engineer.pit-exit",
      "pit-engineer.stall-departure",
      "pit-engineer.incident-alerts",
      "pit-engineer.overtake",
      "pit-engineer.racing-tips",
      ...FLAG_SCENARIO_IDS,
      ...FUEL_SCENARIO_IDS,
      ...TOGGLE_SCENARIO_IDS,
      ...PIT_LIMITER_SCENARIO_IDS,
    ]) {
      engine.setEnabled(id, false);
    }
  }

  // ─── Event-bus subscription plumbing ─────────────────────────────────────

  private startEventSubscriptions(): void {
    if (this.eventSubscriptions.length > 0) return;

    const bus = getEventBus();

    this.eventSubscriptions.push(bus.subscribe("spotter.changed", (ev) => this.onSpotterChanged(ev)));

    this.logger.debug(`Pit Engineer subscribed to ${this.eventSubscriptions.length} events`);
  }

  private stopEventSubscriptions(): void {
    for (const off of this.eventSubscriptions) off();

    this.eventSubscriptions = [];
  }

  // ─── Event handlers ──────────────────────────────────────────────────────

  private onSpotterChanged(ev: SimEventOf<"spotter.changed">): void {
    if (!globalEnabled || !globalSettings?.spotterEnabled) return;

    if (getSessionType() === "Lone Qualify") return;

    const telemetry = getLatestTelemetry();

    if (telemetry?.OnPitRoad === true) {
      // Suppress spotter in pit lane.
      if (globalSpotterState !== "clear") {
        stopSpotterTickLoop();
        getAudio().stopChannel(AudioChannel.Spotter);
        globalSpotterState = "clear";
        this.updateAllVisibleIcons();
      }

      return;
    }

    const state = ev.data.to as SpotterVisualState;

    if (state === globalSpotterState) return;

    this.logger.debug(`Spotter state: ${globalSpotterState} → ${state}`);

    if (state === "clear") {
      stopSpotterTickLoop();
      getAudio().stopChannel(AudioChannel.Spotter);
    } else {
      applyChannelVolumes();
      startSpotterTickLoop(state);
    }

    globalSpotterState = state;
    this.updateAllVisibleIcons();
  }

  // ─── Icon Updates ─────────────────────────────────────────────────────────

  private updateAllVisibleIcons(): void {
    for (const contextId of this.visibleContexts) {
      const settings = this.settingsCache.get(contextId);

      if (!settings) continue;

      const stateKey = `${globalEnabled}|${globalSpotterState}|${JSON.stringify(settings.colorOverrides)}|${JSON.stringify(settings.borderOverrides)}|${JSON.stringify(settings.titleOverrides)}|${JSON.stringify(settings.graphicOverrides)}`;

      if (this.lastStateKey.get(contextId) === stateKey) continue;

      this.lastStateKey.set(contextId, stateKey);
      const svg = generatePitEngineerSvg(settings, globalSpotterState, globalEnabled);
      void this.updateKeyImage(contextId, svg);
    }
  }
}
