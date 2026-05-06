/**
 * One-shot in-place migration helper for the camera-controls action's legacy
 * `target: "focus-on-exiting"` value. The mode was renamed to
 * `target: "focus-on-most-exciting"` in #510 to correct the typo inherited
 * from the iRacing SDK's `csFocusAtExiting` enum (the underlying behavior is
 * iRacing's "Most Exciting" director focus, not pit-lane related).
 *
 * Returns `{ migrated, changed }` so callers can decide whether to persist
 * via `ev.action.setSettings(migrated)`. Safe on non-object inputs.
 *
 * Mirrors the pattern of `migrateRespondPmToReply`.
 */
export function migrateFocusOnExitingToMostExciting(raw: unknown): {
  migrated: Record<string, unknown>;
  changed: boolean;
} {
  if (!raw || typeof raw !== "object") return { migrated: {}, changed: false };

  const record = raw as Record<string, unknown>;

  if (record.target === "focus-on-exiting") {
    return { migrated: { ...record, target: "focus-on-most-exciting" }, changed: true };
  }

  return { migrated: { ...record }, changed: false };
}
