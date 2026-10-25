/**
 * The three global bindings Car Control's Wipers and Visor mode sends (#1463),
 * dependency-free so `comms-catalog.ts` (which the comms generator runs under
 * tsx, with no SVG loader) can name them without importing the mode's icons.
 *
 * The wiper bindings keep their Cockpit Misc setting names, so binding them in
 * either action binds both; `key-bindings.json` lists them under both
 * `cockpitMisc` and `carControl`.
 */
export const WIPERS_AND_VISOR_BINDINGS = {
  visor: "carControlTearOffVisor",
  trigger: "cockpitMiscTriggerWipers",
  toggle: "cockpitMiscToggleWipers",
} as const;

/** Every binding the mode can send, in the order the PI lists them. */
export const WIPERS_AND_VISOR_BINDING_KEYS: readonly string[] = [
  WIPERS_AND_VISOR_BINDINGS.visor,
  WIPERS_AND_VISOR_BINDINGS.trigger,
  WIPERS_AND_VISOR_BINDINGS.toggle,
];
