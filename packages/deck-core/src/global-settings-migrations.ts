/**
 * One-shot global-settings key migrations (issue #953).
 *
 * When a persisted global-settings key is renamed (e.g. the Setup Chassis
 * spring binding keys, `setupChassisLeftSpring*` → `setupChassisLrSpring*`),
 * existing users still have their value stored under the old key. This helper
 * copies each stored old-key value to its new key (unless the new key already
 * holds a value — a newer write wins) and deletes the old key, exactly once.
 *
 * Timing: before the host's first real settings payload the cache is pure
 * schema defaults with no passthrough keys, so absence of an old key proves
 * nothing. The migration therefore runs only once real settings have arrived
 * (`hasReceivedHostSettings`), subscribing to settings changes until then.
 * All writes go through `updateGlobalSettings`/`deleteGlobalSettings`, so the
 * #896 stale-cache protections (pending-write overlay, shrink guard) apply.
 *
 * PASSTHROUGH KEYS ONLY. Both the "old key stored?" and "new key already
 * set?" checks read the parsed cache, where a `GlobalSettingsSchema`-declared
 * field ALWAYS holds at least its schema default — so for a schema-backed
 * rename the old value would never be copied (the default at the new key
 * counts as "already set") while the old key would still be deleted. Renaming
 * a schema-backed field needs a bespoke migration that reads the raw host
 * payload instead.
 */
import type { ILogger } from "@iracedeck/logger";

import {
  deleteGlobalSettings,
  getGlobalSettings,
  hasReceivedHostSettings,
  onGlobalSettingsChange,
  updateGlobalSettings,
} from "./global-settings.js";

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
    if (!hasReceivedHostSettings() || pending.size === 0) return;

    const settings = getGlobalSettings() as unknown as Record<string, unknown>;
    const writes: Record<string, unknown> = {};
    const deletes: string[] = [];
    const migrated: string[] = [];

    for (const [oldKey, newKey] of [...pending]) {
      // Real settings are here — this key is settled either way.
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
