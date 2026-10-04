/**
 * The global-settings key `ird-cpu-profile-status` subscribes to (#1338).
 *
 * A duplicate of deck-core's `PROFILE_CAPTURE_STATUS_KEY` — browser code cannot
 * import deck-core — pinned to it by `src/build/settings-window-constants.test.ts`.
 * Without that pin a rename on the plugin side fails silently: the status line
 * never hears from its key and a capture shows no countdown, no file name and
 * no failure.
 *
 * Split out of `cpu-profile-capture.ts` so the pin can import it from a plain
 * Node test: that module defines custom elements at module scope, which only
 * exist under jsdom. Same split as `warnings-constants.ts`.
 */
export const PROFILE_CAPTURE_STATUS_SETTING = "_profileCaptureStatus";
