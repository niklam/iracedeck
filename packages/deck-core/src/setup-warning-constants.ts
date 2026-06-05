/**
 * Setup-name mismatch warning constants (issue #625).
 *
 * A dependency-free leaf so `global-settings.ts` can read the default patterns
 * without importing the matcher module (which pulls in `pi-warnings.ts`, itself
 * a consumer of `global-settings.ts`) — keeping the import graph acyclic.
 */

/** Session kind the warning is evaluated for. */
export type SetupWarningKind = "qualifying" | "race";

/**
 * Default pattern applied during **qualifying** sessions — flags a race-looking
 * setup name. A token only counts when bounded by start/end, a space, a period,
 * a hyphen, or an underscore (so `race.sto`, `my race trim`, `quali-race`, and
 * `VRS_race_v2` all match). The `-` stays last in each class so it's a literal
 * hyphen, not a range.
 */
export const DEFAULT_SETUP_WARNING_QUALIFYING_PATTERN = "(^|[ ._-])(race|r)([ ._-]|$)";

/**
 * Default pattern applied during **race** sessions — flags a qualifying-looking
 * setup name, with the same boundary rules.
 */
export const DEFAULT_SETUP_WARNING_RACE_PATTERN = "(^|[ ._-])(qualifying|quali|qual|q)([ ._-]|$)";

/** `_warnings` ids for a broken user-entered pattern (per session-kind field). */
export const SETUP_WARNING_QUALIFYING_PATTERN_WARNING_ID = "setup-warning-qualifying-pattern-invalid";
export const SETUP_WARNING_RACE_PATTERN_WARNING_ID = "setup-warning-race-pattern-invalid";

/** Global-settings keys (kept here so producers reference one source of truth). */
export const SETUP_WARNING_ENABLED_KEY = "calloutEnabledSetupWarning";
export const SETUP_WARNING_QUALIFYING_PATTERN_KEY = "setupWarningQualifyingPattern";
export const SETUP_WARNING_RACE_PATTERN_KEY = "setupWarningRacePattern";
