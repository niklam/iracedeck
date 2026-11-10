import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  getDualPressThresholdMs,
  getGlobalBorderSettings,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckKeyUpEvent,
  type IDeckTouchTapEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  type PressShape,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import decrementControlIconSvg from "@iracedeck/icons/black-box-selector/decrement-control.svg";
import fuelIconSvg from "@iracedeck/icons/black-box-selector/fuel.svg";
import inCarIconSvg from "@iracedeck/icons/black-box-selector/in-car.svg";
import incrementControlIconSvg from "@iracedeck/icons/black-box-selector/increment-control.svg";
import lapTimingIconSvg from "@iracedeck/icons/black-box-selector/lap-timing.svg";
import nextControlIconSvg from "@iracedeck/icons/black-box-selector/next-control.svg";
import nextIconSvg from "@iracedeck/icons/black-box-selector/next.svg";
import pitStopIconSvg from "@iracedeck/icons/black-box-selector/pit-stop.svg";
import previousControlIconSvg from "@iracedeck/icons/black-box-selector/previous-control.svg";
import previousIconSvg from "@iracedeck/icons/black-box-selector/previous.svg";
import quickAccessIconSvg from "@iracedeck/icons/black-box-selector/quick-access.svg";
import radioIconSvg from "@iracedeck/icons/black-box-selector/radio.svg";
import relativeIconSvg from "@iracedeck/icons/black-box-selector/relative.svg";
import standingsIconSvg from "@iracedeck/icons/black-box-selector/standings.svg";
import tireInfoIconSvg from "@iracedeck/icons/black-box-selector/tire-info.svg";
import tiresIconSvg from "@iracedeck/icons/black-box-selector/tires.svg";
import toggleControlIconSvg from "@iracedeck/icons/black-box-selector/toggle-control.svg";
import toggleSizeIconSvg from "@iracedeck/icons/black-box-selector/toggle-size.svg";
import weatherIconSvg from "@iracedeck/icons/black-box-selector/weather.svg";
import { getGlobalColors, onGlobalSettingsChange } from "@iracedeck/settings";
import z from "zod";

import { ADJUST_REPEAT_INTERVAL_MS, ADJUST_REPEAT_SAFETY_MS } from "../../shared/adjust-styles.js";
import {
  BLACK_BOX_CONTROL_KEYS,
  BLACK_BOX_GLOBAL_KEYS,
  BLACK_BOX_SELECTED_CONTROL_KEYS,
  BLACK_BOX_SELECTED_CONTROLS,
  type BlackBoxSelectedControl,
} from "../../shared/black-box.js";
import { RepeatController } from "../../shared/repeat-controller.js";
import { BlackBoxSelectorDialSurface, DialSettings } from "./black-box-selector-dial-surface.js";

const DIRECT_ICONS: Record<string, string> = {
  "lap-timing": lapTimingIconSvg,
  standings: standingsIconSvg,
  relative: relativeIconSvg,
  fuel: fuelIconSvg,
  tires: tiresIconSvg,
  "tire-info": tireInfoIconSvg,
  "pit-stop": pitStopIconSvg,
  "in-car": inCarIconSvg,
  mirror: quickAccessIconSvg,
  radio: radioIconSvg,
  weather: weatherIconSvg,
};

const CYCLE_ICONS: Record<string, string> = {
  next: nextIconSvg,
  previous: previousIconSvg,
};

/** The Selected Control mode's artwork, one per press (#1585): a d-pad with one direction, or its centre, lit. */
const SELECTED_CONTROL_ICONS: Record<BlackBoxSelectedControl, string> = {
  next: nextControlIconSvg,
  previous: previousControlIconSvg,
  increment: incrementControlIconSvg,
  decrement: decrementControlIconSvg,
  toggle: toggleControlIconSvg,
};

/**
 * Title text for each black box type. Single-line — a leading newline
 * would reserve a phantom first line in the title block and pull the
 * artwork upward (see .claude/rules/icons.md).
 */
const BLACK_BOX_TITLE_TEXT: Record<string, string> = {
  "lap-timing": "LAP TIMING",
  standings: "STANDINGS",
  relative: "RELATIVE",
  fuel: "FUEL",
  tires: "TIRES",
  "tire-info": "TIRE INFO",
  "pit-stop": "PIT-STOP",
  "in-car": "IN-CAR",
  mirror: "QUICK ACCESS",
  radio: "RADIO",
  weather: "WEATHER",
};

/** The Selected Control mode's default titles (#1585), single-line like the box titles above. */
const SELECTED_CONTROL_TITLE_TEXT: Record<BlackBoxSelectedControl, string> = {
  next: "NEXT CTRL",
  previous: "PREV CTRL",
  increment: "CTRL +",
  decrement: "CTRL -",
  toggle: "CTRL TOGGLE",
};

/**
 * @internal Re-exported for the existing tests. The map itself lives in
 * `shared/black-box.ts`, which is also what the #612 comms catalog imports.
 */
export { BLACK_BOX_GLOBAL_KEYS };

/**
 * @internal Exported for testing
 */
export const BlackBoxSelectorSettings = CommonSettings.extend({
  mode: z.enum(["direct", "next", "previous", "toggle-size", "selected-control"]).default("direct"),
  blackBox: z
    .enum([
      "lap-timing",
      "standings",
      "relative",
      "fuel",
      "tires",
      "tire-info",
      "pit-stop",
      "in-car",
      "mirror",
      "radio",
      "weather",
    ])
    .default("lap-timing"),
  // The press of the Selected Control mode (#1585). Kept while another mode is
  // chosen, as `blackBox` is, so switching back restores the user's choice.
  control: z.enum(BLACK_BOX_SELECTED_CONTROLS).default("next"),
  // Dial-surface settings (#808), under the `dial` root so keypad and dial keys
  // can't collide. catch: dial garbage degrades to dial defaults instead of
  // failing the whole parse (which would reset a keypad instance).
  dial: DialSettings.catch(() => DialSettings.parse({})),
});

export type BlackBoxSelectorSettings = z.infer<typeof BlackBoxSelectorSettings>;

/**
 * @internal Exported for testing
 *
 * The global-settings key a keypad press taps for the given settings. Exhaustive
 * over `mode`, so a new mode stops compiling here until it names its key rather
 * than falling through to another mode's.
 */
export function resolveBlackBoxSettingKey(settings: BlackBoxSelectorSettings): string {
  const { mode, blackBox } = settings;

  switch (mode) {
    case "direct":
      return BLACK_BOX_GLOBAL_KEYS[blackBox];
    case "next":
      return BLACK_BOX_CONTROL_KEYS.cycleNext;
    case "previous":
      return BLACK_BOX_CONTROL_KEYS.cyclePrevious;
    case "toggle-size":
      return BLACK_BOX_CONTROL_KEYS.toggleSize;
    case "selected-control":
      return BLACK_BOX_SELECTED_CONTROL_KEYS[settings.control];
    default: {
      const unhandled: never = mode;

      throw new Error(`Black Box Selector: no binding for mode "${String(unhandled)}"`);
    }
  }
}

/**
 * The artwork and default title a key shows for its settings. Exhaustive over
 * `mode`, like {@link resolveBlackBoxSettingKey}, so a new mode stops compiling
 * here until it names its icon rather than drawing the Direct box's.
 */
function blackBoxIconFor(settings: BlackBoxSelectorSettings): { iconSvg: string; defaultTitle: string } {
  const { mode, blackBox } = settings;

  switch (mode) {
    case "direct":
      return {
        iconSvg: DIRECT_ICONS[blackBox] || DIRECT_ICONS["lap-timing"],
        defaultTitle: BLACK_BOX_TITLE_TEXT[blackBox] || "BLACK BOX",
      };
    case "next":
      return { iconSvg: CYCLE_ICONS.next, defaultTitle: "NEXT" };
    case "previous":
      return { iconSvg: CYCLE_ICONS.previous, defaultTitle: "PREVIOUS" };
    case "toggle-size":
      return { iconSvg: toggleSizeIconSvg, defaultTitle: "BOX SIZE" };
    case "selected-control":
      return {
        iconSvg: SELECTED_CONTROL_ICONS[settings.control],
        defaultTitle: SELECTED_CONTROL_TITLE_TEXT[settings.control],
      };
    default: {
      const unhandled: never = mode;

      throw new Error(`Black Box Selector: no icon for mode "${String(unhandled)}"`);
    }
  }
}

/**
 * @internal Exported for testing
 *
 * Whether a key press repeats while held (#1585): Increment and Decrement
 * Selected Control do, as every directional adjust key in the plugin does, so a
 * brake-bias or pit-request change is not one press per step. Every other press
 * is a single tap: repeating a selection, a toggle or a box hotkey on a long
 * press would overshoot. Every key, a repeating one included, has the press
 * sounds' default tap shape: no `keyPressShape`, since a repeat's steps are
 * their own feedback and release does nothing a bleep could promise (#269).
 */
export function blackBoxKeyRepeats(settings: BlackBoxSelectorSettings): boolean {
  return settings.mode === "selected-control" && (settings.control === "increment" || settings.control === "decrement");
}

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the black box selector action.
 */
export function generateBlackBoxSelectorSvg(settings: BlackBoxSelectorSettings, bindingMissing = false): string {
  const { iconSvg, defaultTitle } = blackBoxIconFor(settings);

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
}

/**
 * Black Box Selector Action
 * Cycles through or directly selects iRacing black box screens, toggles the
 * shown box's size, or operates the selected control of the open box, via
 * keyboard shortcuts.
 */
export const BLACK_BOX_SELECTOR_UUID = "com.iracedeck.sd.core.black-box-selector" as const;

export class BlackBoxSelector extends ConnectionStateAwareAction<BlackBoxSelectorSettings> {
  /** Hold-to-repeat for Increment / Decrement Selected Control (#1585); every other key taps once. */
  private readonly repeat = new RepeatController(this.logger);

  /**
   * The dial half of the action; all IDeck dial events route here (#808).
   */
  private readonly dialSurface = new BlackBoxSelectorDialSurface({
    logger: this.logger,
    tapBinding: (settingKey) => this.tapBinding(settingKey),
    isBindingMissing: (keys) => this.isBindingMissing(keys),
  });

  /** Keeps the dial strips' #612 missing-binding warning live while iRacing is offline (#808). */
  private readonly unsubscribeGlobalSettings = onGlobalSettingsChange(() => this.dialSurface.refreshAll());

  override async onWillAppear(ev: IDeckWillAppearEvent<BlackBoxSelectorSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      await this.dialSurface.willAppear(ev.action, settings.dial);

      return;
    }

    await this.updateDisplay(ev, settings);
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<BlackBoxSelectorSettings>): Promise<void> {
    this.repeat.clear(ev.action.id);
    this.dialSurface.willDisappear(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<BlackBoxSelectorSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.repeat.clear(ev.action.id);

    if (ev.action.isDial()) {
      await this.dialSurface.didReceiveSettings(ev.action, settings.dial);

      return;
    }

    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<BlackBoxSelectorSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    const settingKey = resolveBlackBoxSettingKey(settings);

    // Toggle Size and the Selected Control presses need no #818 prime-then-target
    // sequence: they act on whatever box is shown, whichever it is (#1238, #1585).
    if (!blackBoxKeyRepeats(settings)) {
      await this.tapBinding(settingKey);

      return;
    }

    // Increment / Decrement Selected Control repeat while held (#1585). Armed
    // SYNCHRONOUSLY, before the first tap's await, so a racing keyUp always
    // finds the timers to clear. A tap that did not go out ends the repeat.
    this.repeat.onKeyDown(ev.action.id, {
      holdMs: getDualPressThresholdMs(),
      intervalMs: ADJUST_REPEAT_INTERVAL_MS,
      safetyMs: ADJUST_REPEAT_SAFETY_MS,
      execute: () => this.tapBinding(settingKey),
    });

    const sent = await this.tapBinding(settingKey);

    if (!sent) {
      this.repeat.clear(ev.action.id);
    }
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<BlackBoxSelectorSettings>): Promise<void> {
    this.repeat.onKeyUp(ev.action.id);
  }

  private parseSettings(settings: unknown): BlackBoxSelectorSettings {
    const parsed = BlackBoxSelectorSettings.safeParse(settings);

    return parsed.success ? parsed.data : BlackBoxSelectorSettings.parse({});
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<BlackBoxSelectorSettings> | IDeckDidReceiveSettingsEvent<BlackBoxSelectorSettings>,
    settings: BlackBoxSelectorSettings,
  ): Promise<void> {
    const svgDataUri = generateBlackBoxSelectorSvg(
      settings,
      this.isBindingMissing(resolveBlackBoxSettingKey(settings)),
    );
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () =>
      generateBlackBoxSelectorSvg(settings, this.isBindingMissing(resolveBlackBoxSettingKey(settings))),
    );
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<BlackBoxSelectorSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.rotate(ev.action, settings.dial, ev.payload.ticks, ev.payload.pressed === true);
  }

  /**
   * The press shape of a dial press (#269), from the dial surface, which
   * classifies the release.
   */
  dialPressShape(ev: IDeckDialDownEvent<BlackBoxSelectorSettings>): PressShape {
    return this.dialSurface.pressShape(ev.action, this.parseSettings(ev.payload.settings).dial);
  }

  /** The press shape of a touch on the strip (#269), from the dial surface. */
  touchPressShape(ev: IDeckTouchTapEvent<BlackBoxSelectorSettings>): PressShape {
    return this.dialSurface.touchShape(
      ev.action,
      this.parseSettings(ev.payload.settings).dial,
      ev.payload.hold === true,
    );
  }

  override async onDialDown(ev: IDeckDialDownEvent<BlackBoxSelectorSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.dialSurface.down(ev.action, settings.dial);
  }

  override async onDialUp(ev: IDeckDialUpEvent<BlackBoxSelectorSettings>): Promise<void> {
    // The raw settings ride along for the Switch Select / Adjust gesture, which
    // persists over them rather than over the parsed ones (rule 10).
    await this.dialSurface.up(ev.action.id, ev.payload.settings);
  }

  override async onTouchTap(ev: IDeckTouchTapEvent<BlackBoxSelectorSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.touchTap(ev.action, settings.dial, ev.payload.hold === true, ev.payload.settings);
  }
}
