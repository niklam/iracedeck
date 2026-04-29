import {
  isBackgroundTestInFlight,
  playBackgroundTest,
  playRadarTest,
  setRadarEnabled,
} from "@iracedeck/audio-scenarios/pit-crew";
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
  getGlobalSettings,
  getGlobalTitleSettings,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  onGlobalSettingsChange,
  renderIconTemplate,
  resolveActiveDriverName,
  resolveActiveRaceEngineerVoice,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
  updateGlobalSettings,
} from "@iracedeck/deck-core";
import { z } from "zod";

import pitCrewTemplate from "../../../icons/pit-crew.svg";
import { borderColorForState, statusBarOff, statusBarOn } from "../../icons/status-bar.js";

const WHITE = "#ffffff";
const VOLUME_STEP = 5;
const VOLUME_MIN = 0;
const VOLUME_MAX = 100;

/** @internal Exported for testing */
export const PIT_CREW_UUID = "com.iracedeck.sd.core.pit-crew";

// ─── Settings ──────────────────────────────────────────────────────────────────

/**
 * Pit Crew action settings.
 *
 * `mode` selects what the key press does:
 *   - `race-engineer`: flips the global `raceEngineerEnabled` gate.
 *   - `radar`: flips the global `radarEnabled` gate and stops/starts the
 *     directional tick loop synchronously.
 *   - `radar-volume`: steps the global `radarVolume` by ±{@link VOLUME_STEP},
 *     clamped to [{@link VOLUME_MIN}, {@link VOLUME_MAX}]. `direction`
 *     selects whether the step is up or down.
 *
 * All user-visible feature state (enabled flags, volume) lives in global
 * settings so every Pit Crew button reflects the same values. Persisted
 * per-action fields from earlier schema iterations (e.g. `radarEnabled`,
 * `radarVolume` as action-level keys) are silently dropped by Zod's default
 * strip mode on parse — no migration needed.
 */
/** @internal Exported for testing. */
export const Settings = CommonSettings.extend({
  mode: z.enum(["race-engineer", "radar", "radar-volume"]).default("race-engineer"),
  direction: z.enum(["up", "down"]).default("up"),
});

type PitCrewSettings = z.infer<typeof Settings>;
type Mode = PitCrewSettings["mode"];

// ─── Global-state helpers ─────────────────────────────────────────────────────

function isRaceEngineerEnabled(): boolean {
  // Both feature gates default to off — fresh installs and never-toggled
  // setups stay quiet until the user opts in. Only an explicit `true`
  // (set when the user presses the toggle) enables the feature.
  return (getGlobalSettings() as Record<string, unknown>).raceEngineerEnabled === true;
}

function isRadarEnabled(): boolean {
  return (getGlobalSettings() as Record<string, unknown>).radarEnabled === true;
}

function readRadarVolume(): number {
  const raw = (getGlobalSettings() as Record<string, unknown>).radarVolume;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : VOLUME_MAX;

  if (!Number.isFinite(n)) return VOLUME_MAX;

  return Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, Math.round(n)));
}

/**
 * @internal Exported for testing.
 *
 * Copy the current global `radarVolume` onto `AudioBus.Alerts`. Called on
 * every action mount so the live audio bus matches persisted settings, and
 * whenever any Pit Crew instance steps the volume.
 */
export function applyRadarVolume(): void {
  getAudio().setBusVolume(AudioBus.Alerts, readRadarVolume() / 100);
}

function readRaceEngineerVolume(): number {
  const raw = (getGlobalSettings() as Record<string, unknown>).raceEngineerVolume;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : VOLUME_MAX;

  if (!Number.isFinite(n)) return VOLUME_MAX;

  return Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, Math.round(n)));
}

function readBackgroundVolume(): number {
  const raw = (getGlobalSettings() as Record<string, unknown>).backgroundVolume;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : VOLUME_MAX;

  if (!Number.isFinite(n)) return VOLUME_MAX;

  return Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, Math.round(n)));
}

/**
 * Whether the Race Engineer voice Test preview is currently playing.
 * Tracked at module scope so the global-settings listener (which calls
 * `applyRaceEngineerAudio` whenever any global changes) doesn't re-mute
 * `AudioBus.Voice` mid-preview when Race Engineer is off — moving the
 * volume slider during the test would otherwise cut it off.
 */
let raceEngineerTestInFlight = false;

/** @internal Exposed for testing. */
export function _setRaceEngineerTestInFlightForTests(value: boolean): void {
  raceEngineerTestInFlight = value;
}

/**
 * @internal Exported for testing.
 *
 * Apply the Race Engineer master gate to the relevant audio buses:
 *   - `AudioBus.Voice` — engineer voice clips, acks, toggle confirmations.
 *   - `AudioBus.Background` — pit ambient loop and walkie-talkie SFX.
 *
 * When the gate is on, Voice tracks `raceEngineerVolume` and Background
 * tracks `backgroundVolume` (issue #471 — separate slider so users with
 * audio-processing sensitivities can dial the background under the voice
 * without losing it entirely). When the gate is off, both buses are
 * silenced UNLESS a slider Test preview is currently playing — Test
 * buttons are explicit "I want to hear this regardless of the master
 * gate" actions, mirroring how the Radar Test always plays at the
 * configured radar volume even when the radar gate is off. Without the
 * bypass, dragging the volume slider mid-preview (which fires the
 * global-settings listener → `applyRaceEngineerAudio`) would push the
 * bus back to 0 and cut the test off. `AudioBus.Alerts` (radar) is
 * intentionally untouched — it has its own toggle.
 */
export function applyRaceEngineerAudio(): void {
  const enabled = isRaceEngineerEnabled();
  const voice = readRaceEngineerVolume() / 100;
  const background = readBackgroundVolume() / 100;

  const voiceUnmuted = enabled || raceEngineerTestInFlight;
  const backgroundUnmuted = enabled || isBackgroundTestInFlight();

  getAudio().setBusVolume(AudioBus.Voice, voiceUnmuted ? voice : 0);
  getAudio().setBusVolume(AudioBus.Background, backgroundUnmuted ? background : 0);
}

/**
 * Read a JSON-array global-settings value (used for the runtime-pushed
 * voice + driver-name lists). Returns an empty array if missing or
 * malformed — callers treat that as "list not available yet" and skip
 * the dependent path rather than throw.
 */
function readJsonStringArray(key: string): string[] {
  const raw = (getGlobalSettings() as Record<string, unknown>)[key];

  if (typeof raw !== "string" || raw.length === 0) return [];

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    return parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}

/**
 * Chain-play a sequence of clip paths on `AudioChannel.Voice`. Registers
 * the next-step `onChannelComplete` before each `playOnChannel` so the
 * sequence keeps stepping naturally as each clip ends. A failed
 * `playOnChannel` (e.g. clip missing — likely until the user has run
 * `pnpm --filter @iracedeck/audio-assets generate`) silently breaks the
 * chain at that step rather than throwing; the user just hears the
 * earlier clips.
 */
/** @internal Exported for testing the chain-completion + failure paths. */
export function playVoiceSequence(paths: readonly string[], onComplete?: () => void): boolean {
  if (paths.length === 0) return false;

  let idx = 0;
  let finished = false;

  // Idempotent terminal — guards against `onComplete` firing twice (once via
  // the failure path below and again if a stale `playStep` registration is
  // re-entered by a later, unrelated Voice completion).
  const finish = (): void => {
    if (finished) return;

    finished = true;
    onComplete?.();
  };

  const playStep = (): void => {
    // A previous step may have already finished (e.g. mid-chain playback
    // failure). The completion callback registered before that failure is
    // still live in `audio-service`; if any later Voice clip plays through
    // the engine, it will re-fire `playStep`. Bail out so we don't try to
    // resume an abandoned sequence.
    if (finished) return;

    if (idx >= paths.length) {
      finish();

      return;
    }

    const path = paths[idx++];

    // Always register the next-step callback — when `idx` has reached the
    // end on the next invocation, `playStep` will fire `onComplete`. Without
    // this on the last clip, the chain ends silently and callers can't tell
    // the preview is over (used by the RE Volume Test in-flight tracking).
    getAudio().onChannelComplete(AudioChannel.Voice, playStep);

    const ok = getAudio().playOnChannel(AudioChannel.Voice, path);

    // If the clip failed to start (e.g. file missing — likely until the
    // user has run `pnpm --filter @iracedeck/audio-assets generate`), the
    // native layer never fires the channel-complete callback, so the chain
    // would otherwise hang forever and `onComplete` would never run. Fire
    // it synchronously so callers (and any in-flight flag they're tracking)
    // can clean up.
    if (!ok) {
      finish();
    }
  };

  playStep();

  return true;
}

/**
 * @internal Exported for testing.
 *
 * Play the engineer-voice preview sequence on `AudioChannel.Voice`:
 *
 *   <driver name>? <combined greeting clip>
 *
 * Lets the user audition the active voice + radio filter + current bus
 * volume from the PI. Skips the driver-name clip when no name is
 * available (e.g. fresh install before names are pushed). `greeting-01`
 * needs TTS generation — `pnpm --filter @iracedeck/audio-assets generate`
 * produces it per voice. Until then `playVoiceSequence` silently stops
 * at the missing step.
 *
 * Returns false only when no voice is available — the test button logs
 * a warning in that case.
 */
export function playRaceEngineerVoiceTest(onComplete?: () => void): boolean {
  const voice = resolveActiveRaceEngineerVoice(readJsonStringArray("_raceEngineerVoices"));

  if (!voice) return false;

  const driverName = resolveActiveDriverName(readJsonStringArray("_driverNames"), "driver");

  const paths = [
    ...(driverName ? [`voice/${voice}/names/${driverName}.mp3`] : []),
    `voice/${voice}/welcome/greeting-01.mp3`,
  ];

  return playVoiceSequence(paths, onComplete);
}

/**
 * @internal Exported for testing.
 *
 * Push the current global `radarEnabled` into the radar engine. Called on
 * every action mount and after toggling the radar so the tick loop matches
 * the persisted gate.
 */
export function applyRadarEnabled(): void {
  setRadarEnabled(isRadarEnabled());
}

// ─── Icon generation ──────────────────────────────────────────────────────────

/** Artwork bounds of the mechanic SVG (source viewBox 0 0 71.457 71.457). */
const MECHANIC_BOUNDS = { x: 0, y: 0, width: 71.457, height: 71.457 };

/** Raw mechanic path SVG (unscaled, in source coordinate space). Placeholder
 *  artwork — the icon designer replaces with mode-specific art. */
function mechanicPathContent(graphicColor: string): string {
  return `<path fill="${graphicColor}" d="M19.538,23.485c0.02-0.685,0.082-2.768,1.558-3.325c1.46-0.551,2.964,0.948,3.251,1.254c0.377,0.403,0.356,1.036-0.047,1.414c-0.404,0.375-1.036,0.356-1.414-0.047c-0.347-0.367-0.897-0.734-1.106-0.741c0.014,0.028-0.208,0.349-0.243,1.504c-0.11,3.731,2.743,4.773,2.864,4.815c0.31,0.108,0.553,0.364,0.641,0.68l0.046,0.168c0.017,0.06,0.027,0.121,0.033,0.183c0.825,9.836,8.605,13.019,12.244,13.019s11.419-3.182,12.244-13.019c0.005-0.061,0.016-0.121,0.032-0.18l0.046-0.168c0.088-0.322,0.332-0.58,0.649-0.685c0.114-0.04,2.967-1.082,2.857-4.813c-0.038-1.272-0.303-1.533-0.306-1.536c-0.124,0.023-0.689,0.399-1.044,0.774c-0.379,0.4-1.011,0.419-1.413,0.042c-0.401-0.378-0.423-1.008-0.046-1.411c0.287-0.306,1.79-1.805,3.251-1.254c1.476,0.558,1.538,2.641,1.558,3.325c0.109,3.698-2.075,5.741-3.632,6.521c-1.051,9.93-8.88,14.403-14.195,14.403S24.221,39.936,23.17,30.005C21.613,29.226,19.429,27.184,19.538,23.485z M22.099,16.792C22.099,3.017,33.101,0,37.34,0c4.253,0,15.291,3.017,15.291,16.792c0,0.438-0.286,0.826-0.705,0.956l-1.558,0.481l-1.389,1.538c-0.19,0.211-0.46,0.33-0.742,0.33c-0.032,0-0.063-0.001-0.095-0.004c-0.309-0.03-0.585-0.2-0.75-0.461c-0.061-0.087-2.069-2.829-10.027-2.835c-8.044,0.006-10.008,2.809-10.027,2.837c-0.171,0.256-0.458,0.429-0.765,0.452c-0.306,0.028-0.614-0.088-0.821-0.317l-1.389-1.538l-1.558-0.481C22.384,17.619,22.099,17.231,22.099,16.792z M24.111,16.059l1.104,0.341c0.172,0.053,0.326,0.152,0.447,0.285l0.845,0.936c1.322-1.13,4.38-2.819,10.858-2.824c6.478,0.004,9.537,1.694,10.859,2.824l0.844-0.935c0.121-0.134,0.275-0.232,0.447-0.286l1.104-0.341C50.18,2.388,37.471,2,37.34,2C37.21,2,24.548,2.388,24.111,16.059z M26.405,13.627c-0.187-0.52,0.083-1.093,0.602-1.28c1.413-0.509,2.86-0.886,4.321-1.179c-0.227-0.8-0.455-1.6-0.665-2.403c-0.068-0.258-0.029-0.533,0.107-0.762c0.136-0.23,0.358-0.396,0.617-0.46c3.966-0.995,7.988-0.995,11.954,0c0.259,0.065,0.481,0.23,0.617,0.46c0.136,0.229,0.175,0.504,0.107,0.762c-0.21,0.802-0.438,1.602-0.665,2.403c1.461,0.293,2.908,0.67,4.321,1.179c0.52,0.187,0.789,0.76,0.602,1.28c-0.147,0.408-0.531,0.661-0.941,0.662c-0.112,0-0.227-0.02-0.339-0.06c-6.242-2.248-13.117-2.248-19.359,0C27.165,14.415,26.593,14.146,26.405,13.627z M33.31,10.841c2.692-0.359,5.417-0.359,8.109,0c0.151-0.528,0.303-1.055,0.446-1.584c-2.992-0.613-6.011-0.613-9.002,0C33.007,9.786,33.159,10.313,33.31,10.841z M70.32,32.224v5.108c0,0.536-0.286,1.031-0.75,1.299l-3.674,2.121v12.558c0,0.028-0.007,0.053-0.008,0.08c1.211,0.175,2.134,0.577,2.783,1.228c1.194,1.201,1.185,2.886,1.177,4.373l-0.001,6.939c0,3.005-2.445,5.45-5.45,5.45c-3.005,0-5.45-2.445-5.45-5.45l-0.001-6.939c-0.008-1.487-0.017-3.172,1.177-4.373c0.648-0.652,1.572-1.053,2.783-1.228c-0.001-0.027-0.008-0.053-0.008-0.08v-1.539c-1.027-3.481-3.123-6.704-5.941-9.243l-2.758,7.851v21.078H37.365H20.534V50.379l-2.859-8.137c-3.937,3.24-6.539,7.58-7.099,12.155c0.093,0.076,0.205,0.137,0.289,0.221c1.194,1.201,1.185,2.886,1.177,4.373l-0.001,6.94c0,3.005-2.445,5.45-5.45,5.45c-3.005,0-5.45-2.445-5.45-5.45l-0.001-6.939c-0.008-1.487-0.017-3.172,1.177-4.373c0.462-0.465,1.066-0.8,1.81-1.021v-5.294c0-0.552,0.448-1,1-1H5.84v-9.639c0-0.414,0.336-0.75,0.75-0.75s0.75,0.336,0.75,0.75v9.639h0.714c0.552,0,1,0.448,1,1v3.43c1.168-4.387,3.992-8.435,7.921-11.485l-0.296-0.842c-0.183-0.521,0.091-1.092,0.612-1.275c0.522-0.184,1.092,0.091,1.275,0.612l0.101,0.289c1.356-0.885,2.817-1.659,4.369-2.296c0.255-0.105,0.543-0.1,0.794,0.015c0.251,0.114,0.444,0.328,0.533,0.589c1.758,5.181,6.816,8.529,12.886,8.529c6.071,0,11.129-3.348,12.887-8.529c0.088-0.261,0.281-0.475,0.533-0.589c0.251-0.115,0.539-0.12,0.794-0.015c1.612,0.662,3.126,1.51,4.531,2.494l0.171-0.486c0.183-0.521,0.753-0.795,1.275-0.612c0.521,0.183,0.795,0.754,0.612,1.275l-0.385,1.096c2.118,1.782,3.894,3.914,5.229,6.253v-6.004l-3.674-2.121c-0.464-0.268-0.75-0.763-0.75-1.299v-5.108c0-0.829,0.671-1.5,1.5-1.5s1.5,0.671,1.5,1.5v4.242l2.924,1.688l2.924-1.688v-4.242c0-0.829,0.671-1.5,1.5-1.5S70.32,31.395,70.32,32.224z M6.126,52.618h0.928v-3.314H6.126V52.618z M9.735,67.334H7.698c-0.552,0-1-0.448-1-1s0.448-1,1-1h2.341l0-1.688H7.698c-0.552,0-1-0.448-1-1s0.448-1,1-1h2.342l0-1.822H7.698c-0.552,0-1-0.448-1-1s0.448-1,1-1h2.325c-0.041-0.741-0.171-1.387-0.577-1.795c-0.491-0.494-1.452-0.745-2.856-0.745s-2.365,0.25-2.856,0.745c-0.608,0.611-0.602,1.748-0.595,2.952l0.001,6.95c0,1.902,1.548,3.45,3.45,3.45C7.992,69.381,9.196,68.538,9.735,67.334z M23.625,52.599c0-0.352-0.286-0.638-0.638-0.638c-0.352,0-0.638,0.286-0.638,0.638c0,0.352,0.286,0.638,0.638,0.638C23.339,53.237,23.625,52.951,23.625,52.599z M46.393,62.333c0-0.552-0.448-1-1-1H29.337c-0.552,0-1,0.448-1,1s0.448,1,1,1h16.056C45.945,63.333,46.393,62.885,46.393,62.333z M37.365,53.237c0.352,0,0.638-0.286,0.638-0.638c0-0.352-0.286-0.638-0.638-0.638c-0.352,0-0.638,0.286-0.638,0.638C36.727,52.951,37.013,53.237,37.365,53.237z M52.381,52.599c0-0.352-0.286-0.638-0.638-0.638c-0.352,0-0.638,0.286-0.638,0.638c0,0.352,0.286,0.638,0.638,0.638C52.095,53.237,52.381,52.951,52.381,52.599z M55.304,41.191c-1.139-0.841-2.363-1.584-3.664-2.193c-2.32,5.424-7.85,8.871-14.392,8.871c-6.542,0-12.073-3.448-14.393-8.874c-1.242,0.571-2.412,1.241-3.505,1.986l3.223,9.175h14.79h14.79L55.304,41.191z M67.252,56.029c-0.491-0.494-1.453-0.745-2.856-0.745c-1.404,0-2.365,0.25-2.856,0.745c-0.406,0.409-0.536,1.054-0.577,1.795h2.325c0.552,0,1,0.448,1,1s-0.448,1-1,1h-2.343l0,1.822h2.343c0.552,0,1,0.448,1,1s-0.448,1-1,1h-2.342l0,1.688h2.342c0.552,0,1,0.448,1,1s-0.448,1-1,1H61.25c0.539,1.204,1.743,2.047,3.145,2.047c1.902,0,3.45-1.548,3.45-3.45l0.001-6.95C67.853,57.777,67.86,56.641,67.252,56.029z M37.979,24.528v4.953h-2.228c-0.552,0-1,0.448-1,1s0.448,1,1,1h3.228c0.552,0,1-0.448,1-1v-5.953c0-0.552-0.448-1-1-1S37.979,23.976,37.979,24.528z"/>`;
}

/**
 * Simple stroked radar-sweep glyph for the Radar-family modes. Placeholder —
 * the icon designer replaces with proper artwork in a follow-up commit.
 * Drawn inside MECHANIC_BOUNDS so it flows through the same scaling pipeline
 * as the mechanic glyph.
 */
function radarPathContent(color: string): string {
  return (
    `<g fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round">` +
    `<circle cx="35.7" cy="35.7" r="30"/>` +
    `<circle cx="35.7" cy="35.7" r="18"/>` +
    `<circle cx="35.7" cy="35.7" r="6"/>` +
    `<line x1="35.7" y1="35.7" x2="62.7" y2="20.7"/>` +
    `</g>`
  );
}

function arrowUpPath(color: string): string {
  return `<path fill="${color}" d="M35.7 10 L60 50 L45 50 L45 65 L26 65 L26 50 L11 50 Z"/>`;
}

function arrowDownPath(color: string): string {
  return `<path fill="${color}" d="M35.7 65 L11 25 L26 25 L26 10 L45 10 L45 25 L60 25 Z"/>`;
}

/** Returns the per-mode default title text and whether the status bar paints. */
function modePresentation(
  mode: Mode,
  direction: "up" | "down",
  radarVolume: number,
): { defaultTitle: string; stateIndicator: "on" | "off" | null } {
  switch (mode) {
    case "race-engineer":
      return {
        defaultTitle: "RACE\nENGINEER",
        stateIndicator: isRaceEngineerEnabled() ? "on" : "off",
      };
    case "radar":
      return {
        defaultTitle: "RADAR",
        stateIndicator: isRadarEnabled() ? "on" : "off",
      };
    case "radar-volume":
      return {
        defaultTitle: `${direction === "up" ? "VOL +" : "VOL −"}\n${radarVolume}%`,
        stateIndicator: null,
      };
  }
}

/**
 * @internal Exported for testing.
 *
 * Generates a complete SVG data URI for the Pit Crew icon. The artwork and
 * status bar vary per mode; feature on/off state is read from global
 * settings so every instance of a given mode shows the same state.
 */
export function generatePitCrewSvg(settings: PitCrewSettings): string {
  const colors = resolveIconColors(pitCrewTemplate, getGlobalColors(), settings.colorOverrides) as Record<
    string,
    string
  >;

  const graphicColor = colors.graphic1Color ?? WHITE;
  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);
  const { defaultTitle, stateIndicator } = modePresentation(settings.mode, settings.direction, readRadarVolume());
  const title = resolveTitleSettings(pitCrewTemplate, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  // Status bar, when present, occupies y=100..144. Shrink the graphic area
  // so the artwork sits above it. Volume modes have no status bar, so the
  // artwork can fill the full available area.
  const STATUS_BAR_TOP = 100;
  const PADDING = 8;
  const fullGraphicArea = computeGraphicArea(title);
  const graphicArea =
    stateIndicator === null
      ? fullGraphicArea
      : {
          ...fullGraphicArea,
          height: Math.min(fullGraphicArea.height, STATUS_BAR_TOP - PADDING - fullGraphicArea.y),
        };

  const rawPath = pickArtwork(settings.mode, settings.direction, graphicColor);
  const scaledGraphic = title.showGraphics
    ? applyGraphicTransform(rawPath, MECHANIC_BOUNDS, graphicArea, graphic.scale)
    : "";

  const titleText = title.showTitle
    ? generateTitleText({
        text: title.titleText ?? defaultTitle,
        fontSize: title.fontSize,
        bold: title.bold,
        position: title.position,
        customPosition: title.customPosition,
        fill: colors.textColor ?? WHITE,
      })
    : "";

  const statusBar = stateIndicator === "on" ? statusBarOn() : stateIndicator === "off" ? statusBarOff() : "";
  const iconContent = scaledGraphic + titleText + statusBar;

  const border = resolveBorderSettings(
    pitCrewTemplate,
    getGlobalBorderSettings(),
    settings.borderOverrides,
    stateIndicator !== null ? borderColorForState(stateIndicator) : undefined,
  );
  const borderSvg = generateBorderParts(border);

  const svg = renderIconTemplate(pitCrewTemplate, {
    iconContent,
    borderDefs: borderSvg.defs,
    borderContent: borderSvg.rects,
    ...colors,
  });

  return svgToDataUri(svg);
}

function pickArtwork(mode: Mode, direction: "up" | "down", color: string): string {
  switch (mode) {
    case "race-engineer":
      return mechanicPathContent(color);
    case "radar":
      return radarPathContent(color);
    case "radar-volume":
      return radarPathContent(color) + (direction === "up" ? arrowUpPath(color) : arrowDownPath(color));
  }
}

// ─── Action ────────────────────────────────────────────────────────────────────

export class PitCrew extends ConnectionStateAwareAction<PitCrewSettings> {
  /** Per-context settings cache for visible instances. */
  private readonly settingsCache = new Map<string, PitCrewSettings>();

  /** Set of currently visible context IDs. */
  private readonly visibleContexts = new Set<string>();

  /** Per-context unsubscribe callback for the global-settings listener. */
  private readonly listenerUnsubs = new Map<string, () => void>();

  /**
   * Last radar test-volume timestamp per context. Keyed per visible instance
   * so two Pit Crew buttons on different pages don't overwrite each other's
   * baseline and spuriously replay the preview on a settings echo.
   */
  private readonly lastRadarTestTimestamps = new Map<string, number>();

  /** Per-context baseline for the engineer-voice test button (mirrors radar). */
  private readonly lastRaceEngineerTestTimestamps = new Map<string, number>();

  /** Per-context baseline for the Background Volume test button (issue #471). */
  private readonly lastBackgroundTestTimestamps = new Map<string, number>();

  override async onWillAppear(ev: IDeckWillAppearEvent<PitCrewSettings>): Promise<void> {
    await super.onWillAppear(ev);

    const raw = ev.payload.settings as Record<string, unknown>;
    const settings = Settings.parse(raw);
    const contextId = ev.action.id;

    this.settingsCache.set(contextId, settings);
    this.visibleContexts.add(contextId);

    // Seed test-button timestamps so the first onDidReceiveSettings doesn't
    // replay the previous play when the PI rehydrates the hidden textfields.
    this.lastRadarTestTimestamps.set(contextId, Number(raw._testRadarVolume ?? 0));
    this.lastRaceEngineerTestTimestamps.set(contextId, Number(raw._testRaceEngineerVoice ?? 0));
    this.lastBackgroundTestTimestamps.set(contextId, Number(raw._testBackgroundVolume ?? 0));

    // Re-render on any global-settings change — every mode depends on at
    // least one global, so every change can affect the rendered state bar
    // or volume read-out. Also push the updated values into the live audio
    // layer: the PI's global Radar Volume slider and any other Pit Crew
    // instance's key press go through global settings, so this action has
    // to mirror them onto `AudioBus.Alerts` and the radar engine's gate
    // right when the global flips — not on next mount.
    this.listenerUnsubs.set(
      contextId,
      onGlobalSettingsChange(() => {
        applyRadarVolume();
        applyRadarEnabled();
        applyRaceEngineerAudio();
        void this.rerender(contextId);
      }),
    );

    // Mirror current global state into the live audio layer. Idempotent —
    // the first mount sets the initial values; later mounts re-assert them.
    applyRadarVolume();
    applyRadarEnabled();
    applyRaceEngineerAudio();

    await this.setKeyImage(ev, generatePitCrewSvg(settings));

    this.setRegenerateCallback(contextId, () => {
      const s = this.settingsCache.get(contextId);

      if (!s) return "";

      return generatePitCrewSvg(s);
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<PitCrewSettings>): Promise<void> {
    const contextId = ev.action.id;

    this.listenerUnsubs.get(contextId)?.();
    this.listenerUnsubs.delete(contextId);
    this.settingsCache.delete(contextId);
    this.visibleContexts.delete(contextId);
    this.lastRadarTestTimestamps.delete(contextId);
    this.lastRaceEngineerTestTimestamps.delete(contextId);
    this.lastBackgroundTestTimestamps.delete(contextId);

    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<PitCrewSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);

    const raw = ev.payload.settings as Record<string, unknown>;
    const settings = Settings.parse(raw);
    const contextId = ev.action.id;

    this.settingsCache.set(contextId, settings);

    // `_testRadarVolume` is written by the PI as `String(Date.now())` — the
    // Stream Deck settings round-trip preserves strings, so coerce to a number
    // on both sides of the compare. A raw `string !== number` mismatch would
    // fire the preview on every PI rehydrate.
    const radarTestTimestamp = Number(raw._testRadarVolume ?? 0);
    const lastRadarTestTimestamp = this.lastRadarTestTimestamps.get(contextId) ?? 0;

    if (radarTestTimestamp > 0 && radarTestTimestamp !== lastRadarTestTimestamp) {
      this.logger.info("Playing radar test: left → right → both");
      playRadarTest();
    }

    this.lastRadarTestTimestamps.set(contextId, radarTestTimestamp);

    // Same edge-trigger pattern for the engineer-voice Test button.
    const voiceTestTimestamp = Number(raw._testRaceEngineerVoice ?? 0);
    const lastVoiceTestTimestamp = this.lastRaceEngineerTestTimestamps.get(contextId) ?? 0;

    if (voiceTestTimestamp > 0 && voiceTestTimestamp !== lastVoiceTestTimestamp) {
      this.logger.info("Playing race engineer voice test");

      // Force the Voice bus to the slider value so the preview is audible
      // even when Race Engineer is off (the master gate would otherwise
      // hold it at 0). Set the in-flight flag first so any global-settings
      // listener firing mid-preview (e.g. user dragging the volume slider)
      // doesn't re-mute the bus via applyRaceEngineerAudio.
      _setRaceEngineerTestInFlightForTests(true);
      getAudio().setBusVolume(AudioBus.Voice, readRaceEngineerVolume() / 100);

      const started = playRaceEngineerVoiceTest(() => {
        _setRaceEngineerTestInFlightForTests(false);
        applyRaceEngineerAudio();
      });

      if (!started) {
        _setRaceEngineerTestInFlightForTests(false);
        applyRaceEngineerAudio();
        this.logger.warn("Race engineer voice test skipped — no voice available");
      }
    }

    this.lastRaceEngineerTestTimestamps.set(contextId, voiceTestTimestamp);

    // Same edge-trigger pattern for the Background Volume Test button
    // (#471). isBackgroundTestInFlight (set inside playBackgroundTest)
    // bypasses the Background-mute branch of applyRaceEngineerAudio while
    // the preview is playing, so dragging the slider mid-preview updates
    // the bus volume live instead of cutting the test off.
    const backgroundTestTimestamp = Number(raw._testBackgroundVolume ?? 0);
    const lastBackgroundTestTimestamp = this.lastBackgroundTestTimestamps.get(contextId) ?? 0;

    if (backgroundTestTimestamp > 0 && backgroundTestTimestamp !== lastBackgroundTestTimestamp) {
      this.logger.info("Playing background test: tick-open + ambient + tick-close");
      getAudio().setBusVolume(AudioBus.Background, readBackgroundVolume() / 100);
      playBackgroundTest(() => applyRaceEngineerAudio());
    }

    this.lastBackgroundTestTimestamps.set(contextId, backgroundTestTimestamp);

    await this.setKeyImage(ev, generatePitCrewSvg(settings));
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<PitCrewSettings>): Promise<void> {
    const settings = Settings.parse(ev.payload.settings);

    switch (settings.mode) {
      case "race-engineer":
        this.toggleRaceEngineer();
        break;
      case "radar":
        this.toggleRadar();
        break;
      case "radar-volume":
        this.stepRadarVolume(settings.direction);
        break;
    }

    await this.rerenderAll();
  }

  private toggleRaceEngineer(): void {
    const next = !isRaceEngineerEnabled();
    this.logger.info(`Race Engineer ${next ? "enabled" : "disabled"}`);
    updateGlobalSettings({ raceEngineerEnabled: next });
    // Mirror the radar pattern: apply the gate to Voice + Background
    // synchronously so an in-flight engineer clip is silenced on the same
    // tick the user pressed the key. Relying on the global-settings
    // round-trip echo would let a clip continue for the IPC round trip,
    // and the user perceives the toggle as broken.
    applyRaceEngineerAudio();
  }

  private toggleRadar(): void {
    const next = !isRadarEnabled();
    this.logger.info(`Radar ${next ? "enabled" : "disabled"}`);
    // Flip the engine synchronously so the tick loop stops/starts
    // immediately. Relying on the global-settings round-trip echo would let
    // a tick fire after the user already released the key.
    setRadarEnabled(next);
    updateGlobalSettings({ radarEnabled: next });
  }

  private stepRadarVolume(direction: "up" | "down"): void {
    const current = readRadarVolume();
    const next = Math.max(
      VOLUME_MIN,
      Math.min(VOLUME_MAX, current + (direction === "up" ? VOLUME_STEP : -VOLUME_STEP)),
    );

    if (next === current) return;

    this.logger.info(`Radar volume ${direction}: ${current} → ${next}`);
    getAudio().setBusVolume(AudioBus.Alerts, next / 100);
    updateGlobalSettings({ radarVolume: next });
  }

  private async rerenderAll(): Promise<void> {
    for (const contextId of this.visibleContexts) {
      await this.rerender(contextId);
    }
  }

  private async rerender(contextId: string): Promise<void> {
    const settings = this.settingsCache.get(contextId);

    if (!settings) return;

    await this.updateKeyImage(contextId, generatePitCrewSvg(settings));
  }
}
