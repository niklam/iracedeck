/**
 * One-shot in-place migration helper for the race-admin action's
 * `useViewedCar` boolean → `driverTarget` enum rename (issue #491).
 *
 * Three cases:
 *
 * 1. **Already migrated** (`driverTarget` present): no-op.
 * 2. **Explicit legacy** (`useViewedCar` present): map `true` → `"viewed-car"`,
 *    `false` → `"specific"`, then drop the legacy key.
 * 3. **Implicit legacy** (`useViewedCar` absent but `addedWithVersion` present):
 *    the button was previously loaded under a build whose default was
 *    "Use Viewed Car". Stream Deck only persists settings the user has touched
 *    or that the action has explicitly written, so an unchanged v1.15 button's
 *    saved bytes contain no `useViewedCar` even though the user's intent was
 *    viewed-car. Backfill `driverTarget: "viewed-car"` so the new
 *    `"type-in-chat"` default doesn't silently override their prior behavior.
 *
 * Truly fresh buttons (no `addedWithVersion`, no `useViewedCar`) fall through
 * unchanged so Zod's `"type-in-chat"` default applies.
 *
 * Returns `{ migrated, changed }` so callers can decide whether to persist via
 * `ev.action.setSettings(migrated)`. Safe on non-object inputs.
 *
 * Mirrors the pattern of `migrateLegacyActionToMode` in `@iracedeck/deck-core`.
 */
export function migrateUseViewedCarToDriverTarget(raw: unknown): {
  migrated: Record<string, unknown>;
  changed: boolean;
} {
  if (!raw || typeof raw !== "object") return { migrated: {}, changed: false };

  const record = raw as Record<string, unknown>;

  // Case 1: already migrated — preserve as-is (a leftover `useViewedCar`, if any,
  // is left alone since the persist-on-appear flow will rewrite this record on
  // the next legacy-touching event).
  if (record.driverTarget !== undefined) {
    return { migrated: { ...record }, changed: false };
  }

  // Case 2: explicit legacy boolean — map and drop the legacy key.
  if (record.useViewedCar !== undefined) {
    const { useViewedCar, ...rest } = record;
    const isViewed = useViewedCar === true || useViewedCar === "true";

    return {
      migrated: { ...rest, driverTarget: isViewed ? "viewed-car" : "specific" },
      changed: true,
    };
  }

  // Case 3: implicit legacy — pre-existing button (addedWithVersion present)
  // that never wrote useViewedCar. Backfill viewed-car to preserve prior intent.
  if (record.addedWithVersion !== undefined) {
    return {
      migrated: { ...record, driverTarget: "viewed-car" },
      changed: true,
    };
  }

  // Fresh button — let Zod's default apply.
  return { migrated: { ...record }, changed: false };
}
