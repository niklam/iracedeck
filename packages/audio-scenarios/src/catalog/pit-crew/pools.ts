/**
 * Pool registry for the pit-crew scenario catalog (issue #664).
 *
 * Pools are config-driven: a pool is *all clips sharing a base name*
 * (`voice/<voice>/<group>/<base>-NN.mp3`), derived per-voice from the
 * runtime audio-asset manifest. `POOL_REGISTRY` maps each logical pool name
 * to its `(group, base)` source — it carries **no clip lists and no
 * counts**. Adding or removing a variant (or an entire voice) is a
 * clip-file change in `@iracedeck/audio-assets`; this file only changes
 * when a *new callout* (a new base) is introduced.
 *
 * Registered with the scenario engine at catalog load time via
 * `engine.definePoolFromManifest(name, group, base)`; scenarios reference
 * pools as `"pool:<name>"` and `{ pool: "<name>" }` exactly as before.
 *
 * This registry is emptying one family at a time (issue #1064): a family
 * migrated to pack-owned scripts addresses its clips from each voice's
 * `callouts.json` instead — directly, as `pool:<group>/<base>`, or through
 * a named entry under the script's own `pools` (the same `(group, base)`
 * shape plus a `comment`) where the name carries a decision the path does
 * not, the way `pit-action-acknowledgment` below does. The engine looks a
 * pool name up in the active voice's script first and here second, so the
 * two coexist until #1065 moves the rest. The flag family's thirty `flag-*`
 * pools were the first to go, and none of them kept a name: every flag
 * script step is `pool:flags/<base>`, and `FLAG_CLIP_SOURCES` in
 * `flag-alerts.ts` pins the sources.
 *
 * Selection is RANDOM — every pick is a uniform-random clip from the active
 * voice's members (`Math.random`), never a fixed order. The only constraint
 * is no immediate repeat: the same clip is never played twice in a row.
 * That "last index" tracker is shared per-pool (and reset when the active
 * voice changes, since variant counts differ across voices), so the
 * no-repeat guard holds even across two scenarios drawing from one pool.
 * Voices may carry different variant counts or omit a pool entirely — an
 * empty pool skips its step at fire time.
 */

/** Where a pool's members live in the manifest: `voice/<voice>/<group>/<base>-NN.mp3`. */
export type PoolSource = { group: string; base: string };

export const POOL_REGISTRY: Readonly<Record<string, PoolSource>> = {};

/**
 * Register every catalog pool with the engine — all pools derive their
 * members from the manifest per voice (the last enumerated remainder, the
 * two acknowledgment pools, moved into the registry with the #837 rename
 * migration). Pools a migrated family's scripts define are NOT here — the
 * engine takes those from the active voice's compiled script.
 */
export function registerPools(engine: {
  definePoolFromManifest(name: string, group: string, base: string): void;
}): void {
  for (const [name, { group, base }] of Object.entries(POOL_REGISTRY)) {
    engine.definePoolFromManifest(name, group, base);
  }
}
