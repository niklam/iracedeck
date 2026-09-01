/**
 * Constants shared between the voice-pack producer and modules that must not
 * depend on it — the run-scoped-key enrolment in particular (issue #1034).
 *
 * A leaf module with no imports, mirroring `pi-warnings-constants.ts`, so
 * `run-scoped-settings.ts` can name the key without pulling in the scanner.
 */

/**
 * Passthrough global holding the last voice-pack scan as JSON:
 * `{ packs: [{ id, label, version, voices }, …], problems: [{ pack, reason }, …] }`.
 *
 * Both halves of one scan, in one key: a pack that was ignored is as much a
 * result of the scan as one that loaded, and publishing them separately would
 * let a Property Inspector show an installed list and a stale reason list.
 * Note the two are not exclusive — a pack that loads but declares one voice
 * with no clips under it appears in both.
 *
 * Run-scoped (see `RUN_SCOPED_SETTING_KEYS`): it describes what is on disk
 * during THIS run, not a user choice, so persisting it would let a pack the
 * user deleted reappear in the settings window after a restart. The plugin
 * re-asserts it on every scan and on every Property Inspector appearance,
 * which is the contract an enrolled key owes.
 */
export const VOICE_PACKS_KEY = "_voicePacks";
