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

### Existing keys keep working after the update

Until now these keys and dials needed no binding, so an existing user has never stored `replayControlNextCar` / `replayControlPrevCar` unless a Replay Control Next / Previous Car panel was opened. The binding field saves its default when a panel mounts, but nothing else does, so without a seed an upgraded CAR AHEAD key would show the #612 warning and do nothing until a panel was opened. The code review found this; the maintainer ruled on 2026-09-28 to seed. Once the stored settings have loaded (`isSettingsStoreReady`), each of the two keys that has **never been stored** gets its default from `key-bindings.json` (`V` / `Shift+V`), in the same shape the binding field writes. A stored value is never touched, including a deliberately cleared one. The step is idempotent, needs no marker, and runs at every start in all three plugins, beside the existing global-settings migrations.

It seeds only when the settings file reflects what the host held: the same condition under which the store mirrors to the host. That excludes a store that started fresh, is still waiting on the host migration read (`_migrationPending`), was abandoned, or failed salvage. There a missing key does not prove the user never stored a binding, because a pre-3.0 host copy may hold a custom Next Car key, and a seeded `V` in the file would permanently beat it in the next migration merge. The cost is that such a user sees the #612 warning until a later start where the host answer lands; the seed runs every start, so it fires then. One predicate in deck-core defines that condition for both the seed and the host mirror. A cleared binding (`""`) is never seeded, but the panel's binding field re-saves its default when it mounts on an empty value, so a cleared binding lasts only until that panel is next opened. That is the field's existing behaviour and is out of scope here.

### Keystrokes, not broadcasts

The old path was an SDK broadcast that worked whatever window had focus. A binding is a keystroke, so it follows the user's window-focus setting like every other binding-driven mode (#977). The docs say so. Fast dial spins go through the same keyboard path as every other binding-driven dial; this change does not alter that path.

### What happens to the computed path

`computeTrackOrderTarget` and `trackOrderDirection` in `shared/car-cycling.ts` go if nothing else uses them after this change. The underlying primitive `findNearestCarOnTrack` stays: `iracing-sdk` and Replay Control read it for other things. The comms catalog moves `cycle-track-order` and the dial's `track-order` from `api` to `keybind`.

## The sim fact this rests on

`V` (Next Car) focuses the car ahead **on track**, and `Shift+V` (Previous Car) the car behind on track. Confirmed by the maintainer on 2026-09-28, which also answers the question #1074 was waiting on. So the mode's name and the CAR AHEAD / CAR BEHIND titles stay as they are: they describe exactly what the sim does, and clockwise = Next Car = the car ahead keeps the dial's existing direction.

## Out of scope

- Cycle by Car # and Cycle by Race Position, on either surface. They cycle by a number we own, and the race order is canonical (`race-positions.md`).
- Renaming Replay Control's CAR NEXT / CAR PREVIOUS keys. That is #1074.
- The dial push in Track Order mode. It keeps whatever it does today.
- Any other consumer of `findNearestCarOnTrack`.

## Testing

- **Unit:** the keypad `cycle-track-order` taps the Next Car binding for `next` and Previous Car for `previous`, and sends no `switchNum`. The dial's clockwise and counter-clockwise detents tap the right binding with and without Reverse rotation. The strip renders the focused car with no side numbers, and renders the #612 warning when a binding is unset. A test checks that the `cameraControls` and `replayControl` entries in `key-bindings.json` name the same two settings.
- **Comms:** `action-comms.json` regenerated, and the catalog test passes.
- **Manual (sim):** finish a race, stay in the session, and open the replay. Scrub to an incident. The dial, the CAR AHEAD / CAR BEHIND keys and `V` / `Shift+V` must all land on the same cars. Repeat in a live session and in a replay opened outside a session. Rebind Next Car in the settings and confirm both actions follow it. Under caution, check whether `V` lands on the pace car: the old path skipped it, and the docs describe whatever the sim does. Upgrade test: with no stored Next / Previous Car binding, start the plugin, and an existing CAR AHEAD key works at once with no warning.
