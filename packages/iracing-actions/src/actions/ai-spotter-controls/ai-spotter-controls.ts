import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  getDualPressThresholdMs,
  getGlobalBorderSettings,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckKeyUpEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  type PressShape,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import announceLeaderIconSvg from "@iracedeck/icons/ai-spotter-controls/announce-leader.svg";
import damageReportIconSvg from "@iracedeck/icons/ai-spotter-controls/damage-report.svg";
import louderIconSvg from "@iracedeck/icons/ai-spotter-controls/louder.svg";
import quieterIconSvg from "@iracedeck/icons/ai-spotter-controls/quieter.svg";
import silenceIconSvg from "@iracedeck/icons/ai-spotter-controls/silence.svg";
import toggleReportLapsIconSvg from "@iracedeck/icons/ai-spotter-controls/toggle-report-laps.svg";
import weatherReportIconSvg from "@iracedeck/icons/ai-spotter-controls/weather-report.svg";
import { getGlobalColors } from "@iracedeck/settings";
import z from "zod";

import { tickIRacingVolumeStep } from "../../audio/volume-tick.js";
import {
  ADJUST_REPEAT_INTERVAL_MS,
  ADJUST_REPEAT_SAFETY_MS,
  adjustStyleSettingsFields,
  persistFreshKeyStyleSeed,
} from "../../shared/adjust-styles.js";
import { RepeatController } from "../../shared/repeat-controller.js";
import { SPOTTER_CONTROLS, SPOTTER_GLOBAL_KEYS, type SpotterControl } from "../../shared/spotter-bindings.js";
import {
  renderVolumeKeyIconOrNull,
  type VolumeKeyDescription,
  volumeKeyRepeats,
} from "../../shared/volume-key-styles.js";

// The spotter id↔global-key map lives in `shared/spotter-bindings.ts` (also
// consumed by the Audio Controls dial's Spotter mode, #809); re-exported here
// so tests and callers keep importing it from the action.
export { SPOTTER_GLOBAL_KEYS };

/**
 * @internal Exported for testing
 *
 * Flat record mapping control keys to imported SVGs.
 */
export const SPOTTER_ICONS: Record<SpotterControl, string> = {
  "damage-report": damageReportIconSvg,
  "weather-report": weatherReportIconSvg,
  "toggle-report-laps": toggleReportLapsIconSvg,
  "announce-leader": announceLeaderIconSvg,
  louder: louderIconSvg,
  quieter: quieterIconSvg,
  silence: silenceIconSvg,
};

/**
 * @internal Exported for testing
 *
 * Title text for each spotter control (format: "subLabel\nmainLabel")
 */
export const SPOTTER_TITLES: Record<SpotterControl, string> = {
  "damage-report": "REPORT\nDAMAGE",
  "weather-report": "REPORT\nWEATHER",
  "toggle-report-laps": "REPORT\nLAPS",
  "announce-leader": "SPOTTER\nLEADER",
  louder: "VOL UP\nSPOTTER",
  quieter: "VOL DOWN\nSPOTTER",
  silence: "SKIP CALL\nSPOTTER",
};

/**
 * @internal Exported for testing
 */
export const AiSpotterControlsSettings = CommonSettings.extend({
  // .catch (#1453): an unknown stored control still lands on Damage Report,
  // but no longer fails the whole parse and resets the key's other fields
  // (its key style among them) along with it.
  control: z.enum(SPOTTER_CONTROLS).default("damage-report").catch("damage-report"),
  // Paired +/- key styles on Spotter Louder / Quieter (#1453): `keyStyle` and
  // `pairPosition`, both with `.catch`. The other controls keep the stored
  // value and ignore it.
  ...adjustStyleSettingsFields,
});

export type AiSpotterControlsSettings = z.infer<typeof AiSpotterControlsSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the AI spotter controls action.
 */
export function generateAiSpotterControlsSvg(settings: AiSpotterControlsSettings, bindingMissing = false): string {
  const { control } = settings;
  const iconSvg = SPOTTER_ICONS[control] || SPOTTER_ICONS["damage-report"];
  const defaultTitle = SPOTTER_TITLES[control] || SPOTTER_TITLES["damage-report"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
}

/** The spotter controls that form a volume pair (#1453). */
type SpotterVolumeControl = Extract<SpotterControl, "louder" | "quieter">;

function isSpotterVolumeControl(control: SpotterControl): control is SpotterVolumeControl {
  return control === "louder" || control === "quieter";
}

/**
 * @internal Exported for testing
 *
 * The shape of a spotter key press, for the press sounds (#269): Spotter
 * Louder / Quieter make none, since their #1455 tick is the press sound (a
 * repeating style's hold changes nothing to bleep for); every other control
 * taps its binding once on key-down.
 */
export function spotterPressShape(control: SpotterControl): PressShape {
  return isSpotterVolumeControl(control) ? { kind: "none" } : { kind: "tap" };
}

/**
 * @internal Exported for testing
 *
 * The volume key a spotter control is, for its paired +/− style (#1453), or
 * null for a control that is not a volume key. iRacing reports no spotter
 * volume, so the key has no level: a value style draws its no-value form.
 */
export function describeSpotterVolumeKey(control: SpotterControl): VolumeKeyDescription | null {
  if (!isSpotterVolumeControl(control)) return null;

  return { label: "SPOTTER", direction: control === "louder" ? "increase" : "decrease" };
}

/**
 * @internal Exported for testing
 *
 * The key icon: Spotter Louder / Quieter in a paired style draws through the
 * shared volume module (#1453); every other control, and a volume key on
 * Legacy, draws {@link generateAiSpotterControlsSvg} as before.
 */
export function renderAiSpotterControlsIcon(settings: AiSpotterControlsSettings, bindingMissing = false): string {
  const description = describeSpotterVolumeKey(settings.control);

  if (description) {
    const styled = renderVolumeKeyIconOrNull({
      description,
      keyStyle: settings.keyStyle,
      pairPosition: settings.pairPosition,
      colorSourceSvg: SPOTTER_ICONS[settings.control],
      colorOverrides: settings.colorOverrides,
      titleOverrides: settings.titleOverrides,
      borderOverrides: settings.borderOverrides,
      bindingMissing,
    });

    if (styled) return styled;
  }

  return generateAiSpotterControlsSvg(settings, bindingMissing);
}

/**
 * AI Spotter Controls Action
 * Provides controls for the iRacing AI spotter: damage/weather reports, lap reporting,
 * leader announcements, volume controls, and skipping the spotter call currently playing.
 */
export const AI_SPOTTER_CONTROLS_UUID = "com.iracedeck.sd.core.ai-spotter-controls" as const;

export class AiSpotterControls extends ConnectionStateAwareAction<AiSpotterControlsSettings> {
  /** Hold-to-repeat for Spotter Louder / Quieter in a paired style (#1453); Legacy keys step once per press. */
  private readonly repeat = new RepeatController(this.logger);

  override async onWillAppear(ev: IDeckWillAppearEvent<AiSpotterControlsSettings>): Promise<void> {
    // BEFORE super (#1453): the base stamps a missing `addedWithVersion` with
    // its own setSettings({...payload, addedWithVersion}). Seeding first, and
    // handing the base the seeded payload, makes that stamp write land last
    // AND carry the seeded style.
    await persistFreshKeyStyleSeed(ev, this.logger);
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.setActiveBinding(SPOTTER_GLOBAL_KEYS[settings.control]);
    await this.updateDisplay(ev, settings);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<AiSpotterControlsSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.repeat.clear(ev.action.id);
    this.setActiveBinding(SPOTTER_GLOBAL_KEYS[settings.control]);
    await this.updateDisplay(ev, settings);
  }

  /** The press sounds' shape of a key press (#269); see {@link spotterPressShape}. */
  keyPressShape(ev: IDeckKeyDownEvent<AiSpotterControlsSettings>): PressShape {
    return spotterPressShape(this.parseSettings(ev.payload.settings).control);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<AiSpotterControlsSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    const { control } = settings;

    if (isSpotterVolumeControl(control)) {
      // Hold-to-repeat in every paired style (#1453): armed SYNCHRONOUSLY,
      // before the first step's await, so a racing keyUp always finds the
      // timers to clear. Every step, the first and each repeat, goes through
      // performVolumeStep; a tap that did not send ends the repeat.
      if (volumeKeyRepeats(settings.keyStyle)) {
        this.repeat.onKeyDown(ev.action.id, {
          holdMs: getDualPressThresholdMs(),
          intervalMs: ADJUST_REPEAT_INTERVAL_MS,
          safetyMs: ADJUST_REPEAT_SAFETY_MS,
          execute: () => this.performVolumeStep(control),
        });
      }

      await this.performVolumeStep(control);

      return;
    }

    const settingKey = SPOTTER_GLOBAL_KEYS[control];

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${settings.control}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<AiSpotterControlsSettings>): Promise<void> {
    this.repeat.onKeyUp(ev.action.id);
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<AiSpotterControlsSettings>): Promise<void> {
    this.repeat.clear(ev.action.id);
    await super.onWillDisappear(ev);
  }

  /**
   * One spotter volume step — the first press and every hold-to-repeat step
   * alike (#1453): a tap of the Spotter Louder / Quieter key binding. Returns
   * whether the press was sent, and a sent press ticks (#1455) while the sim
   * is connected. The other controls are not steps and never tick.
   */
  private async performVolumeStep(control: SpotterVolumeControl): Promise<boolean> {
    const sent = await this.tapBinding(SPOTTER_GLOBAL_KEYS[control]);

    if (sent) tickIRacingVolumeStep(control === "louder" ? "up" : "down");

    return sent;
  }

  private parseSettings(settings: unknown): AiSpotterControlsSettings {
    const parsed = AiSpotterControlsSettings.safeParse(settings);

    return parsed.success ? parsed.data : AiSpotterControlsSettings.parse({});
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<AiSpotterControlsSettings> | IDeckDidReceiveSettingsEvent<AiSpotterControlsSettings>,
    settings: AiSpotterControlsSettings,
  ): Promise<void> {
    const render = () =>
      renderAiSpotterControlsIcon(settings, this.isBindingMissing(SPOTTER_GLOBAL_KEYS[settings.control]));
    await ev.action.setTitle("");
    await this.setKeyImage(ev, render());
    this.setRegenerateCallback(ev.action.id, render);
  }
}
