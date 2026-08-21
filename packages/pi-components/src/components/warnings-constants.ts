/**
 * The global-settings key the `ird-warnings` banner subscribes to.
 *
 * A duplicate of deck-core's `PI_WARNINGS_KEY` — browser code cannot import
 * deck-core — pinned to it by `src/build/settings-window-constants.test.ts`.
 * Without that pin a rename on the plugin side fails SILENTLY: nothing throws,
 * the component simply never hears from its key and every banner on every page
 * stops rendering.
 *
 * Split out of `warnings.ts` so the pin can import it from a plain Node test:
 * `warnings.ts` defines a custom element and touches `HTMLElement` at module
 * scope, which only exists under jsdom. Same split, same reason, as deck-core's
 * `pi-warnings-constants.ts`.
 */
export const WARNINGS_SETTING = "_warnings";
