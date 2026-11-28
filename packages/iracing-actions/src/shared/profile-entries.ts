/**
 * The bundled-profile reader and the shared `_deviceProfiles` entry helpers.
 *
 * Three actions push a device-filtered bundled-profile list to their PI
 * dropdowns (Switch Profile, Race Admin's select-car, Camera Controls'
 * focus-select-car) and resolve a stored profile name against the same list at
 * press time. All three write the list through one updater,
 * {@link deviceProfilesUpdate}, which `BaseAction.updateSettings` runs against
 * the context's newest settings rather than the event's snapshot (#1761). All
 * of it lives here so it can't drift between the actions (#790 review, #1375):
 * this module is the one reader of the generated `profiles.json`, which the
 * Stream Deck plugin's automatic session-kind switcher (#1111) also reaches
 * through the package's `availableProfilesForDevice` export.
 */
import type { ContextSettingsUpdater } from "@iracedeck/deck-core";

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

/**
 * The settings write that pushes a device's profile list into a context's
 * `_deviceProfiles` (#1761), for `BaseAction.updateSettings`.
 *
 * It reads the settings it is handed — the context's newest record, never the
 * event's payload — so a write never reverts a change that arrived after the
 * event, and `applies` decides from those same settings whether the key's Mode
 * still shows the profile dropdown: a key the user has since moved to another
 * Mode gets no write. It returns `undefined` (nothing to write) when the Mode
 * does not apply or the record already holds these entries, and otherwise the
 * record with the entries in place.
 *
 * It is pure, as every updater must be: `updateSettings` may park it behind a
 * newer settings event and run it again on those settings. Whether the host
 * echoes the write back as a `didReceiveSettings` differs between hosts, and
 * nothing depends on it: on an echo the entries are already present, so the
 * updater returns `undefined` and the exchange stops there.
 *
 * @param deviceType - The device whose bundled profiles are listed.
 * @param applies - Whether the context's Mode shows the profile dropdown,
 *   judged from the settings the updater runs on.
 */
export function deviceProfilesUpdate(
  deviceType: number | undefined,
  applies: (current: Readonly<Record<string, unknown>>) => boolean,
): ContextSettingsUpdater {
  const entries = deviceProfileEntries(deviceType);

  return (current) => {
    if (!applies(current)) return undefined;

    const stored = Array.isArray(current._deviceProfiles) ? (current._deviceProfiles as unknown[]) : [];

    if (profileEntriesEqual(stored, entries)) return undefined;

    return { ...current, _deviceProfiles: entries };
  };
}
