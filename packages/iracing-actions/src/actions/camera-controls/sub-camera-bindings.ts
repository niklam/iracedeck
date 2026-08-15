/**
 * The iRacing key bindings that step a sub-camera (issue #852).
 *
 * iRacing's camera switch broadcasts (`CamSwitchPos` / `CamSwitchNum`) act on
 * the focused car and the camera GROUP only — their `camera` argument never
 * selects a sub-camera, verified on hardware across three dispatch shapes. The
 * sim's own "Next Sub Camera" / "Previous Sub Camera" controls are the only
 * mechanism that works, so Cycle Sub-Camera taps these bindings instead of
 * issuing an SDK command.
 *
 * This module is the single home for the two setting keys. It is dependency-free
 * on purpose: the action, the dial surface, and the comms catalog all import it,
 * and any of them importing another would be a cycle. The user-facing defaults
 * live in `actions/data/key-bindings.json` under `cameraControls` (a test
 * cross-checks the two stay in step).
 */
export const SUB_CAMERA_BINDING_KEYS = {
  next: "cameraControlsSubCameraNext",
  previous: "cameraControlsSubCameraPrevious",
} as const;

/** Both keys, in the order the PI lists them — for "either is unset" checks. */
export const SUB_CAMERA_BINDING_KEY_LIST: readonly string[] = [
  SUB_CAMERA_BINDING_KEYS.next,
  SUB_CAMERA_BINDING_KEYS.previous,
];

/** The binding a cycle direction taps. */
export function subCameraBindingKey(direction: "next" | "previous"): string {
  return SUB_CAMERA_BINDING_KEYS[direction];
}
