/**
 * Setup-name mismatch warning (issue #625).
 *
 * At session start the Race Engineer appends a "double-check your setup" nudge
 * when the loaded setup's name looks wrong for the session type — a race-looking
 * name in qualifying, or a qualifying-looking name in a race. Detection is a
 * user-editable, case-insensitive regular expression tested against the live
 * setup name (`DriverInfo.DriverSetupName`). It is a heuristic on the *name*, so
 * it only ever asks the driver to verify; it never gates anything.
 *
 * These functions are pure (no global reads) except `validateSetupWarningPatterns`,
 * which posts/clears the PI banner for a broken user pattern. Plugins call
 * `evaluateSetupWarning` live at fire time and `validateSetupWarningPatterns` when
 * settings change.
 */
import { clearWarning, setWarning } from "./pi-warnings.js";
import {
  DEFAULT_SETUP_WARNING_QUALIFYING_PATTERN,
  DEFAULT_SETUP_WARNING_RACE_PATTERN,
  SETUP_WARNING_ENABLED_KEY,
  SETUP_WARNING_QUALIFYING_PATTERN_KEY,
  SETUP_WARNING_QUALIFYING_PATTERN_WARNING_ID,
  SETUP_WARNING_RACE_PATTERN_KEY,
  SETUP_WARNING_RACE_PATTERN_WARNING_ID,
  type SetupWarningKind,
} from "./setup-warning-constants.js";

export {
  DEFAULT_SETUP_WARNING_QUALIFYING_PATTERN,
  DEFAULT_SETUP_WARNING_RACE_PATTERN,
  SETUP_WARNING_ENABLED_KEY,
  SETUP_WARNING_QUALIFYING_PATTERN_KEY,
  SETUP_WARNING_QUALIFYING_PATTERN_WARNING_ID,
  SETUP_WARNING_RACE_PATTERN_KEY,
  SETUP_WARNING_RACE_PATTERN_WARNING_ID,
  type SetupWarningKind,
};

/**
 * Compile a user pattern defensively. Returns `null` for an invalid regex rather
 * than throwing, so the callout can never crash on a broken pattern.
 */
export function compileSetupWarningPattern(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

/**
 * Test a setup name against a pattern. A missing name or an invalid pattern both
 * yield `false` (no warning) — setup names are short, so ReDoS risk is negligible
 * and matching is bounded to the name only.
 */
export function setupNameMatchesPattern(setupName: string | null | undefined, pattern: string): boolean {
  if (!setupName) return false;

  // `compileSetupWarningPattern` already guards the only throwing call
  // (`new RegExp`); `RegExp.prototype.test` never throws, so no further guard.
  const re = compileSetupWarningPattern(pattern);

  return re ? re.test(setupName) : false;
}

/**
 * Resolve the effective pattern: a non-empty user string wins; an empty/missing
 * value falls back to the supplied default (an empty regex would match every
 * name, so empty must mean "use the default").
 */
export function resolveSetupWarningPattern(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.trim() !== "" ? raw : fallback;
}

/**
 * The live gate consumed by the scenario `if:` clause. True only when the opt-in
 * is on AND the session-kind pattern matches the live setup name. Read fresh on
 * every fire so a mid-session toggle/edit takes effect immediately.
 */
export function evaluateSetupWarning(
  kind: SetupWarningKind,
  settings: Record<string, unknown>,
  setupName: string | null | undefined,
): boolean {
  if (settings[SETUP_WARNING_ENABLED_KEY] === false) return false;

  const pattern =
    kind === "qualifying"
      ? resolveSetupWarningPattern(
          settings[SETUP_WARNING_QUALIFYING_PATTERN_KEY],
          DEFAULT_SETUP_WARNING_QUALIFYING_PATTERN,
        )
      : resolveSetupWarningPattern(settings[SETUP_WARNING_RACE_PATTERN_KEY], DEFAULT_SETUP_WARNING_RACE_PATTERN);

  return setupNameMatchesPattern(setupName, pattern);
}

/**
 * Post or clear the PI banner for each pattern field. A non-empty value that
 * fails to compile banners (so the user knows to fix it or press Reset); an empty
 * value falls back to the always-valid default and clears the banner.
 */
export function validateSetupWarningPatterns(settings: Record<string, unknown>): void {
  const checks: Array<{ raw: unknown; fallback: string; id: string; label: string }> = [
    {
      raw: settings[SETUP_WARNING_QUALIFYING_PATTERN_KEY],
      fallback: DEFAULT_SETUP_WARNING_QUALIFYING_PATTERN,
      id: SETUP_WARNING_QUALIFYING_PATTERN_WARNING_ID,
      label: "Qualifying-session",
    },
    {
      raw: settings[SETUP_WARNING_RACE_PATTERN_KEY],
      fallback: DEFAULT_SETUP_WARNING_RACE_PATTERN,
      id: SETUP_WARNING_RACE_PATTERN_WARNING_ID,
      label: "Race-session",
    },
  ];

  for (const { raw, fallback, id, label } of checks) {
    const pattern = resolveSetupWarningPattern(raw, fallback);

    if (compileSetupWarningPattern(pattern) === null) {
      setWarning(
        id,
        "warning",
        `The ${label} setup-name pattern is not a valid regular expression. The setup warning is skipped until you fix it or press Reset.`,
      );
    } else {
      clearWarning(id);
    }
  }
}
