/**
 * Applies a rejected settings file to the PI warning store (issue #1036).
 *
 * The counterpart to `createSettingsWindowWarningReporter`: the pure decision
 * lives in `settings-file-rejection-warning.ts`, and this thin adapter is the
 * only part that touches the global-settings singleton. Plugins wire the
 * returned handler as `createFileSettingsStore`'s `onRejected`.
 *
 * It only ever SETS. `_warnings` is run-scoped (#1014), so a start whose file
 * parses begins with no banner and there is nothing to clear; a start that
 * rejects the file re-asserts it, which is the re-assertion the run-scoped rule
 * asks of every producer.
 *
 * The rejection fires while the store is still loading, so the write lands as
 * an early write. `becomeReady()` strips run-scoped keys from the loaded (here:
 * migrated) settings BEFORE applying early writes, so this banner survives into
 * the ready cache — and from there rides both the loopback channel and the
 * once-per-start deck-host mirror.
 */
import { setWarning } from "./pi-warnings.js";
import { evaluateSettingsFileRejectionWarning } from "./settings-file-rejection-warning.js";
import type { SettingsFileRejection } from "./settings-store.js";

/** Create the store's `onRejected` handler. */
export function createSettingsFileRejectionReporter(): (rejection: SettingsFileRejection) => void {
  return (rejection) => {
    const warning = evaluateSettingsFileRejectionWarning(rejection);

    setWarning(warning.id, warning.level, warning.message);
  };
}
