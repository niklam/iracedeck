/**
 * Applies settings-window lifecycle outcomes to the PI warning store (issue #1005).
 *
 * The counterpart to `createElevationCheckSubscriber`: the pure decision lives
 * in `settings-window-warning.ts`, and this thin adapter is the only part that
 * touches the global-settings singleton. Plugins wire the returned handler as
 * the controller's `onStatus`, which is the only place that knows WHICH stage
 * failed — a plugin-side `.catch` on `open()` cannot tell a blocked port from
 * a machine with no usable browser, because `open()` rejects for both.
 *
 * `getStorePath` is a getter, not a value, so the reporter can be wired at
 * controller construction and still pick up a path that is only resolved
 * later. The evaluator stays the single decision point — set or clear is read
 * off its result, never re-derived from the status here.
 */
import { clearWarning, setWarning } from "./pi-warnings.js";
import { evaluateSettingsWindowWarnings, settingsWindowWarningScope } from "./settings-window-warning.js";
import type { SettingsWindowStatus } from "./settings-window.js";

export interface SettingsWindowWarningReporterOptions {
  /** The plugin's settings-file path, e.g. `() => settingsStore.path`. */
  getStorePath: () => string | undefined;
}

/**
 * Create the controller's `onStatus` handler. The banners are state-driven:
 * each report reconciles the records its stage speaks for against what the
 * evaluator says should be showing, so a condition that has gone clears itself. A success with nothing posted writes nothing — both
 * `setWarning` and `clearWarning` are no-ops when they would not change the
 * record, so this never churns global settings.
 */
export function createSettingsWindowWarningReporter(
  options: SettingsWindowWarningReporterOptions,
): (status: SettingsWindowStatus) => void {
  return (status) => {
    const warnings = evaluateSettingsWindowWarnings(status, { storePath: options.getStorePath() });

    // Reconcile the scope this status speaks for: anything the evaluator did
    // not return is no longer true and goes. Scoping is what keeps an
    // open-stage report from clearing the page-wide error, which stays accurate
    // whatever one press did.
    for (const id of settingsWindowWarningScope(status.stage)) {
      if (!warnings.some((w) => w.id === id)) clearWarning(id);
    }

    for (const warning of warnings) setWarning(warning.id, warning.level, warning.message);
  };
}
