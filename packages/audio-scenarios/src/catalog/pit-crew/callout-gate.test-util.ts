import {
  calloutIdForKey,
  type CalloutIdOf,
  type CalloutSettingKey,
  type RegisteredCalloutFamily,
} from "@iracedeck/callout-settings";

/**
 * A `PitCrewDeps.isCalloutEnabled` double for tests written per family:
 * `familyGate(FUEL_CALLOUTS, (id) => id !== "laps-left-5")`. Keys of other
 * families read as on, as the old per-family defaults did.
 */
export function familyGate<F extends RegisteredCalloutFamily>(
  family: F,
  enabled: (id: CalloutIdOf<F>) => boolean,
): (key: CalloutSettingKey) => boolean {
  return (key) => {
    const id = calloutIdForKey(family, key);

    return id === undefined ? true : enabled(id);
  };
}
