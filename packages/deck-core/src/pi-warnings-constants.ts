/**
 * The global-settings key the Property Inspector warning banner lives under
 * (issues #610, #1014).
 *
 * Split out of `pi-warnings.ts` so the run-scoped-key enrolment can name it
 * without an import cycle: `pi-warnings.ts` imports `global-settings.ts`, and
 * `global-settings.ts` imports the enrolment. `setup-warning-constants.ts`
 * exists for the same reason. `pi-warnings.ts` re-exports it, so consumers
 * never need to know about the split.
 *
 * The `ird-warnings` PI component duplicates the literal (browser code cannot
 * import deck-core); `settings-window-constants.test.ts` in
 * `@iracedeck/pi-components` guards the pair.
 */
export const PI_WARNINGS_KEY = "_warnings";
