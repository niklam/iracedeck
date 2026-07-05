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
  notifyProfileVisible,
  PROFILE_NAMES,
  profileDisplayName,
  requestProfileSwitch,
  requestProfileSwitchBack,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveProfileNameForDevice,
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
 * Icon artwork keyed by the profile's DISPLAY name — the manifest name minus
 * its device suffix (#753), so one row covers every device variant. Anything
 * not listed (including `iRaceDeck Default`, an unknown name, or no selection)
 * falls back to the iRaceDeck logo. Add a row here when a new bundled profile
 * deserves its own icon.
 */
const PROFILE_ICONS: Record<string, string> = {
  "iRaceDeck Replay": replayIconSvg,
  "iRaceDeck Chat": chatIconSvg,
  "iRaceDeck Race Admin Cars": raceAdminCarsIconSvg,
  "iRaceDeck Race Admin Per Car": raceAdminPerCarIconSvg,
  [PREVIOUS_PROFILE_VALUE]: previousIconSvg,
};

const SwitchProfileSettings = CommonSettings.extend({
  /**
   * The bundled profile name to switch to. Persisted values may be the
   * device-suffixed manifest name (from the PI dropdown), a legacy pre-#753
   * unsuffixed name, or a name suffixed for another device — all are resolved
   * to this device's manifest name at press time. Defaults to the default
   * profile (issue #755) so a freshly-placed key works without any
   * configuration; an empty string (persisted by older installs) falls back to
   * the same at press time.
   */
  profile: z.string().default(PROFILE_NAMES.default),
  /**
   * Host-profile marker (issue #762): the bundled profile this key is placed
   * in, set while authoring the bundled profiles. When non-empty, the key
   * reports it via `notifyProfileVisible` on appear, which is how the plugin
   * learns the active profile (the Elgato SDK cannot query it) so that
   * Back-to-previous can return to it by name. Empty for user-placed keys.
   * Resolved to the device's manifest name like `profile` — the bundles carry
   * clean (unsuffixed) marker values (#753).
   */
  hostProfile: z.string().default(""),
  /**
   * Runtime-populated list of profiles available for this action's device,
   * pushed by the action for the PI dropdown as `{ name, label }` entries
   * (manifest name + clean display label, #753). Plain strings are the legacy
   * pre-#753 shape, tolerated so old persisted settings still parse. Not
   * user-editable.
   */
  _deviceProfiles: z.array(z.union([z.string(), z.object({ name: z.string(), label: z.string() })])).optional(),
});

type SwitchProfileSettings = z.infer<typeof SwitchProfileSettings>;

/**
 * Multi-line title overrides for profiles whose stripped name is too long for
 * a single line on the key, keyed by DISPLAY name (#753). Anything not listed
 * renders as one line.
 */
const PROFILE_TITLES: Record<string, string> = {
  "iRaceDeck Race Admin Cars": "RACE ADMIN\nCARS",
  "iRaceDeck Race Admin Per Car": "RACE ADMIN\nPER CAR",
};

/**
 * @internal Exported for testing. Short, upper-cased key-title for a profile
 * (drops the `iRaceDeck` prefix), derived from the display name so a device
 * suffix never renders on the key (#753). The default profile — and an empty
 * selection, which behaves as the default — shows no title: the iRaceDeck logo
 * is clear enough on its own (issue #755). Back-to-previous likewise shows
 * only its chevron glyph.
 */
export function profileTitle(profile: string): string {
  if (profile === PREVIOUS_PROFILE_VALUE) return "";

  const display = profileDisplayName(profile);

  if (!display || display === PROFILE_NAMES.default) return "";

  return PROFILE_TITLES[display] ?? display.replace(/^iRaceDeck\s+/i, "").toUpperCase();
}

/**
 * @internal Exported for testing. Bundled profile (manifest) names available
 * for a device type, read from the generated `data/profiles.json` (mirrors the
 * manifest).
 */
export function availableProfilesForDevice(deviceType: number | undefined): string[] {
  if (deviceType === undefined) return [];

  return profilesData.filter((p) => p.deviceType === deviceType).map((p) => p.name);
}

/** A `_deviceProfiles` entry: manifest name + clean display label (#753). */
export interface ProfileEntry {
  name: string;
  label: string;
}

/**
 * @internal Exported for testing. The `_deviceProfiles` entries pushed for the
 * PI dropdown: each available manifest name paired with its clean display
 * label, so the dropdown never shows device suffixes (#753).
 */
export function deviceProfileEntries(deviceType: number | undefined): ProfileEntry[] {
  if (deviceType === undefined) return [];

  return profilesData.filter((p) => p.deviceType === deviceType).map((p) => ({ name: p.name, label: p.displayName }));
}

/**
 * @internal Exported for testing. The bundled Default profile's manifest name
 * for a device type (device-suffixed, #753), or `undefined` when the device
 * ships none. Used as the Back-to-previous fallback destination when the
 * profile history is empty (issue #762) and as the press-time fallback for a
 * stored name with no variant on this device.
 */
export function defaultProfileForDevice(deviceType: number | undefined): string | undefined {
  return resolveProfileNameForDevice(PROFILE_NAMES.default, deviceType, availableProfilesForDevice(deviceType));
}

/**
 * @internal Exported for testing.
 */
export function generateSwitchProfileSvg(settings: SwitchProfileSettings): string {
  const profile = settings.profile ?? "";
  const iconSvg = PROFILE_ICONS[profileDisplayName(profile)] ?? defaultIconSvg;
  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, profileTitle(profile));
  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);
  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
}

/** Whether a persisted `_deviceProfiles` value already equals the entries we'd push. */
function profileEntriesEqual(current: readonly unknown[], entries: readonly ProfileEntry[]): boolean {
  return (
    current.length === entries.length &&
    current.every((value, i) => {
      const entry = entries[i];

      return (
        typeof value === "object" &&
        value !== null &&
        (value as ProfileEntry).name === entry.name &&
        (value as ProfileEntry).label === entry.label
      );
    })
  );
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

    // Back to previous: walk back by name through the plugin's profile history,
    // falling back to the device's bundled Default profile when the history is
    // empty (the app-level "no profile" pop only works one level deep, right
    // after a plugin-pushed switch — see requestProfileSwitchBack, #762).
    if (settings.profile === PREVIOUS_PROFILE_VALUE) {
      this.logger.info("Switch Profile triggered (back to previous)");
      await requestProfileSwitchBack(ev.action.deviceId, defaultProfileForDevice(ev.action.deviceType));

      return;
    }

    // An empty selection (older installs persisted "", and a cleared PI field
    // bypasses the Zod default) behaves as the default profile (#755) — a
    // Switch Profile key is never a no-op. The stored name is then resolved to
    // this device's manifest name (#753): an exact match passes through, a
    // legacy pre-#753 name (or one suffixed for another device) maps to this
    // device's variant, and a name with no variant here falls back to the
    // device's Default profile.
    const stored = settings.profile || PROFILE_NAMES.default;
    const profile =
      resolveProfileNameForDevice(stored, ev.action.deviceType, availableProfilesForDevice(ev.action.deviceType)) ??
      defaultProfileForDevice(ev.action.deviceType);

    // No bundled profile resolves at all (a device we ship nothing for):
    // switching to a guessed name could only fail in the app and would pollute
    // the Back-to-previous history with a name that doesn't exist.
    if (!profile) {
      this.logger.warn(`No bundled profile available for device ${ev.action.deviceId ?? "(unknown)"}; ignoring press`);

      return;
    }

    this.logger.info("Switch Profile triggered");
    this.logger.debug(`Switching device ${ev.action.deviceId ?? "(unknown)"} to profile "${profile}"`);
    // Page 0: named switches always open a profile on its first page — needed
    // by the Race Admin selector's page-count learning (#754), and predictable
    // everywhere else. Back-to-previous above deliberately restores the page
    // you left instead.
    await requestProfileSwitch(ev.action.deviceId, profile, 0);
  }

  /**
   * Push the device-filtered profile list to the PI (once — guarded against the
   * setSettings→onDidReceiveSettings loop), report the host-profile marker to
   * the profile history (#762), and refresh the icon.
   */
  private async sync(
    ev: IDeckWillAppearEvent<SwitchProfileSettings> | IDeckDidReceiveSettingsEvent<SwitchProfileSettings>,
  ): Promise<void> {
    const entries = deviceProfileEntries(ev.action.deviceType);
    const raw = (ev.payload.settings ?? {}) as Record<string, unknown>;
    const current = Array.isArray(raw._deviceProfiles) ? (raw._deviceProfiles as unknown[]) : [];

    if (!profileEntriesEqual(current, entries)) {
      await ev.action.setSettings({ ...raw, _deviceProfiles: entries });
    }

    const settings = this.parseSettings(ev.payload.settings);

    if (settings.hostProfile) {
      // The bundled profiles carry clean (unsuffixed) marker values; resolve to
      // this device's manifest name so the history holds switchable names
      // (#753). An unresolvable marker is reported as stored.
      notifyProfileVisible(
        ev.action.deviceId,
        resolveProfileNameForDevice(
          settings.hostProfile,
          ev.action.deviceType,
          availableProfilesForDevice(ev.action.deviceType),
        ) ?? settings.hostProfile,
      );
    }

    await this.updateDisplay(ev, settings);
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
