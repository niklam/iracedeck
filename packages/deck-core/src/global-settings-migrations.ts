/**
 * Global-settings migrations: the one-shot key renames of issue #953, and the
 * idempotent qualification of the Race Engineer voice id of #1144.
 *
 * **Renames.** When a persisted global-settings key is renamed (e.g. the Setup
 * Chassis spring binding keys, `setupChassisLeftSpring*` →
 * `setupChassisLrSpring*`), existing users still have their value stored under
 * the old key. `migrateGlobalSettingsKeys` copies each stored old-key value to
 * its new key (unless the new key already holds a value — a newer write wins)
 * and deletes the old key, exactly once.
 *
 * Timing: before the settings store has loaded the cache is pure schema
 * defaults with no passthrough keys, so absence of an old key proves
 * nothing. The migration therefore runs only once the stored settings are in
 * (`isSettingsStoreReady`), subscribing to settings changes until then.
 * All writes go through `updateGlobalSettings`/`deleteGlobalSettings`, so they
 * land in the plugin-owned store like every other write (#993).
 *
 * PASSTHROUGH KEYS ONLY. Both the "old key stored?" and "new key already
 * set?" checks read the parsed cache, where a `GlobalSettingsSchema`-declared
 * field ALWAYS holds at least its schema default — so for a schema-backed
 * rename the old value would never be copied (the default at the new key
 * counts as "already set") while the old key would still be deleted. Renaming
 * a schema-backed field needs a bespoke migration that reads the raw host
 * payload instead.
 *
 * **The voice id.** `migrateRaceEngineerVoiceId` is the other shape: not a
 * one-shot, and with no marker to say it ran. A stored `raceEngineerVoice`
 * from before voice ids were namespaced by pack (#1144) is a bare id; the
 * rule that maps it to the composite it meant is `qualifyVoiceId`, and a
 * composite value is never rewritten — so running it again is free, and a
 * marker would only add a second thing that can be wrong. It re-runs after
 * every voice-pack scan and every settings arrival because the answer can
 * change: a fresh launch still downloading `default` has no pack to qualify
 * against yet, and the value must be left as it is (never replaced by a
 * fallback the user did not choose) until the scan that installs it.
 *
 * It persists NOTHING until the managed pack is among the available voices.
 * The rule is managed-first, so before `default` has arrived the alphabetical
 * half would decide alone — and a leftover sideload declaring a voice called
 * `default` (refused before 3.3.0, never deleted) at the first 3.3.0 scan
 * would then have `<sideload>::default` written down for good, a voice the
 * user never heard. Waiting costs nothing: the resolver applies the same rule
 * at read time, so the engineer speaks meanwhile, and the scan that installs
 * `default` re-runs this and persists the right answer.
 */
import { qualifyVoiceId, splitVoiceId } from "@iracedeck/callout-script";
import type { ILogger } from "@iracedeck/logger";

import {
  deleteGlobalSettings,
  getGlobalSettings,
  isSettingsStoreReady,
  onGlobalSettingsChange,
  updateGlobalSettings,
} from "./global-settings.js";
import { ENSURED_VOICE_PACK_ID } from "./voice-pack-constants.js";

/**
 * Migrate renamed global-settings keys, now or as soon as the first real
 * settings payload arrives.
 *
 * @param renames - Map of old key → new key
 * @param logger - Optional logger for migration reporting
 * @returns A disposer that cancels a still-pending migration (for tests)
 */
export function migrateGlobalSettingsKeys(renames: Record<string, string>, logger?: ILogger): () => void {
  const pending = new Map(Object.entries(renames));
  let unsubscribe: (() => void) | null = null;

  const run = (): void => {
    if (!isSettingsStoreReady() || pending.size === 0) return;

    const settings = getGlobalSettings() as unknown as Record<string, unknown>;
    const writes: Record<string, unknown> = {};
    const deletes: string[] = [];
    const migrated: string[] = [];

    for (const [oldKey, newKey] of [...pending]) {
      // Stored settings are here — this key is settled either way.
      pending.delete(oldKey);
      const oldValue = settings[oldKey];

      if (oldValue === undefined) continue;

      if (settings[newKey] === undefined) {
        writes[newKey] = oldValue;
      }

      deletes.push(oldKey);
      migrated.push(`${oldKey} -> ${newKey}`);
    }

    if (Object.keys(writes).length > 0) updateGlobalSettings(writes);

    if (deletes.length > 0) deleteGlobalSettings(deletes);

    if (migrated.length > 0) {
      logger?.info("Migrated renamed global settings keys");
      logger?.debug(`Migrated: ${migrated.join(", ")}`);
    }

    if (pending.size === 0 && unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  run();

  if (pending.size > 0) {
    unsubscribe = onGlobalSettingsChange(() => run());
  }

  return () => {
    unsubscribe?.();
    unsubscribe = null;
  };
}

/**
 * Persist the qualified form of a bare stored `raceEngineerVoice` (#1144):
 * `default::<id>` when the managed pack provides it, else the alphabetically
 * first pack that does — the read `resolveActiveRaceEngineerVoice` already
 * makes, written down. No-op (returns `false`) before the store is ready,
 * since the cache then holds the schema default rather than the user's value;
 * before the managed pack is among `availableVoices` (see the module comment
 * for the sideload it protects against); and whenever qualification changes
 * nothing: an empty value, a composite, or a bare id no available voice
 * provides yet. Idempotent — safe to call after every scan and every settings
 * arrival.
 *
 * @param availableVoices - The composite ids currently available (`_raceEngineerVoices`)
 * @returns whether a write was made
 */
export function migrateRaceEngineerVoiceId(availableVoices: readonly string[], logger?: ILogger): boolean {
  if (!isSettingsStoreReady()) return false;

  if (!availableVoices.some((id) => splitVoiceId(id)?.packId === ENSURED_VOICE_PACK_ID)) return false;

  const stored = getGlobalSettings().raceEngineerVoice ?? "";
  const qualified = qualifyVoiceId(stored, availableVoices, ENSURED_VOICE_PACK_ID);

  if (qualified === stored) return false;

  updateGlobalSettings({ raceEngineerVoice: qualified });
  logger?.info("Qualified the Race Engineer voice with its pack");
  logger?.debug(`${stored} -> ${qualified}`);

  return true;
}
