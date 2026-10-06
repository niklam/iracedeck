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

export function calloutKey<F extends CalloutFamily>(family: F, id: CalloutIdOf<F>): CalloutKeyOf<F> {
  return family.callouts[id].key as CalloutKeyOf<F>;
}

export function calloutIdForKey<F extends CalloutFamily>(family: F, key: string): CalloutIdOf<F> | undefined {
  for (const [id, entry] of Object.entries(family.callouts)) {
    if (entry.key === key) return id as CalloutIdOf<F>;
  }

  return undefined;
}
