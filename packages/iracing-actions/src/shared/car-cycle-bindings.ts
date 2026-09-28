/**
 * iRacing's Next Car / Previous Car key bindings, shared across actions (issue
 * #1277).
 *
 * iRacing has one Next Car control (default `V`) and one Previous Car control
 * (default `Shift+V`): Next Car focuses the car ahead ON TRACK, Previous Car
 * the car behind. Two actions tap them — Replay Control's Next Car / Previous
 * Car modes, and Camera Controls' Cycle by Track Order on the keypad (CAR
 * AHEAD / CAR BEHIND) and the dial. Letting the sim pick the car is what keeps
 * both right inside a replay, where the live field we could read is not the
 * field the driver is watching.
 *
 * One sim control, one setting: both actions read the SAME two global keys, so
 * the user says which key Next Car is on in one place and the two actions
 * cannot drift apart. The key names keep their original `replayControl`
 * prefix because they are persisted user settings. This module is the single
 * home for them and is dependency-free on purpose, so neither action imports
 * the other (the `spotter-bindings.ts` / `sub-camera-bindings.ts` pattern).
 * The user-facing defaults live in `actions/data/key-bindings.json`, listed
 * under both `replayControl` and `cameraControls` with the same `setting`
 * (tests cross-check both sections against these keys).
 */
import keyBindings from "../actions/data/key-bindings.json" with { type: "json" };

export const CAR_CYCLE_BINDING_KEYS = {
  next: "replayControlNextCar",
  previous: "replayControlPrevCar",
} as const;

/** Both keys, in the order the PIs list them — for "either is unset" checks. */
export const CAR_CYCLE_BINDING_KEY_LIST: readonly string[] = [
  CAR_CYCLE_BINDING_KEYS.next,
  CAR_CYCLE_BINDING_KEYS.previous,
];

/** The binding a cycle direction taps: `next` → Next Car (the car ahead), `previous` → Previous Car. */
export function carCycleBindingKey(direction: "next" | "previous"): string {
  return CAR_CYCLE_BINDING_KEYS[direction];
}

/**
 * Each key's default binding string, read from the `replayControl` section of
 * `key-bindings.json` (`V` / `Shift+V`) rather than restated here. Every plugin
 * hands it to deck-core's `seedBindingDefaultsIfAbsent` at startup: before
 * #1277 Cycle by Track Order needed no binding, so an existing user who never
 * opened a Replay Control Next / Previous Car panel has neither key stored,
 * and their CAR AHEAD / CAR BEHIND keys would otherwise show the #612 warning
 * and do nothing.
 */
export const CAR_CYCLE_BINDING_DEFAULTS: Readonly<Record<string, string>> = Object.fromEntries(
  keyBindings.replayControl
    .filter((row) => CAR_CYCLE_BINDING_KEY_LIST.includes(row.setting))
    .map((row) => [row.setting, row.default]),
);
