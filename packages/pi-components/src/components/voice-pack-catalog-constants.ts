/**
 * The install phases the `ird-voice-pack-catalog` card understands.
 *
 * A duplicate of deck-core's `VOICE_PACK_INSTALL_PHASES` — browser code cannot
 * import deck-core — pinned to it by `src/build/settings-window-constants.test.ts`.
 * Without that pin a phase added or removed on the plugin side fails SILENTLY:
 * the card drops an install record whose phase it does not know, so an install
 * in that phase would look like nothing in flight (#1102 removed `verifying`).
 *
 * Split out of `voice-pack-catalog.ts` so the pin can import it from a plain
 * Node test: that module defines a custom element and touches `HTMLElement` at
 * module scope, which only exists under jsdom. Same split, same reason, as
 * `warnings-constants.ts`.
 */
export const VOICE_PACK_CARD_PHASES = ["downloading", "extracting", "swapping", "failed"] as const;
