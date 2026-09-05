/**
 * Applies the missing-callout-script condition to the PI warning store
 * (issue #1064).
 *
 * The counterpart to `createSettingsWindowWarningReporter`: the pure decision
 * lives in `voice-script-warning.ts`, and this thin adapter is the only part
 * that touches the warning store. Plugins call the returned handler whenever
 * the answer can have changed — after every voice-pack scan (`applyScripts`
 * hands the engine a new map) and on every change of the active voice — so
 * the banner is state-driven and re-asserted within the run, which is what
 * `_warnings` being run-scoped (#1014) asks of every producer.
 *
 * `set` and `clear` are injected rather than imported so the reporter can be
 * wired against a store double in tests and against `setWarning` /
 * `clearWarning` in the plugins; the evaluator stays the single decision
 * point — set or clear is read off its result, never re-derived here.
 */
import type { clearWarning, setWarning } from "./pi-warnings.js";
import {
  evaluateVoiceScriptWarning,
  VOICE_SCRIPT_WARNING_ID,
  type VoiceScriptWarningInput,
} from "./voice-script-warning.js";

export interface VoiceScriptWarningReporterDeps {
  /** Posts a warning record — `setWarning` in the plugins. */
  set: typeof setWarning;
  /** Retires a warning record by id — `clearWarning` in the plugins. */
  clear: typeof clearWarning;
}

/**
 * Create the handler. Idempotent by construction: `setWarning` skips the
 * write when the identical record is already posted, and `clearWarning` when
 * there is nothing to clear, so reporting the same state on every rescan
 * costs no global-settings write.
 */
export function createVoiceScriptWarningReporter(
  deps: VoiceScriptWarningReporterDeps,
): (input: VoiceScriptWarningInput) => void {
  const { set, clear } = deps;

  return (input) => {
    const warning = evaluateVoiceScriptWarning(input);

    if (warning) {
      set(warning.id, warning.level, warning.message);
    } else {
      clear(VOICE_SCRIPT_WARNING_ID);
    }
  };
}
