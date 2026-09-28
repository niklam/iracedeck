# Cycle by Track Order defers to iRacing's Next / Previous Car

> **Issue:** [#1277](https://github.com/niklam/iracedeck/issues/1277) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The problem in one line

Camera Controls' track order is computed by us from the live field (`computeTrackOrderTarget` → `switchNum`, #886 / #960). In a replay inside a still-connected session that field is the live one, not the replay's, so the car we land on has nothing to do with the car the driver sees beside the focused one. iRacing's own Next / Previous Car (`V` / `Shift+V`) gets it right, and a driver who noticed has replaced our dial with a hand-made one.

## The decision

### The sim picks the car, on both surfaces

The keypad's CAR AHEAD / CAR BEHIND and the dial's Track Order mode stop computing a target and tap iRacing's Next Car / Previous Car binding instead, the way Cycle Sub-Camera taps the sub-camera bindings since #852 and Replay Control's Next Car / Previous Car modes always have. Maintainer's ruling (2026-09-28): both surfaces, because the keypad computes the same target and has the same fault.

- Keypad `next` (CAR AHEAD) taps Next Car, `previous` (CAR BEHIND) taps Previous Car.
- Dial: clockwise taps Next Car, counter-clockwise Previous Car. `ROTATION_INVERTED["track-order"]` stays `false`, and Reverse rotation still flips the pair.
- The tap is dispatched before the telemetry guard, as Sub-Camera's is: a keystroke needs no session data to be sent.

### One pair of binding settings, shared with Replay Control

The two taps read the existing global settings `replayControlNextCar` / `replayControlPrevCar` (defaults `V` / `Shift+V`). No new setting keys. iRacing has one Next Car control, so iRaceDeck keeps one place to say which key it is on; two settings for one sim control would let the two actions drift apart silently. `key-bindings.json` lists the pair under `cameraControls` as well as `replayControl`, with the same `setting` value, so the Camera Controls PI shows the fields. The FFB force keys (`cockpitMisc` and `forceFeedback`) are the precedent for one setting listed under two sections. The keys get a single home that both actions import, the way `sub-camera-bindings.ts` is the single home for the sub-camera pair, rather than Camera Controls importing from `replay-control.ts`.

### The strip shows the focused car only

With the sim choosing, we cannot know the neighbours in advance, and a preview that disagrees with where the turn lands is worse than none. The Track Order strip keeps its title and the focused car's number large in the centre, and drops the AHEAD / BEHIND side numbers and captions. Maintainer's ruling (2026-09-28). Sub-Camera's strip is the precedent. The missing-binding warning (#612) covers both surfaces when either binding is unset, through the same `isBindingMissing` path Sub-Camera uses.

### What happens to the computed path

`computeTrackOrderTarget` and `trackOrderDirection` in `shared/car-cycling.ts` go if nothing else uses them after this change. The underlying primitive `findNearestCarOnTrack` stays: `iracing-sdk` and Replay Control read it for other things. The comms catalog moves `cycle-track-order` and the dial's `track-order` from `api` to `keybind`.

## The sim fact this rests on, still to confirm

The reporter says `V` / `Shift+V` walks the replay's track order. #1074 asks the same question and it is unanswered. The fix holds either way, because the point is to match the sim's key exactly, but the mode's name does not: "Cycle by Track Order" and CAR AHEAD / CAR BEHIND claim a spatial order. Confirm it in the sim before implementing. If it is spatial, the names stay and #1074 closes with the answer. If it is not, the naming goes back to the maintainer before this ships.

## Out of scope

- Cycle by Car # and Cycle by Race Position, on either surface. They cycle by a number we own, and the race order is canonical (`race-positions.md`).
- Renaming Replay Control's CAR NEXT / CAR PREVIOUS keys. That is #1074.
- The dial push in Track Order mode. It keeps whatever it does today.
- Any other consumer of `findNearestCarOnTrack`.

## Testing

- **Unit:** the keypad `cycle-track-order` taps the Next Car binding for `next` and Previous Car for `previous`, and sends no `switchNum`. The dial's clockwise and counter-clockwise detents tap the right binding with and without Reverse rotation. The strip renders the focused car with no side numbers, and renders the #612 warning when a binding is unset. A test checks that the `cameraControls` and `replayControl` entries in `key-bindings.json` name the same two settings.
- **Comms:** `action-comms.json` regenerated, and the catalog test passes.
- **Manual (sim):** finish a race, stay in the session, and open the replay. Scrub to an incident. The dial, the CAR AHEAD / CAR BEHIND keys and `V` / `Shift+V` must all land on the same cars. Repeat in a live session and in a replay opened outside a session. Rebind Next Car in the settings and confirm both actions follow it.
