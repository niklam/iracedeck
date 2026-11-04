/**
 * The bundled-profile reader and the shared `_deviceProfiles` entry helpers.
 *
 * Three actions push a device-filtered bundled-profile list to their PI
 * dropdowns (Switch Profile, Race Admin's select-car, Camera Controls'
 * focus-select-car), resolve a stored profile name against the same list at
 * press time, and guard the PI write with the same change comparison so the
 * setSettings→onDidReceiveSettings echo loop terminates. All of it lives here
 * so it can't drift between the actions (#790 review, #1375): this module is
 * the one reader of the generated `profiles.json`, which the Stream Deck
 * plugin's automatic session-kind switcher (#1111) also reaches through the
 * package's `availableProfilesForDevice` export.
 */
import profilesData from "../actions/data/profiles.json" with { type: "json" };

/** A `_deviceProfiles` entry: manifest name + clean display label (#753). */
export interface ProfileEntry {
  name: string;
  label: string;
}

/**
 * Bundled profile (manifest) names available for a device type, read from the
 * generated `actions/data/profiles.json` (mirrors the manifest). Empty when the
 * device type is unknown or the device ships no bundled profile.
 */
export function availableProfilesForDevice(deviceType: number | undefined): string[] {
  if (deviceType === undefined) return [];

  return profilesData.filter((p) => p.deviceType === deviceType).map((p) => p.name);
}

/**
 * The `_deviceProfiles` entries pushed for a PI profile dropdown: each
 * available manifest name paired with its clean display label, so the
 * dropdown never shows device suffixes (#753).
 */
export function deviceProfileEntries(deviceType: number | undefined): ProfileEntry[] {
  if (deviceType === undefined) return [];

  return profilesData.filter((p) => p.deviceType === deviceType).map((p) => ({ name: p.name, label: p.displayName }));
}

/**
 * Whether a persisted `_deviceProfiles` value already equals the entries we'd
 * push. Legacy plain-string entries (the pre-#753 shape) never compare equal,
 * so they are upgraded to the object shape on the next push.
 */
export function profileEntriesEqual(current: readonly unknown[], entries: readonly ProfileEntry[]): boolean {
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
