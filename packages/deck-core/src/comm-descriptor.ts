/**
 * Per-mode sim-communication descriptors (issue #612).
 *
 * Every action mode talks to iRacing through exactly one of three mechanisms:
 * the iRacing API/SDK, a simulated key binding (keyboard OR SimHub role), or a
 * chat/text command. These descriptors formalize that per-`(action, mode)` so
 * the Property Inspector status line, the key-icon warning overlay, and the
 * docs can all read one source of truth.
 *
 * The descriptor is keyed by the value of an action's PRIMARY mode setting.
 * Some keybind modes resolve their binding key from a SECONDARY setting (e.g.
 * view-adjustment's `direction`, black-box's selected box) — `keyBy` expresses
 * that declaratively so the resolution survives serialization to JSON for the
 * browser PI and docs generation.
 */

/** How a mode communicates with iRacing. */
export type CommMethod = "api" | "keybind" | "chat";

/** A binding key that is constant for the mode. */
export interface BindingKeyConstant {
  scope: "global" | "action";
  key: string;
}

/** A binding key resolved from a secondary setting's current value. */
export interface BindingKeyResolved {
  scope: "global" | "action";
  keyBy: {
    /** Name of the secondary setting whose value selects the key. */
    setting: string;
    /** Map from secondary-setting value → binding setting key. */
    map: Record<string, string>;
  };
}

export type BindingKeyRef = BindingKeyConstant | BindingKeyResolved;

/** Communication descriptor for a single mode. */
export interface CommDescriptor {
  method: CommMethod;
  /** Present only when `method === "keybind"`. */
  binding?: BindingKeyRef;
}

/** One action's modes → descriptor, keyed by the primary mode setting value. */
export type ActionCommMap = Record<string, CommDescriptor>;

/** Whole catalog, keyed by action folder name. */
export type CommsCatalog = Record<string, ActionCommMap>;

/** Type guard: a constant (non-`keyBy`) binding key reference. */
export function isConstantBindingKey(ref: BindingKeyRef): ref is BindingKeyConstant {
  return "key" in ref;
}

/**
 * Resolve a binding key reference to its concrete setting key, given the
 * action's current settings (needed for `keyBy` references). Returns undefined
 * when a `keyBy` secondary value isn't present in the map.
 */
export function resolveBindingKey(
  ref: BindingKeyRef | undefined,
  settings: Record<string, unknown>,
): string | undefined {
  if (!ref) return undefined;

  if (isConstantBindingKey(ref)) return ref.key;

  const secondary = settings[ref.keyBy.setting];

  return typeof secondary === "string" ? ref.keyBy.map[secondary] : undefined;
}

/**
 * Build a keybind descriptor whose key is resolved from a secondary setting.
 * Convenience for deriving descriptors from an action's existing
 * `Record<primary, Record<secondary, key>>` global-key map without restating
 * the key strings (keeps the action's map the single source of those keys).
 */
export function keybindBy(
  setting: string,
  map: Record<string, string>,
  scope: "global" | "action" = "global",
): CommDescriptor {
  return { method: "keybind", binding: { scope, keyBy: { setting, map } } };
}

/** Build a keybind descriptor with a constant key. */
export function keybind(key: string, scope: "global" | "action" = "global"): CommDescriptor {
  return { method: "keybind", binding: { scope, key } };
}
