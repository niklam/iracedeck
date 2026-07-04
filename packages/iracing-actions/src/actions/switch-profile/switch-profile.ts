import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  requestProfileSwitch,
  requestProfileSwitchBack,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import chatIconSvg from "@iracedeck/icons/switch-profile/chat.svg";
import defaultIconSvg from "@iracedeck/icons/switch-profile/default.svg";
import previousIconSvg from "@iracedeck/icons/switch-profile/previous.svg";
import raceAdminCarsIconSvg from "@iracedeck/icons/switch-profile/race-admin-cars.svg";
import raceAdminPerCarIconSvg from "@iracedeck/icons/switch-profile/race-admin-per-car.svg";
import replayIconSvg from "@iracedeck/icons/switch-profile/replay.svg";
import z from "zod";

import profilesData from "../data/profiles.json" with { type: "json" };

/**
 * Sentinel `profile` value for the "Back to previous" mode: instead of a named
 * profile, the press calls `switchToProfile` with no profile, which returns the
 * device to the profile it came from. Must match the option value rendered by
 * `ird-profile-select` (`packages/pi-components/src/components/profile-select.ts`).
 */
export const PREVIOUS_PROFILE_VALUE = "__previous" as const;

/**
 * Icon artwork keyed by the exact profile name. Anything not listed (including
 * `iRaceDeck Default`, an unknown name, or no selection) falls back to the
 * iRaceDeck logo. Add a row here when a new bundled profile deserves its own icon.
 */
const PROFILE_ICONS: Record<string, string> = {
  "iRaceDeck Replay": replayIconSvg,
  "iRaceDeck Chat": chatIconSvg,
  "iRaceDeck Race Admin Cars": raceAdminCarsIconSvg,
  "iRaceDeck Race Admin Per Car": raceAdminPerCarIconSvg,
  [PREVIOUS_PROFILE_VALUE]: previousIconSvg,
};

const SwitchProfileSettings = CommonSettings.extend({
  /** The bundled profile name to switch to (matches the manifest `Profiles[].Name`). */
  profile: z.string().default(""),
  /**
   * Runtime-populated list of profiles available for this action's device,
   * pushed by the action for the PI dropdown. Not user-editable.
   */
  _deviceProfiles: z.array(z.string()).optional(),
});

type SwitchProfileSettings = z.infer<typeof SwitchProfileSettings>;

/**
 * Multi-line title overrides for profiles whose stripped name is too long for
 * a single line on the key. Anything not listed renders as one line.
 */
const PROFILE_TITLES: Record<string, string> = {
  "iRaceDeck Race Admin Cars": "RACE ADMIN\nCARS",
  "iRaceDeck Race Admin Per Car": "RACE ADMIN\nPER CAR",
};

/**
 * @internal Exported for testing. Short, upper-cased key-title for a profile
 * (drops the `iRaceDeck` prefix); a generic label when nothing is selected.
 */
export function profileTitle(profile: string): string {
  // Back-to-previous shows only the chevron glyph — no title.
  if (profile === PREVIOUS_PROFILE_VALUE) return "";

  if (!profile) return "SWITCH\nPROFILE";

  return PROFILE_TITLES[profile] ?? profile.replace(/^iRaceDeck\s+/i, "").toUpperCase();
}

/**
 * @internal Exported for testing. Bundled profile names available for a device
 * type, read from the generated `data/profiles.json` (mirrors the manifest).
 */
export function availableProfilesForDevice(deviceType: number | undefined): string[] {
  if (deviceType === undefined) return [];

  return profilesData.filter((p) => p.deviceType === deviceType).map((p) => p.name);
}

/**
 * @internal Exported for testing.
 */
export function generateSwitchProfileSvg(settings: SwitchProfileSettings): string {
  const iconSvg = PROFILE_ICONS[settings.profile] ?? defaultIconSvg;
  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(
    iconSvg,
    getGlobalTitleSettings(),
    settings.titleOverrides,
    profileTitle(settings.profile),
  );
  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);
  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Switch Profile Action (Elgato-only, #736)
 *
 * Presents a dropdown of the bundled profiles available for this button's device
 * and, on press, switches the Stream Deck to the selected profile (which prompts
 * the app to install it if needed). The icon reflects the chosen profile.
 */
export const SWITCH_PROFILE_UUID = "com.iracedeck.sd.core.switch-profile" as const;

export class SwitchProfile extends ConnectionStateAwareAction<SwitchProfileSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<SwitchProfileSettings>): Promise<void> {
    await super.onWillAppear(ev);
    await this.sync(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SwitchProfileSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    await this.sync(ev);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<SwitchProfileSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    // Back to previous: go back by name via the plugin's own switch history
    // (the app-level "no profile" pop only works one level deep, right after a
    // plugin-pushed switch — see requestProfileSwitchBack).
    if (settings.profile === PREVIOUS_PROFILE_VALUE) {
      this.logger.info("Switch Profile triggered (back to previous)");
      await requestProfileSwitchBack(ev.action.deviceId);

      return;
    }

    if (!settings.profile) {
      this.logger.info("Switch Profile pressed with no profile selected");

      return;
    }

    this.logger.info("Switch Profile triggered");
    this.logger.debug(`Switching device ${ev.action.deviceId ?? "(unknown)"} to profile "${settings.profile}"`);
    // Page 0: named switches always open a profile on its first page — needed
    // by the Race Admin selector's page-count learning (#754), and predictable
    // everywhere else. Back-to-previous above deliberately restores the page
    // you left instead.
    await requestProfileSwitch(ev.action.deviceId, settings.profile, 0);
  }

  /**
   * Push the device-filtered profile list to the PI (once — guarded against the
   * setSettings→onDidReceiveSettings loop) and refresh the icon.
   */
  private async sync(
    ev: IDeckWillAppearEvent<SwitchProfileSettings> | IDeckDidReceiveSettingsEvent<SwitchProfileSettings>,
  ): Promise<void> {
    const available = availableProfilesForDevice(ev.action.deviceType);
    const raw = (ev.payload.settings ?? {}) as Record<string, unknown>;
    const current = Array.isArray(raw._deviceProfiles) ? (raw._deviceProfiles as string[]) : [];

    if (!arraysEqual(current, available)) {
      await ev.action.setSettings({ ...raw, _deviceProfiles: available });
    }

    await this.updateDisplay(ev, this.parseSettings(ev.payload.settings));
  }

  private parseSettings(settings: unknown): SwitchProfileSettings {
    const parsed = SwitchProfileSettings.safeParse(settings);

    return parsed.success ? parsed.data : SwitchProfileSettings.parse({});
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<SwitchProfileSettings> | IDeckDidReceiveSettingsEvent<SwitchProfileSettings>,
    settings: SwitchProfileSettings,
  ): Promise<void> {
    await ev.action.setTitle("");
    await this.setKeyImage(ev, generateSwitchProfileSvg(settings));
    this.setRegenerateCallback(ev.action.id, () => generateSwitchProfileSvg(settings));
  }
}
