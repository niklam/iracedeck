/**
 * Shared `_deviceProfiles` entry helpers.
 *
 * Three actions push a device-filtered bundled-profile list to their PI
 * dropdowns (Switch Profile, Race Admin's select-car, Camera Controls'
 * focus-select-car) and guard the write with the same change comparison so
 * the setSettings→onDidReceiveSettings echo loop terminates. The comparison
 * lives here so the guard can't drift between the actions (#790 review).
 */

/** A `_deviceProfiles` entry: manifest name + clean display label (#753). */
export interface ProfileEntry {
  name: string;
  label: string;
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
