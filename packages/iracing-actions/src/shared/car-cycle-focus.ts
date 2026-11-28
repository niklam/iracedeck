/**
 * A Next / Previous Car key tap ends iRacing's director focus (#1656).
 *
 * With Focus on Leader, Incident or Most Exciting on, iRacing's director picks
 * the camera's car, and a switch to a car of the user's takes that over. The
 * SDK's `CameraCommand` keeps which director focus is in effect, since every
 * `CamSwitchPos` / `CamSwitchNum` passes it (`focusModeInEffect`, read by
 * Camera Controls' Auto Group). iRacing's Next Car / Previous Car key bindings
 * (`car-cycle-bindings.ts`) pick a car too, but as keystrokes they never pass
 * it, so the place that taps one says so here, right before the tap and inside
 * the switch's waiter callback, so a tap the waiter drops says nothing. An
 * unset binding sends nothing and so notes nothing: each caller checks it
 * before it asks for the switch and again as it taps, since it can be
 * cleared while the switch waits behind a jump.
 *
 * Every tap of the two bindings passes one of the three callers: Camera
 * Controls' `tapCycleBinding` (Cycle by Track Order, keypad and dial), Replay
 * Control's `tapCarCycleBinding` (its Next / Previous Car keys) and its dial
 * io's `tapBinding` (the Track Order turn). They pass the key they are about
 * to tap, whatever it is, so a Sub Camera tap, which keeps the car, ends
 * nothing. A new tap cannot skip it: `replay-engine`'s
 * `camera-switch-waiter.single-policy.test.ts` fails on any camera key tap
 * that this function, with the same key, does not precede on every path
 * through its body.
 *
 * Kept apart from `car-cycle-bindings.ts`, which stays dependency-free.
 */
import { getCommands } from "@iracedeck/deck-iracing";

import { CAR_CYCLE_BINDING_KEY_LIST } from "./car-cycle-bindings.js";

/**
 * Call right before tapping the key binding `settingKey`: when it is iRacing's
 * Next Car or Previous Car, the camera's car is the user's pick from then on,
 * and the SDK hears of the tap (`CameraCommand.noteCarKeyTapped`), which ends
 * the director focus. Any other key changes nothing. Sends nothing.
 */
export function noteCameraKeyTap(settingKey: string): void {
  if (!CAR_CYCLE_BINDING_KEY_LIST.includes(settingKey)) return;

  getCommands().camera.noteCarKeyTapped();
}
