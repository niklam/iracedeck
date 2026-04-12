/**
 * One-shot in-place migration helper for actions that renamed their primary
 * settings field from `action` to `mode` (issue #324).
 *
 * Detects raw settings with the legacy `action` key but no `mode`, copies the
 * value across, and drops the old key. Returns the (possibly migrated) raw
 * settings object alongside a `changed` flag so callers can decide whether to
 * persist via `setSettings`.
 *
 * Used by media-capture, pit-quick-actions, telemetry-control, and tire-service.
 * Safe to call on any settings shape — non-object inputs return an empty
 * unchanged result.
 */
export function migrateLegacyActionToMode(raw: unknown): {
  migrated: Record<string, unknown>;
  changed: boolean;
} {
  if (!raw || typeof raw !== "object") return { migrated: {}, changed: false };

  const record = raw as Record<string, unknown>;

  if (record.mode !== undefined || record.action === undefined) {
    return { migrated: { ...record }, changed: false };
  }

  const { action, ...rest } = record;

  return { migrated: { ...rest, mode: action }, changed: true };
}
