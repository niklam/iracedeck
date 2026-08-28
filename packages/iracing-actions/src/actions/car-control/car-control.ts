import {
  applyBindingWarning,
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  generateBorderParts,
  generateTitleText,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  getKeyboard,
  getSDK,
  IconUpdateThrottle,
  type IDeckDialDownEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckKeyUpEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  renderIconTemplate,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
} from "@iracedeck/deck-core";
import enterCarIcon from "@iracedeck/icons/car-control/enter-car.svg";
import escapeIcon from "@iracedeck/icons/car-control/escape.svg";
import exitCarIcon from "@iracedeck/icons/car-control/exit-car.svg";
import handbrakeIcon from "@iracedeck/icons/car-control/handbrake.svg";
import headlightFlashIcon from "@iracedeck/icons/car-control/headlight-flash.svg";
import ignitionIcon from "@iracedeck/icons/car-control/ignition.svg";
import pauseSimIcon from "@iracedeck/icons/car-control/pause-sim.svg";
import resetToPitsIcon from "@iracedeck/icons/car-control/reset-to-pits.svg";
import secondClutchIcon from "@iracedeck/icons/car-control/second-clutch.svg";
import secondDownShiftIcon from "@iracedeck/icons/car-control/second-down-shift.svg";
import secondUpShiftIcon from "@iracedeck/icons/car-control/second-up-shift.svg";
import sessionGridIcon from "@iracedeck/icons/car-control/session-grid.svg";
import sessionQualifyIcon from "@iracedeck/icons/car-control/session-qualify.svg";
import sessionRaceIcon from "@iracedeck/icons/car-control/session-race.svg";
import starterIcon from "@iracedeck/icons/car-control/starter.svg";
import tearOffVisorIcon from "@iracedeck/icons/car-control/tear-off-visor.svg";
import towIcon from "@iracedeck/icons/car-control/tow.svg";
import {
  EngineWarnings,
  hasFlag,
  hasPitLimiter,
  isLiveOnTrack,
  SessionState,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import z from "zod";

import drsTemplate from "../../../icons/car-control-drs.svg";
import ignitionTemplate from "../../../icons/car-control-ignition.svg";
import pitLimiterTemplate from "../../../icons/car-control-pit-limiter.svg";
import pushToPassTemplate from "../../../icons/car-control-push-to-pass.svg";
import starterTemplate from "../../../icons/car-control-starter.svg";
import {
  borderColorForState,
  generateToggleStateSvg,
  statusBarNA,
  statusBarOff,
  statusBarOn,
  type ToggleState,
} from "../../icons/status-bar.js";

const WHITE = "#ffffff";
const GRAY = "#888888";

/**
 * Semantic background colors for the context-aware Enter/Exit/Tow mode (issue #632).
 * State-driven — never overridable by user color presets, mirroring iRacing's own UI button.
 */
const SESSION_BG_GREEN = "#0fa30f";
const SESSION_BG_BLUE = "#1f5fd6";
const SESSION_BG_PURPLE = "#9013f5";
const IN_CAR_BG_RED = "#ff0000";

type CarControlType =
  | "starter"
  | "ignition"
  | "pit-speed-limiter"
  | "enter-exit-tow"
  | "pause-sim"
  | "headlight-flash"
  | "push-to-pass"
  | "drs"
  | "tear-off-visor"
  | "escape"
  | "handbrake"
  | "second-clutch"
  | "second-up-shift"
  | "second-down-shift";

/** @internal Exported for testing */
export type EnterExitTowState = "enter-car" | "exit-car" | "reset-to-pits" | "tow";

const ENTER_EXIT_TOW_ICONS: Record<EnterExitTowState, string> = {
  "enter-car": enterCarIcon,
  "exit-car": exitCarIcon,
  "reset-to-pits": resetToPitsIcon,
  tow: towIcon,
};

const ENTER_EXIT_TOW_TITLES: Record<EnterExitTowState, string> = {
  "enter-car": "DRIVE",
  "exit-car": "EXIT",
  "reset-to-pits": "RESET",
  tow: "TOW",
};

const CAR_CONTROL_STATIC_TITLES: Partial<Record<CarControlType, string>> = {
  starter: "ENGINE\nSTART",
  ignition: "ON/OFF\nIGNITION",
  "pause-sim": "SIM\nPAUSE",
  "headlight-flash": "FLASH\nHEADLIGHT",
  "tear-off-visor": "VISOR\nTEAR OFF",
  escape: "ESCAPE",
  handbrake: "HANDBRAKE",
  "second-clutch": "CLUTCH",
  "second-up-shift": "SHIFT UP",
  "second-down-shift": "SHIFT DOWN",
};

const DEFAULT_PIT_SPEED = 80;

/**
 * Controls that use telemetry-driven dynamic icons.
 * Keep in sync with getTelemetryState() and buildStateKey().
 */
const TELEMETRY_AWARE_CONTROLS = new Set<CarControlType>([
  "pit-speed-limiter",
  "push-to-pass",
  "drs",
  "enter-exit-tow",
  "ignition",
  "starter",
]);

/** Controls that use hold pattern (press on keyDown, release on keyUp) */
const HOLD_CONTROLS = new Set<CarControlType>([
  "starter",
  "headlight-flash",
  "enter-exit-tow",
  "handbrake",
  "second-clutch",
]);

/** Hardcoded ESC key combination (not configurable — ESC is always ESC in iRacing) */
const ESC_KEY = { key: "escape", code: "Escape" } as const;

/** Auto-hold duration in milliseconds */
const AUTO_HOLD_DURATION = 1500;

/**
 * @internal Exported for testing
 *
 * Parse the pit speed limit from session info string (e.g. "80.00 kph") to an integer.
 */
export function parsePitSpeedLimit(value: string | undefined): number {
  if (!value) return DEFAULT_PIT_SPEED;

  const match = value.match(/^(\d+)/);

  return match ? parseInt(match[1], 10) : DEFAULT_PIT_SPEED;
}

/**
 * @internal Exported for testing
 *
 * Get pit speed limit from session info.
 */
export function getPitSpeedLimit(): number {
  const sessionInfo = getSDK().sdk.getSessionInfo();
  const weekendInfo = sessionInfo?.WeekendInfo as Record<string, unknown> | undefined;

  return parsePitSpeedLimit(weekendInfo?.TrackPitSpeedLimit as string | undefined);
}

/**
 * @internal Exported for testing
 *
 * Pit limiter speed-number graphic — the pit-speed-limit number inside a circle, drawn the
 * same way in every state (issue #638). The on/off/not-available state is conveyed by the
 * status bar (green ON / red OFF / grey N/A) and the border colour, mirroring the other
 * tri-state buttons (Fast Repair, Windshield Tear-off, Auto-Fuel); the circle keeps the
 * button recognizable and keeps showing the track's pit-speed limit, which stays meaningful
 * even on cars without a limiter.
 *
 * The title ("PIT LIMITER") is hidden by default, so the circle grows to fill the space
 * above the status bar. When the user turns the title on, pass `compact` to shrink the
 * circle and drop it below the top title.
 */
export function pitLimiterSpeedGraphic(speed: number, compact = false): string {
  // Two presets, each editable as a unit: the compact circle leaves room for the title at the
  // top; the large circle (title hidden, the default) fills the space above the status bar.
  // `textY` sits the number a few px below the circle centre so it reads optically centred.
  const { cy, r, fontSize, textY } = compact
    ? { cy: 66, r: 24, fontSize: 22, textY: 74 }
    : { cy: 53, r: 33, fontSize: 30, textY: 64 };

  return `
    <circle cx="72" cy="${cy}" r="${r}" fill="${WHITE}" stroke="${GRAY}" stroke-width="6"/>
    <text x="72" y="${textY}" text-anchor="middle"
          fill="#2a3a2a" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold">${speed}</text>`;
}

/**
 * @internal Exported for testing
 *
 * DRS icon — status bar only (title text handled by title settings system).
 * Undefined `active` means no telemetry available → gray N/A.
 */
export function drsIcon(active: boolean | undefined): string {
  if (active === undefined) return statusBarNA();

  return active ? statusBarOn() : statusBarOff();
}

/**
 * @internal Exported for testing
 *
 * Push To Pass icon — status bar only (title text handled by title settings system).
 * Undefined `active` means no telemetry available → gray N/A.
 */
export function pushToPassIcon(active: boolean | undefined): string {
  if (active === undefined) return statusBarNA();

  return active ? statusBarOn() : statusBarOff();
}

/**
 * Standalone SVG templates for static car control modes (imported from @iracedeck/icons)
 */
const STATIC_CAR_CONTROL_ICONS: Partial<Record<CarControlType, string>> = {
  starter: starterIcon,
  ignition: ignitionIcon,
  "pause-sim": pauseSimIcon,
  "headlight-flash": headlightFlashIcon,
  "tear-off-visor": tearOffVisorIcon,
  escape: escapeIcon,
  handbrake: handbrakeIcon,
  "second-clutch": secondClutchIcon,
  "second-up-shift": secondUpShiftIcon,
  "second-down-shift": secondDownShiftIcon,
};

/**
 * @internal Exported for testing
 *
 * Mapping from car control setting values (kebab-case) to global settings keys.
 */
export const CAR_CONTROL_GLOBAL_KEYS: Record<CarControlType, string> = {
  starter: "carControlStarter",
  ignition: "carControlIgnition",
  "pit-speed-limiter": "carControlPitSpeedLimiter",
  "enter-exit-tow": "carControlEnterExitTow",
  "pause-sim": "carControlPauseSim",
  "headlight-flash": "carControlHeadlightFlash",
  "push-to-pass": "carControlPushToPass",
  drs: "carControlDrs",
  "tear-off-visor": "carControlTearOffVisor",
  escape: "",
  handbrake: "carControlHandbrake",
  "second-clutch": "carControlSecondClutch",
  "second-up-shift": "carControlSecondUpShift",
  "second-down-shift": "carControlSecondDownShift",
};

/**
 * @internal Exported for testing
 *
 * Determines the Enter/Exit/Tow state based on telemetry and session info.
 * Priority order: enter-car → exit-car → reset-to-pits/tow (based on session type).
 */
export function getEnterExitTowState(
  telemetry: TelemetryData | null,
  sessionInfo: Record<string, unknown> | null,
): EnterExitTowState {
  if (!telemetry || !telemetry.IsOnTrack) {
    return "enter-car";
  }

  if (telemetry.PlayerCarInPitStall) {
    return "exit-car";
  }

  // On track, not in pit stall — check session type
  const sessionNum = telemetry.SessionNum ?? 0;
  const sessions = (sessionInfo?.SessionInfo as Record<string, unknown> | undefined)?.Sessions as
    Array<Record<string, unknown>> | undefined;
  const currentSession = sessions?.find((s) => s.SessionNum === sessionNum);
  const sessionType = currentSession?.SessionType as string | undefined;

  if (sessionType === "Race") {
    return "tow";
  }

  return "reset-to-pits";
}

/** @internal Exported for testing */
export type SessionContext = "test" | "practice" | "qualify" | "grid" | "race" | "unknown";

/**
 * @internal Exported for testing
 *
 * Classifies the current session for the context-aware enter-car appearance (issue #632).
 * Mirrors iRacing's own UI button: Test / Practice / Qualify / Grid (race not yet started) /
 * Race (racing, checkered, cooldown). Returns "unknown" when telemetry or session info is
 * unavailable so callers can fall back to the legacy neutral appearance.
 */
export function getSessionContext(
  telemetry: TelemetryData | null,
  sessionInfo: Record<string, unknown> | null,
): SessionContext {
  if (!telemetry) {
    return "unknown";
  }

  const sessionNum = telemetry.SessionNum ?? 0;
  const sessions = (sessionInfo?.SessionInfo as Record<string, unknown> | undefined)?.Sessions as
    Array<Record<string, unknown>> | undefined;
  const currentSession = sessions?.find((s) => s.SessionNum === sessionNum);
  const sessionType = currentSession?.SessionType as string | undefined;

  if (!sessionType) {
    return "unknown";
  }

  if (sessionType.includes("Testing")) {
    return "test";
  }

  if (sessionType.includes("Practice")) {
    return "practice";
  }

  if (sessionType.includes("Qualify")) {
    return "qualify";
  }

  // Race-like session (Race / Warmup / Heat): split on SessionState — gridding,
  // warmup, and parade laps count as "grid"; racing and beyond count as "race".
  const state = telemetry.SessionState;

  if (state !== undefined && state >= SessionState.Racing) {
    return "race";
  }

  return "grid";
}

/**
 * Per-session-context appearance for the enter-car state (issue #632).
 * "unknown" (no session info) keeps the legacy neutral steering-wheel look.
 */
const SESSION_CONTEXT_ICONS: Record<SessionContext, string> = {
  test: enterCarIcon, // intentionally the same steering wheel as the default enter-car icon
  practice: enterCarIcon, // intentionally the same steering wheel as the default enter-car icon
  qualify: sessionQualifyIcon,
  grid: sessionGridIcon,
  race: sessionRaceIcon,
  unknown: enterCarIcon,
};

/** Default key label per session context, passed to resolveTitleSettings as the action default text. */
const SESSION_CONTEXT_TITLES: Record<SessionContext, string> = {
  test: "TEST",
  practice: "PRACTICE",
  qualify: "QUALIFY",
  grid: "GRID",
  race: "RACE",
  // Unknown context follows whatever the legacy enter-car default label is.
  unknown: ENTER_EXIT_TOW_TITLES["enter-car"],
};

/** Background per context; undefined = keep the resolved (user/global/icon) background. */
const SESSION_CONTEXT_BACKGROUNDS: Record<SessionContext, string | undefined> = {
  test: SESSION_BG_GREEN,
  practice: SESSION_BG_BLUE,
  qualify: SESSION_BG_PURPLE,
  grid: SESSION_BG_GREEN,
  race: SESSION_BG_GREEN,
  unknown: undefined,
};

/**
 * @internal Exported for testing
 *
 * Check if pit speed limiter is active from telemetry.
 */
export function isPitLimiterActive(telemetry: TelemetryData | null): boolean {
  if (!telemetry || telemetry.EngineWarnings === undefined) return false;

  return hasFlag(telemetry.EngineWarnings, EngineWarnings.PitSpeedLimiter);
}

/**
 * @internal Exported for testing
 *
 * Whether the current car has a pit speed limiter (issue #638). Wraps the shared
 * capability helper `hasPitLimiter` so the tri-state pit-limiter button can render a
 * greyed-out N/A state on cars without a limiter. Null telemetry ⇒ treated as available
 * so the button keeps its normal on/off look until a car snapshot is known (no premature
 * grey-out before connection).
 */
export function isPitLimiterAvailable(telemetry: TelemetryData | null): boolean {
  if (!telemetry) return true;

  return hasPitLimiter(telemetry);
}

/**
 * @internal Exported for testing
 *
 * Resolves the pit-limiter tri-state (issue #638): not-available wins over the on/off flag,
 * so a car with no limiter always reads "na". Shared by the icon renderer and the state key
 * so the dedupe key always matches the rendered state (no churn when the on/off flag — which
 * has no meaning on a no-limiter car — toggles while the car stays N/A).
 */
export function pitLimiterToggleState(available: boolean, active: boolean): "on" | "off" | "na" {
  if (!available) return "na";

  return active ? "on" : "off";
}

/**
 * Voltage at or above this counts as "the ignition circuit is live".
 *
 * iRacing exposes no ignition telemetry of any kind — there is no `Ignition`, no
 * `dcIgnition`, and nothing among the 429 documented variables describing one — so
 * engine voltage is the only available proxy: ~0 V with the ignition off, ~13.4 V
 * with it on. The threshold sits midway between those rather than hugging zero, so
 * neither sensor noise nor a partially-energised bus can flip it.
 */
const IGNITION_VOLTAGE_THRESHOLD_V = 6;

/**
 * RPM at or above this counts as "engine running" on the FALLBACK path only — when
 * `EngineWarnings` is absent and the authoritative EngineStalled bit cannot be read.
 * Captured telemetry puts a stopped engine at exactly 300 RPM and the lowest running
 * idle near 900, so this sits clear of both. It is deliberately not a per-car tuning
 * knob; the bit below is what normally decides.
 */
const ENGINE_RUNNING_RPM_FLOOR = 500;

/** Maps a known/unknown boolean onto the shared tri-state: unknown is N/A, never "off". */
function toggleStateFromKnown(value: boolean | undefined): ToggleState {
  if (value === undefined) return "na";

  return value ? "on" : "off";
}

/**
 * @internal Exported for testing
 *
 * Whether the ignition circuit is live, from `Voltage` (see
 * IGNITION_VOLTAGE_THRESHOLD_V for why that is the only available signal).
 *
 * Returns undefined — not false — when there is no telemetry or no `Voltage`, so the
 * caller renders N/A instead of a confident "ignition off" against a disconnected sim.
 */
export function isIgnitionOn(telemetry: TelemetryData | null): boolean | undefined {
  const voltage = telemetry?.Voltage;

  if (typeof voltage !== "number" || !Number.isFinite(voltage)) return undefined;

  return voltage >= IGNITION_VOLTAGE_THRESHOLD_V;
}

/**
 * @internal Exported for testing
 *
 * Whether the engine is turning over.
 *
 * `EngineWarnings.EngineStalled` is authoritative and needs no per-car tuning, so it
 * decides whenever the bitfield is present; the RPM floor is only a fallback for a
 * snapshot that lacks it. Returns undefined when neither signal is available.
 *
 * Note this deliberately does not try to answer "is the driver in the car" — a replay
 * reports a stopped engine with the stalled bit clear. That question belongs to the
 * N/A state, which is resolved from the absence of telemetry rather than from here.
 */
export function isEngineRunning(telemetry: TelemetryData | null): boolean | undefined {
  if (!telemetry) return undefined;

  const warnings = telemetry.EngineWarnings;

  if (typeof warnings === "number" && Number.isFinite(warnings)) {
    return !hasFlag(warnings, EngineWarnings.EngineStalled);
  }

  const rpm = telemetry.RPM;

  if (typeof rpm !== "number" || !Number.isFinite(rpm)) return undefined;

  return rpm >= ENGINE_RUNNING_RPM_FLOOR;
}

/**
 * @internal Exported for testing
 *
 * Tri-state shown on the Ignition key (issue #561). Shared by the icon renderer and
 * the state key so the dedupe key can never disagree with what was drawn — the same
 * reason pitLimiterToggleState is shared.
 *
 * Anything but a driver live in their own car reads N/A: a replay still publishes a
 * full telemetry frame, so without this gate a replay would render a confident state
 * for a car the user is not sitting in.
 */
export function ignitionToggleState(telemetry: TelemetryData | null): ToggleState {
  if (!isLiveOnTrack(telemetry)) return "na";

  return toggleStateFromKnown(isIgnitionOn(telemetry));
}

/**
 * @internal Exported for testing
 *
 * Tri-state shown on the Starter key (issue #561). It reports whether the ENGINE is
 * running, not whether the starter motor is momentarily engaged: the latter is true
 * for well under a second per start, so it would leave the key saying nothing useful
 * almost all the time. Green here means "the engine is alive, you need not crank".
 *
 * Gated on being live in the car for the same reason as the ignition key, and it bites
 * harder here: captured replay frames report a stopped engine with the stalled bit
 * CLEAR, which would otherwise read as "running".
 */
export function starterToggleState(telemetry: TelemetryData | null): ToggleState {
  if (!isLiveOnTrack(telemetry)) return "na";

  return toggleStateFromKnown(isEngineRunning(telemetry));
}

/**
 * Power-symbol artwork for the Ignition key, drawn above the status bar.
 *
 * Sized to the band between a two-line top title and the status bar (roughly y 55..96):
 * the title baseline sits at 47.6 with descenders to about 52, and the bar starts at 100.
 *
 * Lives here rather than baked into the chrome template so generateToggleStateSvg can
 * dim it along with the bar under the binding-missing warning (the DRS pattern), and
 * so it resolves the icon's colors at compose time. Deliberately STATE-NEUTRAL: the
 * status bar and the state-driven border carry on/off/na, so recoloring the artwork
 * too would say the same thing twice.
 */
const IGNITION_ARTWORK = `
    <path d="M62.7,63.8 A17,17,0,1,0,81.3,63.8" fill="none" stroke="{{graphic1Color}}" stroke-width="6" stroke-linecap="round"/>
    <line x1="72" y1="56.1" x2="72" y2="74.6" stroke="{{graphic1Color}}" stroke-width="6" stroke-linecap="round"/>`;

/**
 * Start-button artwork, drawn between the title and the status bar. State-neutral for
 * the same reason as IGNITION_ARTWORK — the previous static icon hardcoded a red badge,
 * which would now contradict a green key. The old icon spelled START inside the ring;
 * the ring is now bare because the title above it already says ENGINE START, and the
 * text would not fit legibly in the band the status bar leaves.
 */
const STARTER_ARTWORK = `
    <circle cx="72" cy="75" r="19" fill="none" stroke="{{graphic1Color}}" stroke-width="4"/>
    <circle cx="72" cy="75" r="11" fill="{{graphic1Color}}"/>`;

/**
 * @internal Exported for testing
 *
 * Check if Push To Pass is active from telemetry.
 */
export function isPushToPassActive(telemetry: TelemetryData | null): boolean {
  if (!telemetry || telemetry.P2P_Status === undefined) return false;

  return telemetry.P2P_Status === true;
}

/**
 * @internal Exported for testing
 *
 * Check if DRS is active from telemetry.
 */
export function isDrsActive(telemetry: TelemetryData | null): boolean {
  if (!telemetry || telemetry.DRS_Status === undefined) return false;

  return telemetry.DRS_Status > 0;
}

/**
 * @internal Exported for testing
 *
 * Telemetry state for dynamic car control icons.
 */
export type CarControlTelemetryState = {
  pitLimiterActive?: boolean;
  /** Whether the current car has a pit limiter (issue #638). false ⇒ greyed N/A state. */
  pitLimiterAvailable?: boolean;
  pitSpeedLimit?: number;
  pushToPassActive?: boolean;
  drsActive?: boolean;
  enterExitTowState?: EnterExitTowState;
  /** Session classification for the context-aware enter-car appearance (issue #632). */
  sessionContext?: SessionContext;
  /** Tri-state ignition indication (issue #561), resolved once so icon and state key agree. */
  ignitionState?: ToggleState;
  /** Tri-state engine-running indication shown on the Starter key (issue #561). */
  starterState?: ToggleState;
};

const CarControlSettings = CommonSettings.extend({
  control: z
    .enum([
      "pit-speed-limiter",
      "push-to-pass",
      "drs",
      "headlight-flash",
      "tear-off-visor",
      "ignition",
      "starter",
      "enter-exit-tow",
      "escape",
      "pause-sim",
      "handbrake",
      "second-clutch",
      "second-up-shift",
      "second-down-shift",
    ])
    .default("pit-speed-limiter"),
  autoHold: z
    .union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(false),
  autoHoldStates: z
    .array(z.enum(["exit-car", "reset-to-pits", "tow"]))
    .default([])
    .transform((arr) => [...new Set(arr)]),
});

type CarControlSettings = z.infer<typeof CarControlSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the car control action.
 */
export function generateCarControlSvg(
  settings: CarControlSettings,
  telemetryState?: CarControlTelemetryState,
  bindingMissing = false,
): string {
  const { control } = settings;

  // Pit-speed-limiter is tri-state (issue #638): on / off / not-available. It mirrors the
  // other tri-state buttons (Fast Repair, Windshield Tear-off) — title at the top, a colored
  // status bar (green ON / red OFF / grey N/A) at the bottom, and the border colour driven by
  // state — but keeps its distinctive speed-number circle as the central graphic. The
  // not-available state is reached on cars without a pit limiter (`hasPitLimiter` false).
  if (control === "pit-speed-limiter") {
    const speed = telemetryState?.pitSpeedLimit ?? DEFAULT_PIT_SPEED;
    // Availability defaults true (undefined ⇒ keep the on/off look until a car snapshot says otherwise).
    const isAvailable = telemetryState?.pitLimiterAvailable ?? true;
    const isActive = telemetryState?.pitLimiterActive ?? false;
    const toggleState = pitLimiterToggleState(isAvailable, isActive);

    const statusBar = toggleState === "na" ? statusBarNA() : toggleState === "on" ? statusBarOn() : statusBarOff();

    const colors = resolveIconColors(pitLimiterTemplate, getGlobalColors(), settings.colorOverrides) as Record<
      string,
      string
    >;
    const resolvedTitle = resolveTitleSettings(
      pitLimiterTemplate,
      getGlobalTitleSettings(),
      settings.titleOverrides,
      "PIT LIMITER",
    );

    const titleContent = resolvedTitle.showTitle
      ? generateTitleText({
          text: resolvedTitle.titleText,
          fontSize: resolvedTitle.fontSize,
          bold: resolvedTitle.bold,
          position: resolvedTitle.position,
          customPosition: resolvedTitle.customPosition,
          fill: colors.textColor ?? WHITE,
        })
      : "";

    // The speed-number circle is the graphic (hidden when Show Graphics is off); the status
    // bar always shows so the on/off/na state stays legible, mirroring DRS / Push-to-Pass.
    // When the title is visible the circle shrinks to leave room for it at the top; with the
    // title hidden (the default) it grows to fill the space above the status bar.
    const speedGraphic = resolvedTitle.showGraphics ? pitLimiterSpeedGraphic(speed, resolvedTitle.showTitle) : "";
    const baseIconContent = `${speedGraphic}${statusBar}`;
    const iconContent = bindingMissing ? applyBindingWarning(baseIconContent) : baseIconContent;

    const border = resolveBorderSettings(
      pitLimiterTemplate,
      getGlobalBorderSettings(),
      settings.borderOverrides,
      borderColorForState(toggleState),
    );
    const borderSvg = generateBorderParts(border);

    const svg = renderIconTemplate(pitLimiterTemplate, {
      iconContent,
      titleContent,
      borderDefs: borderSvg.defs,
      borderContent: borderSvg.rects,
      ...colors,
    });

    return svgToDataUri(svg);
  }

  // Push To Pass and DRS use dedicated templates with their own <desc> defaults
  if (control === "push-to-pass" || control === "drs") {
    const template = control === "push-to-pass" ? pushToPassTemplate : drsTemplate;
    const colors = resolveIconColors(template, getGlobalColors(), settings.colorOverrides) as Record<string, string>;
    const activeValue = control === "push-to-pass" ? telemetryState?.pushToPassActive : telemetryState?.drsActive;
    const baseIconContent = control === "push-to-pass" ? pushToPassIcon(activeValue) : drsIcon(activeValue);
    const toggleState: "on" | "off" | "na" = activeValue === undefined ? "na" : activeValue ? "on" : "off";

    const resolvedTitle = resolveTitleSettings(template, getGlobalTitleSettings(), settings.titleOverrides);

    const titleContent = resolvedTitle.showTitle
      ? generateTitleText({
          text: resolvedTitle.titleText,
          fontSize: resolvedTitle.fontSize,
          bold: resolvedTitle.bold,
          position: resolvedTitle.position,
          customPosition: resolvedTitle.customPosition,
          fill: colors.textColor ?? WHITE,
        })
      : "";

    const border = resolveBorderSettings(
      template,
      getGlobalBorderSettings(),
      settings.borderOverrides,
      borderColorForState(toggleState),
    );
    const borderSvg = generateBorderParts(border);

    // Status bar is always visible, even when Show Graphics is off. When a
    // required binding is missing, dim the content and draw the centered
    // warning over it (#612).
    const iconContent = bindingMissing ? applyBindingWarning(baseIconContent) : baseIconContent;

    const svg = renderIconTemplate(template, {
      iconContent,
      titleContent,
      borderDefs: borderSvg.defs,
      borderContent: borderSvg.rects,
      ...colors,
    });

    return svgToDataUri(svg);
  }

  // Enter/Exit/Tow uses state-specific standalone SVGs. The enter-car state is
  // session-context-aware (issue #632): icon/label/background mirror iRacing's
  // own UI button. In-car states keep their icons but get a red background.
  if (control === "enter-exit-tow") {
    const towState = telemetryState?.enterExitTowState ?? "enter-car";
    const sessionContext = telemetryState?.sessionContext ?? "unknown";
    const isEnterCar = towState === "enter-car";

    const iconSvg = isEnterCar ? SESSION_CONTEXT_ICONS[sessionContext] : ENTER_EXIT_TOW_ICONS[towState];
    const defaultTitle = isEnterCar ? SESSION_CONTEXT_TITLES[sessionContext] : ENTER_EXIT_TOW_TITLES[towState];
    // State-driven background — wins over user color overrides and global presets,
    // same principle as toggle-action border state colors.
    const stateBackground = isEnterCar ? SESSION_CONTEXT_BACKGROUNDS[sessionContext] : IN_CAR_BG_RED;

    const resolvedColors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
    const colors = stateBackground ? { ...resolvedColors, backgroundColor: stateBackground } : resolvedColors;
    const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);
    const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

    const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

    return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
  }

  // Ignition and Starter are tri-state telemetry keys (issue #561). Both go through the
  // shared toggle renderer rather than repeating the resolve/render pipeline a fourth
  // time; the artwork stays state-neutral and the status bar plus the state-driven
  // border carry on/off/na, the same language as the pit limiter and DRS.
  if (control === "ignition" || control === "starter") {
    const isIgnition = control === "ignition";
    const state = (isIgnition ? telemetryState?.ignitionState : telemetryState?.starterState) ?? "na";

    return generateToggleStateSvg({
      template: isIgnition ? ignitionTemplate : starterTemplate,
      artwork: isIgnition ? IGNITION_ARTWORK : STARTER_ARTWORK,
      state,
      colorOverrides: settings.colorOverrides,
      titleOverrides: settings.titleOverrides,
      borderOverrides: settings.borderOverrides,
      bindingMissing,
    });
  }

  // Static modes use standalone SVGs from @iracedeck/icons. Ignition and Starter still
  // appear in the tables below, but the branch above intercepts them first.
  const iconSvg = STATIC_CAR_CONTROL_ICONS[control] || starterIcon;
  const defaultTitle = CAR_CONTROL_STATIC_TITLES[control] ?? CAR_CONTROL_STATIC_TITLES["starter"]!;

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);
  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
}

/**
 * Car Control Action
 * Provides core car operation controls (starter, ignition, pit limiter, enter/exit/tow, pause,
 * headlight flash, push to pass, DRS, tear off visor, escape, and backup inputs: handbrake,
 * second clutch, second up/down shift).
 * Starter, headlight flash, enter/exit/tow, handbrake, and second clutch use long-press
 * (hold while pressed); all others use tap.
 * Escape uses direct keyboard (hardcoded ESC key) with optional auto-hold.
 */
export const CAR_CONTROL_UUID = "com.iracedeck.sd.core.car-control" as const;

export class CarControl extends ConnectionStateAwareAction<CarControlSettings> {
  /** Settings per action context for telemetry-driven updates */
  private activeContexts = new Map<string, CarControlSettings>();

  /** State hash cache to prevent re-rendering every telemetry tick */
  private lastState = new Map<string, string>();

  /** Auto-hold release timers per action context (escape auto-hold mode) */
  private autoHoldTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Caps per-key icon updates at 10 Hz with a trailing-edge coalescer
   * (issue #493). The SDK now ticks at ~70 Hz with SessionTick dedupe;
   * a fast-changing telemetry-driven control (DRS, push-to-pass blinking)
   * would otherwise flood `setKeyImage` calls.
   */
  private readonly imageThrottle = new IconUpdateThrottle();

  override async onWillAppear(ev: IDeckWillAppearEvent<CarControlSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    const globalKey = CAR_CONTROL_GLOBAL_KEYS[settings.control];

    if (globalKey) {
      this.setActiveBinding(globalKey);
    }

    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, (telemetry) => {
      const storedSettings = this.activeContexts.get(ev.action.id);

      if (storedSettings) {
        this.updateDisplayFromTelemetry(ev.action.id, telemetry, storedSettings);
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<CarControlSettings>): Promise<void> {
    // Clear pending throttle + per-context state BEFORE awaiting any keyboard
    // release / super so a queued trailing flush (up to 100 ms) can't fire
    // and call `updateKeyImage` for a context that's mid-teardown.
    this.imageThrottle.clear(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);

    const settings = this.parseSettings(ev.payload.settings);

    if (settings.control === "escape") {
      this.clearAutoHoldTimer(ev.action.id);
      await getKeyboard().releaseKeyCombination(ESC_KEY);
    } else if (settings.control === "enter-exit-tow") {
      this.clearAutoHoldTimer(ev.action.id);
      await this.releaseBinding(ev.action.id);
    } else {
      await this.releaseBinding(ev.action.id);
    }

    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<CarControlSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    const globalKey = CAR_CONTROL_GLOBAL_KEYS[settings.control];

    if (globalKey) {
      this.setActiveBinding(globalKey);
    }

    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(ev.action.id, settings);
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Key up received");
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.control === "escape") {
      if (!settings.autoHold) {
        await getKeyboard().releaseKeyCombination(ESC_KEY);
      }

      return;
    }

    if (settings.control === "enter-exit-tow") {
      // Auto-hold timer owns the release; skip when one is active
      if (!this.autoHoldTimers.has(ev.action.id)) {
        await this.releaseBinding(ev.action.id);
      }

      return;
    }

    await this.releaseBinding(ev.action.id);
  }

  override async onDialDown(ev: IDeckDialDownEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(ev.action.id, settings);
  }

  override async onDialUp(ev: IDeckDialUpEvent<CarControlSettings>): Promise<void> {
    this.logger.info("Dial up received");
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.control === "escape") {
      if (!settings.autoHold) {
        await getKeyboard().releaseKeyCombination(ESC_KEY);
      }

      return;
    }

    if (settings.control === "enter-exit-tow") {
      if (!this.autoHoldTimers.has(ev.action.id)) {
        await this.releaseBinding(ev.action.id);
      }

      return;
    }

    await this.releaseBinding(ev.action.id);
  }

  private parseSettings(settings: unknown): CarControlSettings {
    const parsed = CarControlSettings.safeParse(settings);

    return parsed.success ? parsed.data : CarControlSettings.parse({});
  }

  private async executeControl(actionId: string, settings: CarControlSettings): Promise<void> {
    if (settings.control === "escape") {
      await this.executeEscape(actionId, settings);

      return;
    }

    if (settings.control === "enter-exit-tow") {
      await this.executeEnterExitTow(actionId, settings);

      return;
    }

    const settingKey = CAR_CONTROL_GLOBAL_KEYS[settings.control];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for control: ${settings.control}`);

      return;
    }

    if (HOLD_CONTROLS.has(settings.control)) {
      await this.holdBinding(actionId, settingKey);
    } else {
      await this.tapBinding(settingKey);
    }
  }

  /**
   * Resolves whether auto-hold should apply for the current Enter/Exit/Tow telemetry state.
   * Enter-car is instant — never auto-holds regardless of settings.
   */
  private getEnterExitTowAutoHold(settings: CarControlSettings): boolean {
    const telemetry = this.sdkController.getCurrentTelemetry();
    const sessionInfo = this.sdkController.getSessionInfo();
    const state = getEnterExitTowState(telemetry, sessionInfo);

    if (state === "enter-car") return false;

    return settings.autoHoldStates?.includes(state) ?? false;
  }

  private async executeEnterExitTow(actionId: string, settings: CarControlSettings): Promise<void> {
    const settingKey = CAR_CONTROL_GLOBAL_KEYS["enter-exit-tow"];

    if (!settingKey) {
      this.logger.warn("No global key mapping for control: enter-exit-tow");

      return;
    }

    const autoHold = this.getEnterExitTowAutoHold(settings);

    if (autoHold) {
      // Second press while timer running: cancel and release immediately
      if (this.autoHoldTimers.has(actionId)) {
        this.logger.info("Enter/Exit/Tow auto-hold cancelled");
        this.clearAutoHoldTimer(actionId);
        await this.releaseBinding(actionId);

        return;
      }

      // First press: start hold, auto-release after timeout
      this.logger.info("Enter/Exit/Tow auto-hold started");
      await this.holdBinding(actionId, settingKey);
      this.autoHoldTimers.set(
        actionId,
        setTimeout(() => {
          this.logger.info("Enter/Exit/Tow auto-hold released");
          void this.releaseBinding(actionId)
            .catch((err) => this.logger.error(`Enter/Exit/Tow auto-hold release failed: ${err}`))
            .finally(() => this.autoHoldTimers.delete(actionId));
        }, AUTO_HOLD_DURATION),
      );
    } else {
      // Manual hold: press on keyDown, release on keyUp
      await this.holdBinding(actionId, settingKey);
    }
  }

  private async executeEscape(actionId: string, settings: CarControlSettings): Promise<void> {
    const keyboard = getKeyboard();

    if (settings.autoHold) {
      // Second press while timer running: cancel and release immediately
      if (this.autoHoldTimers.has(actionId)) {
        this.logger.info("Escape auto-hold cancelled");
        this.clearAutoHoldTimer(actionId);
        await keyboard.releaseKeyCombination(ESC_KEY);

        return;
      }

      // First press: hold ESC, auto-release after timeout
      this.logger.info("Escape auto-hold started");
      await keyboard.pressKeyCombination(ESC_KEY);
      this.autoHoldTimers.set(
        actionId,
        setTimeout(() => {
          this.logger.info("Escape auto-hold released");
          void keyboard
            .releaseKeyCombination(ESC_KEY)
            .catch((err) => this.logger.error(`Escape auto-hold release failed: ${err}`))
            .finally(() => this.autoHoldTimers.delete(actionId));
        }, AUTO_HOLD_DURATION),
      );
    } else {
      // Manual hold: press on keyDown, release on keyUp
      this.logger.info("Escape pressed");
      await keyboard.pressKeyCombination(ESC_KEY);
    }
  }

  private clearAutoHoldTimer(actionId: string): void {
    const timer = this.autoHoldTimers.get(actionId);

    if (timer) {
      clearTimeout(timer);
      this.autoHoldTimers.delete(actionId);
    }
  }

  private getTelemetryState(telemetry: TelemetryData | null, control: CarControlType): CarControlTelemetryState {
    const state: CarControlTelemetryState = {};

    if (control === "pit-speed-limiter") {
      state.pitLimiterActive = isPitLimiterActive(telemetry);
      state.pitLimiterAvailable = isPitLimiterAvailable(telemetry);
      state.pitSpeedLimit = getPitSpeedLimit();
    } else if (control === "push-to-pass") {
      if (telemetry) state.pushToPassActive = isPushToPassActive(telemetry);
    } else if (control === "drs") {
      if (telemetry) state.drsActive = isDrsActive(telemetry);
    } else if (control === "enter-exit-tow") {
      const sessionInfo = this.sdkController.getSessionInfo();
      state.enterExitTowState = getEnterExitTowState(telemetry, sessionInfo);
      state.sessionContext = getSessionContext(telemetry, sessionInfo);
    } else if (control === "ignition") {
      state.ignitionState = ignitionToggleState(telemetry);
    } else if (control === "starter") {
      state.starterState = starterToggleState(telemetry);
    }

    return state;
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<CarControlSettings> | IDeckDidReceiveSettingsEvent<CarControlSettings>,
    settings: CarControlSettings,
  ): Promise<void> {
    const telemetry = this.sdkController.getCurrentTelemetry();
    const telemetryState = this.getTelemetryState(telemetry, settings.control);

    const svgDataUri = generateCarControlSvg(
      settings,
      telemetryState,
      this.isBindingMissing(CAR_CONTROL_GLOBAL_KEYS[settings.control]),
    );
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => {
      const currentTelemetry = this.sdkController.getCurrentTelemetry();
      const currentState = this.getTelemetryState(currentTelemetry, settings.control);

      return generateCarControlSvg(
        settings,
        currentState,
        this.isBindingMissing(CAR_CONTROL_GLOBAL_KEYS[settings.control]),
      );
    });

    // Initialize state cache
    const stateKey = this.buildStateKey(settings, telemetryState);
    this.lastState.set(ev.action.id, stateKey);
  }

  private buildStateKey(settings: CarControlSettings, telemetryState: CarControlTelemetryState): string {
    const bo = settings.borderOverrides;
    const borderKey = `${bo?.enabled ?? ""}|${bo?.borderWidth ?? ""}|${bo?.borderColor ?? ""}|${bo?.glowEnabled ?? ""}|${bo?.glowWidth ?? ""}`;
    // Include the binding-missing flag so a telemetry tick re-renders the key
    // when the user sets/clears the control's binding (#612).
    const warn = this.isBindingMissing(CAR_CONTROL_GLOBAL_KEYS[settings.control]) ? "warn" : "";

    if (settings.control === "pit-speed-limiter") {
      // Key on the resolved tri-state (issue #638) so the key matches the rendered icon —
      // switching between a limiter car and a non-limiter car re-renders (N/A ⇄ on/off),
      // without churning when the (irrelevant) on/off flag toggles on a no-limiter car.
      const toggleState = pitLimiterToggleState(
        telemetryState.pitLimiterAvailable ?? true,
        telemetryState.pitLimiterActive ?? false,
      );

      return `pit-speed-limiter|${toggleState}|${telemetryState.pitSpeedLimit ?? DEFAULT_PIT_SPEED}|${borderKey}|${warn}`;
    }

    if (settings.control === "push-to-pass") {
      return `push-to-pass|${telemetryState.pushToPassActive ?? "na"}|${borderKey}|${warn}`;
    }

    if (settings.control === "drs") {
      return `drs|${telemetryState.drsActive ?? "na"}|${borderKey}|${warn}`;
    }

    if (settings.control === "enter-exit-tow") {
      return `enter-exit-tow|${telemetryState.enterExitTowState ?? "enter-car"}|${telemetryState.sessionContext ?? "unknown"}|${borderKey}|${warn}`;
    }

    if (settings.control === "ignition") {
      return `ignition|${telemetryState.ignitionState ?? "na"}|${borderKey}|${warn}`;
    }

    if (settings.control === "starter") {
      return `starter|${telemetryState.starterState ?? "na"}|${borderKey}|${warn}`;
    }

    return settings.control;
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: CarControlSettings,
  ): Promise<void> {
    if (!TELEMETRY_AWARE_CONTROLS.has(settings.control)) return;

    const telemetryState = this.getTelemetryState(telemetry, settings.control);
    const stateKey = this.buildStateKey(settings, telemetryState);
    const lastStateKey = this.lastState.get(contextId);

    if (lastStateKey === stateKey) return;

    this.lastState.set(contextId, stateKey);

    // Route through the 10 Hz throttle (issue #493). The render closure
    // re-resolves from current telemetry at flush time so a trailing-edge
    // fire reflects the latest state, not the state we had when the
    // throttle scheduled it.
    this.imageThrottle.schedule(contextId, async () => {
      const storedSettings = this.activeContexts.get(contextId);

      if (!storedSettings || !TELEMETRY_AWARE_CONTROLS.has(storedSettings.control)) return;

      const currentTelemetry = this.sdkController.getCurrentTelemetry();
      const currentState = this.getTelemetryState(currentTelemetry, storedSettings.control);
      const svgDataUri = generateCarControlSvg(
        storedSettings,
        currentState,
        this.isBindingMissing(CAR_CONTROL_GLOBAL_KEYS[storedSettings.control]),
      );
      await this.updateKeyImage(contextId, svgDataUri);
      this.setRegenerateCallback(contextId, () => {
        const t = this.sdkController.getCurrentTelemetry();
        const s = this.getTelemetryState(t, storedSettings.control);

        return generateCarControlSvg(
          storedSettings,
          s,
          this.isBindingMissing(CAR_CONTROL_GLOBAL_KEYS[storedSettings.control]),
        );
      });
    });
  }
}
