/**
 * The global-settings key the CPU profile capture publishes its state under
 * (#1338): `_profileCaptureStatus`, a JSON string the settings window's
 * Diagnostics card renders.
 *
 * Here rather than in deck-core's `cpu-profile-capture.ts` so the run-scoped
 * enrolment (`run-scoped-settings.ts`) names it without importing the capture
 * module and its filesystem and inspector code. Every consumer imports it from
 * `@iracedeck/app-constants` (spec #1351).
 *
 * The `ird-cpu-profile-status` component still duplicates the literal in
 * `components/cpu-profile-capture-constants.ts`;
 * `settings-window-constants.test.ts` in `@iracedeck/pi-components` guards the
 * pair.
 */
export const PROFILE_CAPTURE_STATUS_KEY = "_profileCaptureStatus";
