import { getScenarioEngine } from "@iracedeck/audio-scenarios";
import {
  FLAG_SCENARIO_IDS,
  FUEL_SCENARIO_IDS,
  getSpotterVisualState,
  PIT_LIMITER_SCENARIO_IDS,
  playSpotterTest,
  setDriverNameResolver,
  setSpotterEnabled,
  type SpotterVisualState,
  subscribeSpotterVisualState,
  TOGGLE_SCENARIO_IDS,
} from "@iracedeck/audio-scenarios/pit-engineer";
import { AudioBus, getAudio } from "@iracedeck/audio-service";
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
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
  updateGlobalSettings,
} from "@iracedeck/deck-core";
import { z } from "zod";

import pitEngineerTemplate from "../../../icons/pit-engineer.svg";
import { borderColorForState, statusBarOff, statusBarOn } from "../../icons/status-bar.js";

const WHITE = "#ffffff";

/** @internal Exported for testing */
export const PIT_ENGINEER_UUID = "com.iracedeck.sd.core.pit-engineer";

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

/**
 * @internal Exported for testing.
 *
 * Returns the audio-assets path for the chosen driver name, or null if none.
 */
export function driverNamePath(name: string | undefined): string | null {
  if (!name || name === "none") return null;

  return `pit-engineer/names/IRD-name-${name}.mp3`;
}

// ─── Master gate ──────────────────────────────────────────────────────────────

/**
 * Master on/off for the engineer. Stored as a plugin-global setting so the
 * value persists across plugin restarts and is shared between action
 * instances on different pages.
 */
function isEngineerEnabled(): boolean {
  return (getGlobalSettings() as Record<string, unknown>).pitEngineerEnabled !== false;
}

// ─── Scenario gating ──────────────────────────────────────────────────────────

/**
 * @internal Exported for testing.
 *
 * Sync every pit-engineer scenario's enabled flag to the Property Inspector
 * toggles, gated by the master switch. Called from every event that can
 * change either layer of state (`onWillAppear`, `onDidReceiveSettings`,
 * `onKeyDown`). `master` is passed explicitly because `onKeyDown` needs the
 * new value before the global-settings round-trip completes.
 */
export function syncScenarioState(settings: PitEngineerSettings, master: boolean): void {
  const engine = getScenarioEngine();
  const gate = (id: string, on: boolean): void => {
    engine.setEnabled(id, master && on);
  };

  // Welcome has no PI toggle — it's always on while the engineer is enabled.
  gate("pit-engineer.welcome", true);
  gate("pit-engineer.pit-approach", settings.pitApproachEnabled);
  gate("pit-engineer.service-reminder", settings.pitServiceReminderEnabled);
  gate("pit-engineer.pit-exit", settings.pitExitEnabled);
  gate("pit-engineer.stall-departure", settings.pitDepartureEnabled);
  gate("pit-engineer.incident-alerts", settings.incidentAlert);
  gate("pit-engineer.overtake", settings.overtakeAndTipsEnabled);
  gate("pit-engineer.racing-tips", settings.overtakeAndTipsEnabled);

  for (const id of FLAG_SCENARIO_IDS) gate(id, settings.flagAlertsEnabled);

  for (const id of FUEL_SCENARIO_IDS) gate(id, settings.fuelWarningsEnabled);

  for (const id of TOGGLE_SCENARIO_IDS) gate(id, settings.toggleAudioEnabled);

  for (const id of PIT_LIMITER_SCENARIO_IDS) gate(id, settings.pitLimiterWarning);

  setSpotterEnabled(master && settings.spotterEnabled);
}

/**
 * @internal Exported for testing.
 *
 * Apply the volume sliders to the audio busses. The engineer slider drives
 * the Voice + Background bus pair; the spotter slider drives the Alerts
 * bus. Per-channel attenuation (Ambient 0.8×, SFX 0.7×) is applied inside
 * audio-service's bus mix ratios.
 */
export function applyVolumes(settings: PitEngineerSettings): void {
  const engineerVol = settings.volume / 100;
  const spotterVol = settings.spotterVolume / 100;
  const audio = getAudio();

  audio.setBusVolume(AudioBus.Voice, engineerVol);
  audio.setBusVolume(AudioBus.Background, engineerVol);
  audio.setBusVolume(AudioBus.Alerts, spotterVol);
}

// ─── Icon generation ──────────────────────────────────────────────────────────

/** Artwork bounds of the mechanic SVG (source viewBox 0 0 71.457 71.457). */
const MECHANIC_BOUNDS = { x: 0, y: 0, width: 71.457, height: 71.457 };

/** Raw mechanic path SVG (unscaled, in source coordinate space). */
function mechanicPathContent(graphicColor: string): string {
  return `<path fill="${graphicColor}" d="M19.538,23.485c0.02-0.685,0.082-2.768,1.558-3.325c1.46-0.551,2.964,0.948,3.251,1.254c0.377,0.403,0.356,1.036-0.047,1.414c-0.404,0.375-1.036,0.356-1.414-0.047c-0.347-0.367-0.897-0.734-1.106-0.741c0.014,0.028-0.208,0.349-0.243,1.504c-0.11,3.731,2.743,4.773,2.864,4.815c0.31,0.108,0.553,0.364,0.641,0.68l0.046,0.168c0.017,0.06,0.027,0.121,0.033,0.183c0.825,9.836,8.605,13.019,12.244,13.019s11.419-3.182,12.244-13.019c0.005-0.061,0.016-0.121,0.032-0.18l0.046-0.168c0.088-0.322,0.332-0.58,0.649-0.685c0.114-0.04,2.967-1.082,2.857-4.813c-0.038-1.272-0.303-1.533-0.306-1.536c-0.124,0.023-0.689,0.399-1.044,0.774c-0.379,0.4-1.011,0.419-1.413,0.042c-0.401-0.378-0.423-1.008-0.046-1.411c0.287-0.306,1.79-1.805,3.251-1.254c1.476,0.558,1.538,2.641,1.558,3.325c0.109,3.698-2.075,5.741-3.632,6.521c-1.051,9.93-8.88,14.403-14.195,14.403S24.221,39.936,23.17,30.005C21.613,29.226,19.429,27.184,19.538,23.485z M22.099,16.792C22.099,3.017,33.101,0,37.34,0c4.253,0,15.291,3.017,15.291,16.792c0,0.438-0.286,0.826-0.705,0.956l-1.558,0.481l-1.389,1.538c-0.19,0.211-0.46,0.33-0.742,0.33c-0.032,0-0.063-0.001-0.095-0.004c-0.309-0.03-0.585-0.2-0.75-0.461c-0.061-0.087-2.069-2.829-10.027-2.835c-8.044,0.006-10.008,2.809-10.027,2.837c-0.171,0.256-0.458,0.429-0.765,0.452c-0.306,0.028-0.614-0.088-0.821-0.317l-1.389-1.538l-1.558-0.481C22.384,17.619,22.099,17.231,22.099,16.792z M24.111,16.059l1.104,0.341c0.172,0.053,0.326,0.152,0.447,0.285l0.845,0.936c1.322-1.13,4.38-2.819,10.858-2.824c6.478,0.004,9.537,1.694,10.859,2.824l0.844-0.935c0.121-0.134,0.275-0.232,0.447-0.286l1.104-0.341C50.18,2.388,37.471,2,37.34,2C37.21,2,24.548,2.388,24.111,16.059z M26.405,13.627c-0.187-0.52,0.083-1.093,0.602-1.28c1.413-0.509,2.86-0.886,4.321-1.179c-0.227-0.8-0.455-1.6-0.665-2.403c-0.068-0.258-0.029-0.533,0.107-0.762c0.136-0.23,0.358-0.396,0.617-0.46c3.966-0.995,7.988-0.995,11.954,0c0.259,0.065,0.481,0.23,0.617,0.46c0.136,0.229,0.175,0.504,0.107,0.762c-0.21,0.802-0.438,1.602-0.665,2.403c1.461,0.293,2.908,0.67,4.321,1.179c0.52,0.187,0.789,0.76,0.602,1.28c-0.147,0.408-0.531,0.661-0.941,0.662c-0.112,0-0.227-0.02-0.339-0.06c-6.242-2.248-13.117-2.248-19.359,0C27.165,14.415,26.593,14.146,26.405,13.627z M33.31,10.841c2.692-0.359,5.417-0.359,8.109,0c0.151-0.528,0.303-1.055,0.446-1.584c-2.992-0.613-6.011-0.613-9.002,0C33.007,9.786,33.159,10.313,33.31,10.841z M70.32,32.224v5.108c0,0.536-0.286,1.031-0.75,1.299l-3.674,2.121v12.558c0,0.028-0.007,0.053-0.008,0.08c1.211,0.175,2.134,0.577,2.783,1.228c1.194,1.201,1.185,2.886,1.177,4.373l-0.001,6.939c0,3.005-2.445,5.45-5.45,5.45c-3.005,0-5.45-2.445-5.45-5.45l-0.001-6.939c-0.008-1.487-0.017-3.172,1.177-4.373c0.648-0.652,1.572-1.053,2.783-1.228c-0.001-0.027-0.008-0.053-0.008-0.08v-1.539c-1.027-3.481-3.123-6.704-5.941-9.243l-2.758,7.851v21.078H37.365H20.534V50.379l-2.859-8.137c-3.937,3.24-6.539,7.58-7.099,12.155c0.093,0.076,0.205,0.137,0.289,0.221c1.194,1.201,1.185,2.886,1.177,4.373l-0.001,6.94c0,3.005-2.445,5.45-5.45,5.45c-3.005,0-5.45-2.445-5.45-5.45l-0.001-6.939c-0.008-1.487-0.017-3.172,1.177-4.373c0.462-0.465,1.066-0.8,1.81-1.021v-5.294c0-0.552,0.448-1,1-1H5.84v-9.639c0-0.414,0.336-0.75,0.75-0.75s0.75,0.336,0.75,0.75v9.639h0.714c0.552,0,1,0.448,1,1v3.43c1.168-4.387,3.992-8.435,7.921-11.485l-0.296-0.842c-0.183-0.521,0.091-1.092,0.612-1.275c0.522-0.184,1.092,0.091,1.275,0.612l0.101,0.289c1.356-0.885,2.817-1.659,4.369-2.296c0.255-0.105,0.543-0.1,0.794,0.015c0.251,0.114,0.444,0.328,0.533,0.589c1.758,5.181,6.816,8.529,12.886,8.529c6.071,0,11.129-3.348,12.887-8.529c0.088-0.261,0.281-0.475,0.533-0.589c0.251-0.115,0.539-0.12,0.794-0.015c1.612,0.662,3.126,1.51,4.531,2.494l0.171-0.486c0.183-0.521,0.753-0.795,1.275-0.612c0.521,0.183,0.795,0.754,0.612,1.275l-0.385,1.096c2.118,1.782,3.894,3.914,5.229,6.253v-6.004l-3.674-2.121c-0.464-0.268-0.75-0.763-0.75-1.299v-5.108c0-0.829,0.671-1.5,1.5-1.5s1.5,0.671,1.5,1.5v4.242l2.924,1.688l2.924-1.688v-4.242c0-0.829,0.671-1.5,1.5-1.5S70.32,31.395,70.32,32.224z M6.126,52.618h0.928v-3.314H6.126V52.618z M9.735,67.334H7.698c-0.552,0-1-0.448-1-1s0.448-1,1-1h2.341l0-1.688H7.698c-0.552,0-1-0.448-1-1s0.448-1,1-1h2.342l0-1.822H7.698c-0.552,0-1-0.448-1-1s0.448-1,1-1h2.325c-0.041-0.741-0.171-1.387-0.577-1.795c-0.491-0.494-1.452-0.745-2.856-0.745s-2.365,0.25-2.856,0.745c-0.608,0.611-0.602,1.748-0.595,2.952l0.001,6.95c0,1.902,1.548,3.45,3.45,3.45C7.992,69.381,9.196,68.538,9.735,67.334z M23.625,52.599c0-0.352-0.286-0.638-0.638-0.638c-0.352,0-0.638,0.286-0.638,0.638c0,0.352,0.286,0.638,0.638,0.638C23.339,53.237,23.625,52.951,23.625,52.599z M46.393,62.333c0-0.552-0.448-1-1-1H29.337c-0.552,0-1,0.448-1,1s0.448,1,1,1h16.056C45.945,63.333,46.393,62.885,46.393,62.333z M37.365,53.237c0.352,0,0.638-0.286,0.638-0.638c0-0.352-0.286-0.638-0.638-0.638c-0.352,0-0.638,0.286-0.638,0.638C36.727,52.951,37.013,53.237,37.365,53.237z M52.381,52.599c0-0.352-0.286-0.638-0.638-0.638c-0.352,0-0.638,0.286-0.638,0.638c0,0.352,0.286,0.638,0.638,0.638C52.095,53.237,52.381,52.951,52.381,52.599z M55.304,41.191c-1.139-0.841-2.363-1.584-3.664-2.193c-2.32,5.424-7.85,8.871-14.392,8.871c-6.542,0-12.073-3.448-14.393-8.874c-1.242,0.571-2.412,1.241-3.505,1.986l3.223,9.175h14.79h14.79L55.304,41.191z M67.252,56.029c-0.491-0.494-1.453-0.745-2.856-0.745c-1.404,0-2.365,0.25-2.856,0.745c-0.406,0.409-0.536,1.054-0.577,1.795h2.325c0.552,0,1,0.448,1,1s-0.448,1-1,1h-2.343l0,1.822h2.343c0.552,0,1,0.448,1,1s-0.448,1-1,1h-2.342l0,1.688h2.342c0.552,0,1,0.448,1,1s-0.448,1-1,1H61.25c0.539,1.204,1.743,2.047,3.145,2.047c1.902,0,3.45-1.548,3.45-3.45l0.001-6.95C67.853,57.777,67.86,56.641,67.252,56.029z M37.979,24.528v4.953h-2.228c-0.552,0-1,0.448-1,1s0.448,1,1,1h3.228c0.552,0,1-0.448,1-1v-5.953c0-0.552-0.448-1-1-1S37.979,23.976,37.979,24.528z"/>`;
}

/**
 * @internal Exported for testing.
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
  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);
  const title = resolveTitleSettings(
    pitEngineerTemplate,
    getGlobalTitleSettings(),
    settings.titleOverrides,
    "PIT\nENGINEER",
  );

  // Status bar occupies y=100..144, so constrain graphic area to the upper region.
  const STATUS_BAR_TOP = 100;
  const PADDING = 8;
  const fullGraphicArea = computeGraphicArea(title);
  const graphicArea = {
    ...fullGraphicArea,
    height: Math.min(fullGraphicArea.height, STATUS_BAR_TOP - PADDING - fullGraphicArea.y),
  };

  const rawPath = mechanicPathContent(graphicColor);
  const scaledGraphic = title.showGraphics
    ? applyGraphicTransform(rawPath, MECHANIC_BOUNDS, graphicArea, graphic.scale)
    : "";

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

  // spotterState is accepted for API compatibility with the regenerate callback
  // and future visual overlays; the current template renders identically
  // regardless of proximity state (spotter is audio-only).
  void spotterState;

  const svg = renderIconTemplate(pitEngineerTemplate, {
    iconContent,
    borderDefs: borderSvg.defs,
    borderContent: borderSvg.rects,
    ...colors,
  });

  return svgToDataUri(svg);
}

// ─── Action ────────────────────────────────────────────────────────────────────

export class PitEngineer extends ConnectionStateAwareAction<PitEngineerSettings> {
  /** Per-context settings cache for visible instances. */
  private readonly settingsCache = new Map<string, PitEngineerSettings>();

  /** Set of currently visible context IDs. */
  private readonly visibleContexts = new Set<string>();

  /** Per-context unsubscribe callbacks for spotter + global-settings listeners. */
  private readonly listenerUnsubs = new Map<string, Array<() => void>>();

  /** Last-seen settings, used by the driver-name resolver injected into scenarios. */
  private latestSettings: PitEngineerSettings | null = null;

  /** Last engineer test-volume timestamp — prevents replay on unrelated settings updates. */
  private lastTestTimestamp = 0;

  /** Last spotter test-volume timestamp. */
  private lastSpotterTestTimestamp = 0;

  override async onWillAppear(ev: IDeckWillAppearEvent<PitEngineerSettings>): Promise<void> {
    await super.onWillAppear(ev);

    const raw = ev.payload.settings as Record<string, unknown>;
    const settings = Settings.parse(raw);
    const contextId = ev.action.id;

    this.settingsCache.set(contextId, settings);
    this.visibleContexts.add(contextId);
    this.latestSettings = settings;

    // Seed test-button timestamps so the first onDidReceiveSettings doesn't
    // replay previous plays when the PI rehydrates the hidden textfields.
    this.lastTestTimestamp = (raw._testVolume as number) ?? 0;
    this.lastSpotterTestTimestamp = (raw._testSpotterVolume as number) ?? 0;

    setDriverNameResolver(() => driverNamePath(this.latestSettings?.driverName));

    this.listenerUnsubs.set(contextId, [
      subscribeSpotterVisualState(() => {
        void this.rerender(contextId);
      }),
      onGlobalSettingsChange(() => {
        void this.rerender(contextId);
      }),
    ]);

    applyVolumes(settings);
    syncScenarioState(settings, isEngineerEnabled());

    await this.setKeyImage(ev, generatePitEngineerSvg(settings, getSpotterVisualState(), isEngineerEnabled()));

    this.setRegenerateCallback(contextId, () => {
      const s = this.settingsCache.get(contextId);

      if (!s) return "";

      return generatePitEngineerSvg(s, getSpotterVisualState(), isEngineerEnabled());
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<PitEngineerSettings>): Promise<void> {
    const contextId = ev.action.id;

    for (const unsub of this.listenerUnsubs.get(contextId) ?? []) unsub();

    this.listenerUnsubs.delete(contextId);
    this.settingsCache.delete(contextId);
    this.visibleContexts.delete(contextId);

    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<PitEngineerSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);

    const raw = ev.payload.settings as Record<string, unknown>;
    const settings = Settings.parse(raw);
    const contextId = ev.action.id;

    this.settingsCache.set(contextId, settings);
    this.latestSettings = settings;

    applyVolumes(settings);
    syncScenarioState(settings, isEngineerEnabled());

    const testTimestamp = raw._testVolume as number | undefined;

    if (testTimestamp && testTimestamp !== this.lastTestTimestamp) {
      this.logger.info("Playing welcome message (engineer test)");
      getScenarioEngine().fire("pit-engineer.welcome");
    }

    this.lastTestTimestamp = testTimestamp ?? 0;

    const spotterTestTimestamp = raw._testSpotterVolume as number | undefined;

    if (spotterTestTimestamp && spotterTestTimestamp !== this.lastSpotterTestTimestamp) {
      this.logger.info("Playing spotter test: left → right → both");
      playSpotterTest();
    }

    this.lastSpotterTestTimestamp = spotterTestTimestamp ?? 0;

    await this.setKeyImage(ev, generatePitEngineerSvg(settings, getSpotterVisualState(), isEngineerEnabled()));
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<PitEngineerSettings>): Promise<void> {
    const nextMaster = !isEngineerEnabled();
    const settings = Settings.parse(ev.payload.settings);

    this.logger.info(`Pit Engineer ${nextMaster ? "enabled" : "disabled"}`);

    // Gate scenarios synchronously with the new master value. The global
    // settings round-trip is async; relying on it would let audio play in
    // the stale-master window between the button press and the adapter echo.
    syncScenarioState(settings, nextMaster);
    updateGlobalSettings({ pitEngineerEnabled: nextMaster });

    for (const contextId of this.visibleContexts) {
      const s = this.settingsCache.get(contextId);

      if (!s) continue;

      await this.updateKeyImage(contextId, generatePitEngineerSvg(s, getSpotterVisualState(), nextMaster));
    }
  }

  private async rerender(contextId: string): Promise<void> {
    const settings = this.settingsCache.get(contextId);

    if (!settings) return;

    await this.updateKeyImage(
      contextId,
      generatePitEngineerSvg(settings, getSpotterVisualState(), isEngineerEnabled()),
    );
  }
}
