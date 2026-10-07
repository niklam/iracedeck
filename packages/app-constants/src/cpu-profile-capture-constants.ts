/**
 * The global-settings key the CPU profile capture publishes its state under
 * (#1338): `_profileCaptureStatus`, a JSON string the settings window's
 * Diagnostics card renders.
 *
 * Here rather than in deck-core's `cpu-profile-capture.ts` so the run-scoped
 * enrolment (`run-scoped-settings.ts`) names it without importing the capture
 * module and its filesystem and inspector code. Every consumer imports it from
 * `@iracedeck/app-constants` (spec #1351), the `ird-cpu-profile-status`
 * component included, so there is no copy to keep in step.
 */
export const PROFILE_CAPTURE_STATUS_KEY = "_profileCaptureStatus";
