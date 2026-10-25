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

/**
 * Several constant keys. By default ALL are required for the mode (warn if any
 * is unset): setup view-* modes nudge-and-read via the adjustment's increase
 * AND decrease keys.
 *
 * With `require: "any"` the mode works with ANY one of them bound, so it warns
 * only when every key is unset (#1463). Car Control's Wipers and Visor uses
 * that: it sends the visor binding in an open-cockpit car and the wiper
 * bindings in a closed one, so a driver who only ever drives one kind of car
 * binds one side and must not be told the other is missing.
 */
export interface BindingKeyMulti {
  scope: "global" | "action";
  keys: string[];
  /** Omitted (or `"all"`): every key is required. `"any"`: one bound key is enough. */
  require?: "all" | "any";
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

export type BindingKeyRef = BindingKeyConstant | BindingKeyMulti | BindingKeyResolved;

/**
 * Communication descriptor for a single mode.
 *
 * A `keybind` method with NO `binding` means a fixed key with no user-facing
 * binding (e.g. car-control's hardcoded Escape, or audio modes that drive
 * plugin audio) — it never warns and reads as "no binding needed".
 */
export interface CommDescriptor {
  method: CommMethod;
  /** Present for configurable keybind modes; omitted for fixed/no-binding ones. */
  binding?: BindingKeyRef;
}

/** One action's modes → descriptor, keyed by the primary mode setting value. */
export type ActionCommMap = Record<string, CommDescriptor>;

/** Whole catalog, keyed by action folder name. */
export type CommsCatalog = Record<string, ActionCommMap>;

/** Type guard: a single constant-key binding reference. */
export function isConstantBindingKey(ref: BindingKeyRef): ref is BindingKeyConstant {
  return "key" in ref;
}

/** Type guard: a multi-key binding reference (all-required, or any-of with `require: "any"`). */
export function isMultiBindingKey(ref: BindingKeyRef): ref is BindingKeyMulti {
  return "keys" in ref;
}

/** Whether a binding reference is satisfied by ANY one of its keys being bound (#1463). */
export function isAnyOfBindingKey(ref: BindingKeyRef): ref is BindingKeyMulti & { require: "any" } {
  return isMultiBindingKey(ref) && ref.require === "any";
}

/**
 * Resolve a binding key reference to ALL concrete setting keys it names,
 * given the action's current settings (needed for `keyBy` references). A
 * `keyBy` reference whose secondary value isn't mapped resolves to an empty
 * array. For an any-of multi-key reference (`require: "any"`) these are the
 * candidates, of which one bound key is enough — check {@link isAnyOfBindingKey}.
 */
export function resolveBindingKeys(ref: BindingKeyRef | undefined, settings: Record<string, unknown>): string[] {
  if (!ref) return [];

  if (isConstantBindingKey(ref)) return [ref.key];

  if (isMultiBindingKey(ref)) return ref.keys;

  const secondary = settings[ref.keyBy.setting];
  const key = typeof secondary === "string" ? ref.keyBy.map[secondary] : undefined;

  return key ? [key] : [];
}

/**
 * Resolve a binding key reference to a single concrete key (the first required
 * key). Convenience for single-key consumers; multi-key modes should use
 * {@link resolveBindingKeys}.
 */
export function resolveBindingKey(
  ref: BindingKeyRef | undefined,
  settings: Record<string, unknown>,
): string | undefined {
  return resolveBindingKeys(ref, settings)[0];
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

/** Build a keybind descriptor requiring several constant keys (all required). */
export function keybindKeys(keys: string[], scope: "global" | "action" = "global"): CommDescriptor {
  return { method: "keybind", binding: { scope, keys } };
}

/**
 * Build a keybind descriptor naming several constant keys of which ANY ONE
 * bound is enough: it warns only when every key is unset (#1463).
 */
export function keybindAnyKeys(keys: string[], scope: "global" | "action" = "global"): CommDescriptor {
  return { method: "keybind", binding: { scope, keys, require: "any" } };
}

/**
 * Build a keybind descriptor with no user-facing binding (a fixed key such as
 * Escape, or a mode that drives plugin audio). Reads as "no binding needed"
 * and never warns.
 */
export function keybindFixed(): CommDescriptor {
  return { method: "keybind" };
}
