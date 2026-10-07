/**
 * The global-settings key the Property Inspector warning banner lives under
 * (issues #610, #1014).
 *
 * Here rather than in deck-core's `pi-warnings.ts` so the run-scoped-key
 * enrolment can name it without an import cycle: `pi-warnings.ts` imports
 * `global-settings.ts`, and `global-settings.ts` imports the enrolment. Every
 * consumer imports it from `@iracedeck/app-constants` (spec #1351).
 *
 * The `ird-warnings` PI component still duplicates the literal in its own
 * `components/warnings-constants.ts`;
 * `settings-window-constants.test.ts` in `@iracedeck/pi-components` guards the
 * pair.
 */
export const PI_WARNINGS_KEY = "_warnings";
