/**
 * The global-settings key the Property Inspector warning banner lives under
 * (issues #610, #1014).
 *
 * Here rather than in `@iracedeck/settings`' `pi-warnings.ts` so the run-scoped-key
 * enrolment can name it without an import cycle: `pi-warnings.ts` imports
 * `global-settings.ts`, and `global-settings.ts` imports the enrolment. Every
 * consumer imports it from `@iracedeck/app-constants` (spec #1351), the
 * `ird-warnings` PI component included, so there is no copy to keep in step.
 */
export const PI_WARNINGS_KEY = "_warnings";

/**
 * A warning banner's severities, which pick its icon and colour in the PI. The
 * one list the type, the plugin's record schema and the PI's reader all use, so
 * a level added here is admitted everywhere at once.
 */
export const PI_WARNING_LEVELS = ["info", "warning", "error"] as const;

/** A warning banner's severity. */
export type PiWarningLevel = (typeof PI_WARNING_LEVELS)[number];

/**
 * One record of the `_warnings` array: the shape the plugin writes and the
 * `ird-warnings` PI component reads (spec #1351). Here beside its key so the
 * writers, `@iracedeck/settings`' `pi-warnings.ts` and the evaluators across
 * the packages, and the browser reader name one type.
 */
export interface PiWarning {
  id: string;
  level: PiWarningLevel;
  message: string;
}
