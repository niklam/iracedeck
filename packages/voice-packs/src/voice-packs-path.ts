import { homedir } from "node:os";
import { join } from "node:path";

export interface ResolveVoicePacksPathOptions {
  env: Record<string, string | undefined>;
}

/**
 * `%LOCALAPPDATA%\iRaceDeck\Race Engineer\Voices`, or the full path in
 * `IRACEDECK_VOICE_PACKS_PATH` (development / fresh-install testing).
 *
 * Deliberately NOT per-ecosystem, unlike {@link resolveSettingsStorePath}: a
 * voice pack is content, not user state, so a user running two plugins holds
 * and downloads one copy rather than two.
 *
 * The blank-variable guard and the `homedir()` last resort mirror the settings
 * store's resolver exactly, so the two paths behave identically when the
 * environment is odd — `join("", "iRaceDeck", …)` would otherwise be a RELATIVE
 * path resolved against the deck host's working directory.
 */
export function resolveVoicePacksPath({ env }: ResolveVoicePacksPathOptions): string {
  const override = nonBlank(env.IRACEDECK_VOICE_PACKS_PATH);

  if (override !== undefined) return override;

  const base = nonBlank(env.LOCALAPPDATA) ?? join(nonBlank(env.USERPROFILE) ?? homedir(), "AppData", "Local");

  return join(base, "iRaceDeck", "Race Engineer", "Voices");
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}
