/**
 * One-shot in-place migration of the Audio Controls dial's legacy spotter
 * press (#1015). 3.0–3.3 offered **Mute / Unmute** for the Spotter Mode and
 * tapped iRacing's Spotter Silence binding — which skips the call currently
 * playing rather than muting anything. That press is now the separate
 * `skip-call` value and `spotter` has no Mute / Unmute binding, so a stored
 * `{ category: "spotter", pressAction: "mute-unmute" }` is rewritten to
 * `pressAction: "skip-call"`. Without it the dial would lose its press: the
 * dispatcher finds no spotter mute binding, and the PI's "a press the current
 * Mode cannot fire falls back to None" rule would overwrite the choice.
 *
 * Only that one pair is touched; every other key — including unknown ones —
 * is returned as it was. Returns `{ migrated, changed }` so callers can decide
 * whether to persist via `ev.action.setSettings(migrated)`. Safe on
 * non-object inputs.
 *
 * Mirrors `camera-controls/migrate-focus-on-exiting.ts`.
 */
export function migrateSpotterMuteToSkipCall(raw: unknown): {
  migrated: Record<string, unknown>;
  changed: boolean;
} {
  if (!raw || typeof raw !== "object") return { migrated: {}, changed: false };

  const record = raw as Record<string, unknown>;
  const dial = record.dial;

  if (dial && typeof dial === "object") {
    const dialRecord = dial as Record<string, unknown>;

    if (dialRecord.category === "spotter" && dialRecord.pressAction === "mute-unmute") {
      return { migrated: { ...record, dial: { ...dialRecord, pressAction: "skip-call" } }, changed: true };
    }
  }

  return { migrated: { ...record }, changed: false };
}
