import { describe, expect, it } from "vitest";

/**
 * Guard: test workers must never load a compiled native addon.
 *
 * `@iracedeck/iracing-native` and `@iracedeck/audio-native` `require()` their
 * `.node` in module scope, so importing a plain enum from either maps a native
 * binary into the worker. `vitest.config.ts` sets `test.env.IRACEDECK_MOCK` to
 * stop that (#1084).
 *
 * This exists because that invariant rests on **one line of configuration whose
 * removal produces no failing test**. The symptom of losing it is an
 * intermittently dropped worker — which reads as a flake, not a regression, and
 * so would be re-diagnosed from scratch rather than traced to the edit. The repo
 * already guards weaker invariants this way (`tsconfig-base-inheritance`,
 * `typecheck-script-coverage`, `third-party-licenses`).
 *
 * It asserts the runtime EFFECT — the variable as the worker sees it — rather
 * than the text of the config, so it still holds if the setting moves to
 * `test-setup.ts`, a `globalSetup`, or the CI environment.
 */
describe("test workers run against the native mocks", () => {
  it("sets IRACEDECK_MOCK, so no worker maps a .node addon", () => {
    if (process.env.IRACEDECK_REAL_NATIVE) {
      // The documented escape hatch is in use: the caller has deliberately asked
      // for the real addon (to reproduce #1084, or to check a fresh build loads).
      // Assert the opt-out actually took effect rather than skipping silently —
      // both consumers test `!!process.env.IRACEDECK_MOCK`, so the empty string
      // is what makes this work and an accidental "0" would not.
      expect(
        process.env.IRACEDECK_MOCK,
        "IRACEDECK_REAL_NATIVE is set, so IRACEDECK_MOCK must be falsy — note a " +
          'non-empty "0" would still force the mock, since consumers use `!!`.',
      ).toBeFalsy();

      return;
    }

    expect(
      Boolean(process.env.IRACEDECK_MOCK),
      "vitest.config.ts must set `test.env.IRACEDECK_MOCK` so test workers use the " +
        "native mocks. Without it, ~68 test files map `iracing_native.node` into a " +
        "worker via `@iracedeck/iracing-sdk` -> `penalty-flag-utils.ts`, and a crash " +
        "during that load drops the worker's whole file with no failing test (#1084).",
    ).toBe(true);
  });
});
