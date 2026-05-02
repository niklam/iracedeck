/**
 * One-shot in-place migration helper for the race-admin action's
 * `useViewedCar` boolean → `driverTarget` enum rename (issue #491).
 *
 * Detects raw settings with the legacy `useViewedCar` key but no `driverTarget`,
 * derives the new value (`true` → `"viewed-car"`, `false` → `"specific"`),
 * and **drops** the legacy key. Returns `{ migrated, changed }` so callers can
 * decide whether to persist via `ev.action.setSettings(migrated)`.
 *
 * Safe to call on any settings shape — non-object inputs return an empty
 * unchanged result. Idempotent: once `driverTarget` is present the helper
 * leaves the record alone (preserves a leftover `useViewedCar` key in that
 * case so we don't mutate already-migrated payloads).
 *
 * Mirrors the pattern of `migrateLegacyActionToMode` in `@iracedeck/deck-core`.
 */
export function migrateUseViewedCarToDriverTarget(raw: unknown): {
  migrated: Record<string, unknown>;
  changed: boolean;
} {
  if (!raw || typeof raw !== "object") return { migrated: {}, changed: false };

  const record = raw as Record<string, unknown>;

  if (record.driverTarget !== undefined || record.useViewedCar === undefined) {
    return { migrated: { ...record }, changed: false };
  }

  const { useViewedCar, ...rest } = record;
  const isViewed = useViewedCar === true || useViewedCar === "true";

  return {
    migrated: { ...rest, driverTarget: isViewed ? "viewed-car" : "specific" },
    changed: true,
  };
}
