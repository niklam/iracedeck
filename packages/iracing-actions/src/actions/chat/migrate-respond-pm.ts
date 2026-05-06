/**
 * One-shot in-place migration helper for the chat action's legacy
 * `mode: "respond-pm"` value, which was a duplicate alias of `mode: "reply"`
 * (both call `chat.reply()`). The dropdown option was removed in #505;
 * this migration rewrites any persisted `respond-pm` value to `reply` so the
 * Property Inspector dropdown stays in sync with the saved setting and the
 * Zod schema no longer has to carry the legacy enum value.
 *
 * Returns `{ migrated, changed }` so callers can decide whether to persist
 * via `ev.action.setSettings(migrated)`. Safe on non-object inputs.
 *
 * Mirrors the pattern of `migrateUseViewedCarToDriverTarget`.
 */
export function migrateRespondPmToReply(raw: unknown): {
  migrated: Record<string, unknown>;
  changed: boolean;
} {
  if (!raw || typeof raw !== "object") return { migrated: {}, changed: false };

  const record = raw as Record<string, unknown>;

  if (record.mode === "respond-pm") {
    return { migrated: { ...record, mode: "reply" }, changed: true };
  }

  return { migrated: { ...record }, changed: false };
}
