/**
 * The one persist path for a dial gesture that writes settings plugin-side
 * (Setup Chassis `toggle-spring-side`, #953; Fuel Service `switch-mode`, #957).
 * The model it belongs to is rule 10 in `.claude/rules/encoders-and-touchscreen.md`.
 */

/** A settings object as a deck host delivers it: a plain, non-array object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Persists `dialPatch` over the `dial` half of the event's RAW settings, so the
 * keypad half and every key the user never set stay exactly as stored — the
 * parsed settings would bank today's schema defaults into them.
 *
 * A payload that is missing, not an object, or EMPTY writes nothing and warns:
 * merging over `{}` would replace the whole stored object with just the dial
 * patch. An empty object counts as missing because a host that backfills
 * settings from its own cache hands `{}` to a context it has no entry for,
 * while the store behind it may hold a full object.
 *
 * Callers update their in-memory state BEFORE awaiting this, so a second
 * gesture arriving while the write is in flight flips from the new state.
 *
 * @returns whether a write was sent.
 */
export async function persistDialPatch(
  action: { setSettings(settings: Record<string, unknown>): Promise<void> },
  rawSettings: unknown,
  dialPatch: Record<string, unknown>,
  logger: { warn(message: string): void },
  what: string,
): Promise<boolean> {
  const raw = asRecord(rawSettings);

  if (!raw || Object.keys(raw).length === 0) {
    logger.warn(`Dial event carried no settings; ${what} not persisted`);

    return false;
  }

  await action.setSettings({ ...raw, dial: { ...(asRecord(raw.dial) ?? {}), ...dialPatch } });

  return true;
}
