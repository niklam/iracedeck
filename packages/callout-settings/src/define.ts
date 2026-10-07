/** A `GlobalSettingsSchema` key that stores one Race Engineer callout's opt-in. */
export type CalloutSettingKeyString = `calloutEnabled${string}`;

export interface CalloutEntry {
  /** The persisted settings key. A published contract: never rename without a migration. */
  readonly key: CalloutSettingKeyString;
  /** The checkbox label in the PI and the settings window. */
  readonly label: string;
  /**
   * Present only to ship a callout OFF. Absent means on — new Race Engineer
   * functionality defaults on, so an off default is the visible exception.
   */
  readonly default?: false;
}

export interface CalloutFamily {
  /** Kebab-case, unique across the registry. */
  readonly id: string;
  /** Callout id (as `audio-scenarios` names it) → its opt-in. */
  readonly callouts: { readonly [id: string]: CalloutEntry };
}

/** Identity at runtime; keeps the ids and keys as literal types. */
export function defineCalloutFamily<const F extends CalloutFamily>(family: F): F {
  return family;
}

export type CalloutIdOf<F extends CalloutFamily> = keyof F["callouts"] & string;

/** Distributes over a union of families, so it also names every key of a list. */
export type CalloutKeyOf<F> = F extends CalloutFamily ? F["callouts"][keyof F["callouts"]]["key"] : never;

/**
 * The key of one callout in a family, typed as exactly that key. Throws a named
 * error on an id the family does not have — which the types rule out, so it
 * means an id reached here unchecked (a cast, or data read at runtime).
 */
export function calloutKey<F extends CalloutFamily, Id extends CalloutIdOf<F>>(
  family: F,
  id: Id,
): F["callouts"][Id]["key"] & CalloutKeyOf<F> {
  const entry = family.callouts[id];

  if (!entry) throw new Error(`Unknown callout id "${id}" in family "${family.id}"`);

  // The intersection is the same key; it also states the key is one of F's, which a generic caller over the
  // registry needs to see it as a CalloutSettingKey (an indexed access on a generic F does not resolve).
  return entry.key as F["callouts"][Id]["key"] & CalloutKeyOf<F>;
}

export function calloutIdForKey<F extends CalloutFamily>(family: F, key: string): CalloutIdOf<F> | undefined {
  for (const [id, entry] of Object.entries(family.callouts)) {
    if (entry.key === key) return id as CalloutIdOf<F>;
  }

  return undefined;
}
