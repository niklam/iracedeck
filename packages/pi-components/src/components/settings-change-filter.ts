/**
 * Deliver a settings callback only when its value actually changed (#1100).
 *
 * sdpi's `useGlobalSettings` and `useSettings` are NOT keyed. Their shared
 * `use()` subscribes to the raw `didReceiveGlobalSettings` / `didReceiveSettings`
 * event and re-invokes EVERY registered callback with its key's current value on
 * EVERY push, with no comparison against what it delivered last time. That is
 * verifiable in the vendored `browser/sdpi-components.js`; it is not inferred
 * from behaviour.
 *
 * That cost nothing observable while pushes were rare. #1100 publishes install
 * progress about once a second for the duration of a voice download, and with
 * 236 `ird-key-binding` instances on the settings window — each of which parses
 * its value and rewrites an icon's `innerHTML` — the whole window was redoing
 * its work every second because one unrelated key had moved.
 *
 * Wrapping a callback here fixes that for the consumer and for every future
 * one, which is why this is a shared filter rather than a guard inside the one
 * component that noticed.
 *
 * WHY SKIPPING A REPEAT IS SAFE. These callbacks are all state-driven: each
 * takes the value it is handed and makes the DOM reflect it. Handed the same
 * value twice, the second call can only reproduce what the first already did.
 * A consumer that genuinely needed to act on every push — a counter, a
 * heartbeat — would be broken by this, and there is none; if one is ever
 * written, it must not use this filter, and that is a design decision to argue
 * rather than a flag to add.
 *
 * THE FIRST DELIVERY IS NEVER SKIPPED. One consumer depends on it:
 * `ird-key-binding` settles a `default` attribute into the stored setting the
 * first time it is told the setting is empty. The initial value is compared
 * against a sentinel that no setting value can equal, rather than against `""`
 * or `undefined` — both of which ARE real values sdpi delivers, and either of
 * which would have swallowed that first call.
 */

/** Distinguishable from every string sdpi can deliver, including "" and "undefined". */
const NOTHING_DELIVERED = Symbol("nothing delivered");

/**
 * Wrap `callback` so a repeat of the value it last received is dropped.
 *
 * The memo lives in this closure, so it is per SUBSCRIPTION rather than per
 * key: two components watching one key each get their own first delivery, which
 * is what they need — one of them having already rendered says nothing about
 * whether the other has.
 */
export function skipUnchanged(callback: (value: string) => void): (value: string) => void {
  let last: string | typeof NOTHING_DELIVERED = NOTHING_DELIVERED;

  return (value: string) => {
    if (last !== NOTHING_DELIVERED && value === last) return;

    last = value;
    callback(value);
  };
}
