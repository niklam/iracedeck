/**
 * The global-settings key the CPU profile capture publishes its state under
 * (#1338): `_profileCaptureStatus`, a JSON string the settings window's
 * Diagnostics card renders.
 *
 * Split out of `cpu-profile-capture.ts`, like `pi-warnings-constants.ts`,
 * `voice-pack-constants.ts` and `setup-warning-constants.ts`, so the run-scoped
 * enrolment (`run-scoped-settings.ts`) names it without importing the capture
 * module and its filesystem and inspector code. `cpu-profile-capture.ts`
 * re-exports it, so consumers never need to know about the split.
 *
 * The `ird-cpu-profile-status` component duplicates the literal (browser code
 * cannot import deck-core) in `components/cpu-profile-capture-constants.ts`;
 * `settings-window-constants.test.ts` in `@iracedeck/pi-components` guards the
 * pair.
 */
export const PROFILE_CAPTURE_STATUS_KEY = "_profileCaptureStatus";
