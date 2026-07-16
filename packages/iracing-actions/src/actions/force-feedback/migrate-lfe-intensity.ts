import { deleteGlobalSettings, getGlobalSettings, parseBinding, updateGlobalSettings } from "@iracedeck/deck-core";

/**
 * One-shot migrations for the retired LFE "intensity" modes (issue #848).
 *
 * iRacing has a single pair of controls per LFE device — the In Car controls
 * list labels them "Wheel LFE Louder/Quieter" and "BassShaker LFE
 * Louder/Quieter", while the Options pages label the very same bindings
 * "More Intense / Less Intense" under "Wheel LFE Controls" and "Haptic LFE
 * Controls". The Force Feedback action used to model the two labelings as
 * four distinct modes with four distinct global binding keys; the intensity
 * pair is retired in favor of the louder/quieter pair.
 */

/** Retired mode value → canonical mode value. */
const RETIRED_MODE_MAP: Record<string, string> = {
  "wheel-lfe-intensity": "wheel-lfe",
  "haptic-lfe-intensity": "bass-shaker-lfe",
};

/** Retired global binding key → canonical global binding key. */
const RETIRED_BINDING_KEY_MAP: Record<string, string> = {
  forceFeedbackWheelLfeIntensityIncrease: "forceFeedbackWheelLfeLouder",
  forceFeedbackWheelLfeIntensityDecrease: "forceFeedbackWheelLfeQuieter",
  forceFeedbackHapticLfeIntensityIncrease: "forceFeedbackBassShakerLfeLouder",
  forceFeedbackHapticLfeIntensityDecrease: "forceFeedbackBassShakerLfeQuieter",
};

/**
 * Map a persisted retired mode (`wheel-lfe-intensity` / `haptic-lfe-intensity`)
 * to its canonical mode — both the keypad `mode` and the dial surface's
 * `dial.setting` (#802). Without this, an unknown enum value fails the settings
 * parse and the key silently falls back to all defaults (wrong icon + wrong
 * behavior; on a dial, `DialSettings.catch` would also discard the user's dial
 * appearance overrides). Returns `{ migrated, changed }` so callers can persist
 * via `ev.action.setSettings(migrated)` — mirrors
 * `migrateUseViewedCarToDriverTarget` (race-admin, #491). Safe on non-object
 * inputs.
 */
export function migrateLfeIntensityModes(raw: unknown): {
  migrated: Record<string, unknown>;
  changed: boolean;
} {
  if (!raw || typeof raw !== "object") return { migrated: {}, changed: false };

  const record = raw as Record<string, unknown>;
  let migrated: Record<string, unknown> = { ...record };
  let changed = false;

  const modeReplacement = typeof record.mode === "string" ? RETIRED_MODE_MAP[record.mode] : undefined;

  if (modeReplacement !== undefined) {
    migrated = { ...migrated, mode: modeReplacement };
    changed = true;
  }

  const dial = record.dial;

  if (dial && typeof dial === "object" && !Array.isArray(dial)) {
    const dialRecord = dial as Record<string, unknown>;
    const dialReplacement = typeof dialRecord.setting === "string" ? RETIRED_MODE_MAP[dialRecord.setting] : undefined;

    if (dialReplacement !== undefined) {
      migrated = { ...migrated, dial: { ...dialRecord, setting: dialReplacement } };
      changed = true;
    }
  }

  return { migrated, changed };
}

/**
 * Carry bindings stored under the retired intensity keys over to their
 * canonical louder/quieter keys, then drop the retired keys from persisted
 * storage. A canonical key that already holds a parseable binding is never
 * overwritten. Idempotent — once the retired keys are gone, subsequent
 * startups are a no-op. Call from each plugin's first-settings-arrival
 * one-shot block (the same spot as the #515/#657 key cleanups).
 */
export function migrateLfeIntensityBindingKeys(): void {
  const settings = getGlobalSettings() as Record<string, unknown>;
  const carryOver: Record<string, unknown> = {};
  const retiredPresent: string[] = [];

  for (const [retired, canonical] of Object.entries(RETIRED_BINDING_KEY_MAP)) {
    if (!(retired in settings)) continue;

    retiredPresent.push(retired);

    if (parseBinding(settings[retired]) !== undefined && parseBinding(settings[canonical]) === undefined) {
      carryOver[canonical] = settings[retired];
    }
  }

  if (Object.keys(carryOver).length > 0) updateGlobalSettings(carryOver);

  if (retiredPresent.length > 0) deleteGlobalSettings(retiredPresent);
}
