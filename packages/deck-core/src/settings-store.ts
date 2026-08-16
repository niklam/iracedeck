/**
 * Plugin-owned global-settings store (issue #993).
 *
 * The plugin — not the deck host — owns plugin-global settings, in one JSON
 * file per ecosystem under the user's local app data. The host store is
 * read once (migration) and otherwise unused; see the design doc
 * docs/superpowers/specs/2026-08-16-issue-993-plugin-owned-settings-store-design.md.
 */
import { join } from "node:path";

const FOLDER_NAMES: Record<string, string> = {
  "stream-deck": "Stream Deck",
  mirabox: "Mirabox",
  ulanzi: "Ulanzi",
};

/** Human-readable per-ecosystem folder; unknown ids pass through so ecosystems never share a file. */
export function settingsStoreFolderName(platform: string): string {
  return FOLDER_NAMES[platform] ?? platform;
}

export interface ResolveSettingsStorePathOptions {
  /** `getPluginPlatform()` — "stream-deck" | "mirabox" | "ulanzi". */
  platform: string;
  env: Record<string, string | undefined>;
}

/**
 * `%LOCALAPPDATA%\iRaceDeck\Settings\<ecosystem>\global-settings.json`, or the
 * full path in `IRACEDECK_SETTINGS_PATH` (development / fresh-install testing).
 */
export function resolveSettingsStorePath({ platform, env }: ResolveSettingsStorePathOptions): string {
  const override = env.IRACEDECK_SETTINGS_PATH;

  if (override && override.trim().length > 0) return override;

  const base = env.LOCALAPPDATA ?? join(env.USERPROFILE ?? ".", "AppData", "Local");

  return join(base, "iRaceDeck", "Settings", settingsStoreFolderName(platform), "global-settings.json");
}
