/**
 * Test support for other packages' tests (#1375); never imported by production
 * code. Reached as `@iracedeck/deck-iracing/testing`.
 *
 * The REAL DisplayUnits fuel conversion, for a test that replaces the
 * `@iracedeck/deck-iracing` barrel with `vi.mock` (its `SimIRacingAction`
 * extends a deck-core class such a suite does not load) yet asserts converted
 * figures. Re-exported by relative path, so a mock of the barrel never reaches
 * it. The sim-neutral conversions (`celsiusToFahrenheit` and the rest) need no
 * entry here: they come from `@iracedeck/app-constants`, which no test mocks.
 * Nothing here imports `vitest`.
 */
export { fuelToDisplayUnits } from "./unit-conversion.js";
