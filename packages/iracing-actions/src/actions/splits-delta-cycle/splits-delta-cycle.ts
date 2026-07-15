import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckTouchTapEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  onGlobalSettingsChange,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import activeResetRunIconSvg from "@iracedeck/icons/splits-delta-cycle/active-reset-run.svg";
import activeResetSetIconSvg from "@iracedeck/icons/splits-delta-cycle/active-reset-set.svg";
import customSectorEndIconSvg from "@iracedeck/icons/splits-delta-cycle/custom-sector-end.svg";
import customSectorStartIconSvg from "@iracedeck/icons/splits-delta-cycle/custom-sector-start.svg";
import displayRefCarIconSvg from "@iracedeck/icons/splits-delta-cycle/display-ref-car.svg";
import nextIconSvg from "@iracedeck/icons/splits-delta-cycle/next.svg";
import previousIconSvg from "@iracedeck/icons/splits-delta-cycle/previous.svg";
import z from "zod";

import { DialSettings, SplitsDeltaCycleDialSurface } from "./splits-delta-cycle-dial-surface.js";

const DIRECTION_ICONS: Record<string, string> = {
  next: nextIconSvg,
  previous: previousIconSvg,
};

const MODE_ICONS: Record<string, string> = {
  "custom-sector-start": customSectorStartIconSvg,
  "custom-sector-end": customSectorEndIconSvg,
  "active-reset-set": activeResetSetIconSvg,
  "active-reset-run": activeResetRunIconSvg,
};

const MODE_TITLES: Record<string, string> = {
  "custom-sector-start": "SECTOR\nSTART",
  "custom-sector-end": "SECTOR\nEND",
  "active-reset-set": "RESET POINT\nSET",
  "active-reset-run": "TO START\nRESET",
};

const SplitsDeltaCycleSettings = CommonSettings.extend({
  mode: z
    .enum([
      "cycle",
      "toggle-ref-car",
      "custom-sector-start",
      "custom-sector-end",
      "active-reset-set",
      "active-reset-run",
    ])
    .default("cycle"),
  direction: z.enum(["next", "previous"]).default("next"),
  // Dial-surface settings (#807), under the `dial` root so keypad and dial keys
  // can't collide. catch: dial garbage degrades to dial defaults instead of
  // failing the whole parse (which would reset a keypad instance).
  dial: DialSettings.catch(() => DialSettings.parse({})),
});

type SplitsDeltaCycleSettings = z.infer<typeof SplitsDeltaCycleSettings>;

/**
 * @internal Exported for testing
 */
export const GLOBAL_KEY_NAMES = {
  NEXT: "splitsDeltaNext",
  PREVIOUS: "splitsDeltaPrevious",
  TOGGLE_REF_CAR: "toggleUiDisplayRefCar",
  CUSTOM_SECTOR_START: "splitsDeltaCustomSectorStart",
  CUSTOM_SECTOR_END: "splitsDeltaCustomSectorEnd",
  ACTIVE_RESET_SET: "splitsDeltaActiveResetSet",
  ACTIVE_RESET_RUN: "splitsDeltaActiveResetRun",
} as const;

const MODE_KEY_MAP: Record<string, string> = {
  "custom-sector-start": GLOBAL_KEY_NAMES.CUSTOM_SECTOR_START,
  "custom-sector-end": GLOBAL_KEY_NAMES.CUSTOM_SECTOR_END,
  "active-reset-set": GLOBAL_KEY_NAMES.ACTIVE_RESET_SET,
  "active-reset-run": GLOBAL_KEY_NAMES.ACTIVE_RESET_RUN,
  "toggle-ref-car": GLOBAL_KEY_NAMES.TOGGLE_REF_CAR,
};

/**
 * @internal Exported for testing
 */
export function generateSplitsDeltaCycleSvg(settings: SplitsDeltaCycleSettings, bindingMissing = false): string {
  const { mode, direction } = settings;

  // toggle-ref-car uses a dedicated icon from splits-delta-cycle
  if (mode === "toggle-ref-car") {
    const colors = resolveIconColors(displayRefCarIconSvg, getGlobalColors(), settings.colorOverrides);
    const title = resolveTitleSettings(
      displayRefCarIconSvg,
      getGlobalTitleSettings(),
      settings.titleOverrides,
      "CAR\nREFERENCE",
    );

    const border = resolveBorderSettings(displayRefCarIconSvg, getGlobalBorderSettings(), settings.borderOverrides);

    const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

    return assembleIcon({ graphicSvg: displayRefCarIconSvg, colors, title, border, graphic, bindingMissing });
  }

  const modeIconSvg = MODE_ICONS[mode];

  if (modeIconSvg) {
    const colors = resolveIconColors(modeIconSvg, getGlobalColors(), settings.colorOverrides);
    const title = resolveTitleSettings(
      modeIconSvg,
      getGlobalTitleSettings(),
      settings.titleOverrides,
      MODE_TITLES[mode],
    );

    const border = resolveBorderSettings(modeIconSvg, getGlobalBorderSettings(), settings.borderOverrides);

    const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

    return assembleIcon({ graphicSvg: modeIconSvg, colors, title, border, graphic, bindingMissing });
  }

  const iconSvg = DIRECTION_ICONS[direction] || DIRECTION_ICONS.next;
  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const defaultTitle = direction === "next" ? "SPLITS DELTA\nNEXT" : "SPLITS DELTA\nPREVIOUS";
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
}

/**
 * Splits & Reference Action
 * Cycles through iRacing split-time delta display modes or toggles the reference car display.
 */
export const SPLITS_DELTA_CYCLE_UUID = "com.iracedeck.sd.core.splits-delta-cycle" as const;

export class SplitsDeltaCycle extends ConnectionStateAwareAction<SplitsDeltaCycleSettings> {
  /**
   * The dial half of the action; all IDeck dial events route here (#807). No
   * `setActiveBinding` is delegated — it would bleed onto the keypad buttons.
   */
  private readonly dialSurface = new SplitsDeltaCycleDialSurface({
    logger: this.logger,
    tapBinding: (settingKey) => this.tapBinding(settingKey),
    isBindingMissing: (keys) => this.isBindingMissing(keys),
  });

  /** Keeps the dial strip's #612 missing-binding warning live while iRacing is offline (#807). */
  private readonly unsubscribeGlobalSettings = onGlobalSettingsChange(() => this.dialSurface.refreshAll());

  override async onWillAppear(ev: IDeckWillAppearEvent<SplitsDeltaCycleSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      // The dial has a single rotation behavior (cycle) and its own gesture
      // defaults, so a pre-dial-surface encoder placement needs no migration —
      // an absent `dial` prefaults cleanly.
      await this.dialSurface.willAppear(ev.action, settings.dial);

      return;
    }

    this.setActiveBinding(this.resolveSettingKey(settings));
    await this.updateDisplay(ev, settings);
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<SplitsDeltaCycleSettings>): Promise<void> {
    this.dialSurface.willDisappear(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SplitsDeltaCycleSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      await this.dialSurface.didReceiveSettings(ev.action, settings.dial);

      return;
    }

    this.setActiveBinding(this.resolveSettingKey(settings));
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<SplitsDeltaCycleSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.tapBinding(this.resolveSettingKey(settings));
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<SplitsDeltaCycleSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.rotate(ev.action, settings.dial, ev.payload.ticks, ev.payload.pressed === true);
  }

  override async onDialDown(ev: IDeckDialDownEvent<SplitsDeltaCycleSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.down(ev.action, settings.dial);
  }

  override async onDialUp(ev: IDeckDialUpEvent<SplitsDeltaCycleSettings>): Promise<void> {
    await this.dialSurface.up(ev.action.id);
  }

  override async onTouchTap(ev: IDeckTouchTapEvent<SplitsDeltaCycleSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.touchTap(ev.action, settings.dial, ev.payload.hold === true);
  }

  private parseSettings(settings: unknown): SplitsDeltaCycleSettings {
    const parsed = SplitsDeltaCycleSettings.safeParse(settings);

    return parsed.success ? parsed.data : SplitsDeltaCycleSettings.parse({});
  }

  private resolveSettingKey(settings: SplitsDeltaCycleSettings): string {
    return (
      MODE_KEY_MAP[settings.mode] ?? (settings.direction === "next" ? GLOBAL_KEY_NAMES.NEXT : GLOBAL_KEY_NAMES.PREVIOUS)
    );
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<SplitsDeltaCycleSettings> | IDeckDidReceiveSettingsEvent<SplitsDeltaCycleSettings>,
    settings: SplitsDeltaCycleSettings,
  ): Promise<void> {
    const svgDataUri = generateSplitsDeltaCycleSvg(settings, this.isBindingMissing(this.resolveSettingKey(settings)));
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () =>
      generateSplitsDeltaCycleSvg(settings, this.isBindingMissing(this.resolveSettingKey(settings))),
    );
  }
}
