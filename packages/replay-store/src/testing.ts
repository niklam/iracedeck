/**
 * Test support for other packages' tests (#1375); never imported by production
 * code. Reached as `@iracedeck/replay-store/testing`.
 *
 * The store's REAL pure marker functions, for a test that replaces the
 * `@iracedeck/replay-store` barrel with `vi.mock` and backs a fake store with
 * them, so the fake answers add and delete exactly as the real store does.
 * Re-exported by relative path, so a mock of the barrel never reaches them.
 * Nothing here imports `vitest`.
 */
export { addMarker, deleteNearestMarker } from "./replay-markers.js";
