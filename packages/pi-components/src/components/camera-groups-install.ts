/**
 * `window.irdCameraGroups` (issue #1653): the camera catalog view helpers for
 * `camera-focus.ejs`' inline script, which renders the two Cycle Camera grids
 * and cannot import a module. The ordering and labelling rules live in
 * `camera-groups-view.ts`, where they are unit-tested; the script only draws
 * what they return — the same split as `window.irdDigitsOnly` (#1353) and
 * `window.irdKeepOneChecked` (#1316).
 */
import { CAMERA_GROUP_HELPERS, type CameraGroupHelpers } from "./camera-groups-view.js";

/** The window surface `installCameraGroupHelpers` needs; injectable for testing. */
type InstallTarget = { irdCameraGroups?: CameraGroupHelpers };

declare global {
  interface Window {
    /** The camera catalog view helpers for the Cycle Camera grids (issue #1653). */
    irdCameraGroups?: CameraGroupHelpers;
  }
}

/** Expose the helpers as `window.irdCameraGroups`. Idempotent. */
export function installCameraGroupHelpers(win: InstallTarget = window): void {
  if (win.irdCameraGroups) return;

  win.irdCameraGroups = CAMERA_GROUP_HELPERS;
}
