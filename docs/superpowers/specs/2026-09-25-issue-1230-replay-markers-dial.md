# Replay Markers dial

> **Issue:** [#1230](https://github.com/niklam/iracedeck/issues/1230) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Builds on the Replay Markers action of #1162 (`2026-09-13-issue-1162-replay-markers.md`), which must merge first: every rule below that names a threshold, the frame source or the store is that spec's, reused rather than restated.

## The decision

Replay Markers becomes a dual-surface action, like Fuel Service: one UUID, `["Keypad", "Encoder"]` on the Stream Deck manifest with a committed layout, `["Keypad", "Knob"]` on Mirabox (#1013 made that declaration part of every dial action, and the manifest parity test requires it, `encoders-and-touchscreen.md` rule 7), Ulanzi `["Keypad"]`. The dial logic lives in `replay-markers/replay-markers-dial-surface.ts` behind a small host interface, and every handler branches on `ev.action.isDial()`.

| Input | Does | Default |
| --- | --- | --- |
| Rotate clockwise | Next Marker, one marker per tick | always |
| Rotate counter-clockwise | Previous Marker, one marker per tick | always |
| Press | `dial.pressAction` | Add Marker |
| Long press (Elgato) | `dial.longPressAction` | Delete Marker |
| Push + turn (Elgato) | the same stepping as a plain turn; the release fires nothing | always |
| Tap Display (Elgato) | `dial.tapAction` | None |
| Long Touch (Elgato) | `dial.longTouchAction` | None |

Each gesture slot offers **Add Marker**, **Delete Marker** and **None**, so a Mirabox knob, which has only rotate and press, reaches Delete by assigning it to Press (rule 2).

## Rotation

- **Direction: clockwise = forward in the recording.** The markers are ordered by frame, which is time, so this is a spatial rotation under rule 4 of `encoders-and-touchscreen.md` and takes no number-primary flip, even though the strip shows an index ("2 / 5"): the user navigates by time, never by that number. There is no `reverseRotation` setting; nothing in the family has asked for one.
- **The first step is the keypad's own rule.** From the current frame (`resolveReplayFrame`), clockwise is `store.markers.next(frame)` — the first marker more than 60 frames ahead — and counter-clockwise is `store.markers.previous(frame)`, the media-player rule with its 2 s window measured from the anchor marker. Reusing the store's functions, not re-deriving them, is what keeps a turn and a key press landing on the same marker.
- **Further steps walk the list.** `|ticks| > 1` walks that many markers from the first target with no per-event cap (amended 2026-10-04, matching the Replay Control dial's ruling in #1316: someone will spin it like crazy), stopping at the end of the list rather than wrapping (rule 3's clamp) — a wrap would jump from the last lap to the first without the driver seeing why. One event sends **one** `setPlayPosition(Begin, frame)`, to the last marker reached.
- **A pending landing anchors the next event.** After a jump, `ReplayFrameNum` reaches the target only on a later tick, so a second detent arriving first would compute from the old frame and send the same marker again — a fast spin would stick. The surface therefore keeps the frame it last jumped to and measures the next event from it while telemetry has not yet reached it, for at most `DIAL_LANDING_HOLD_MS` (1 000 ms) after the send. Once telemetry reports a frame within 60 frames of the target, or the hold expires, the live frame is the anchor again. This state is per context and in memory only.
- **No marker in that direction, not in a replay, or no store / telemetry: nothing is sent.** Same predicate as the keypad's greyed Next / Previous keys, extracted so both surfaces call one function. From the car it always sends nothing, because iRacing ignores replay commands sent while driving (`irsdk_defines.h`, the #1162 finding).
- **The replay cursor.** Every send is preceded by `cancelReplayCursorOwner("dial-next" | "dial-previous")`, exactly as the keypad's jumps are, so a turn stops a running Jump to Fastest Lap walk rather than being overridden by its next probe. The dial never claims the cursor itself: each event is a one-shot command.
- **Push + turn** is a plain turn. There is no second function worth hiding behind it, and a VR driver whose thumb rests on the button while turning should get the same jump. The classifier's `push-turn` result makes the release fire nothing, which is what keeps a held-and-turned dial from also deleting a marker.

## Press gestures

Classified at release by `classifyDialReleaseForHost` with `getDualPressThresholdMs()`, as every dial does; no timer decides. On a Mirabox knob every press is a short press (the adapter's atomic press, #1013), so only `dial.pressAction` is reachable there.

- **Press = Add Marker** is the default because it is the one action a driver wants from the car, and it works there: Add measures from `ReplayFrameNumEnd` live and from `ReplayFrameNum` in a replay, per #1162. It uses the dial's own **Seconds back** (`dial.secondsBack`, default 5, 0–60, parsed with the same blank-to-default and clamp as the keypad's `secondsBack`, by sharing that schema fragment).
- **Long press = Delete Marker.** It removes the marker the keypad's Delete would (`pickMarkerToDelete`: within 600 frames of the marker or its press frame). A long-press default must be safe and never the only route to a function (rule 2): Delete is bounded by its 10 s window, is also a keypad mode, is assignable to Press, and the slot can be set to None.
- **Tap Display and Long Touch default to None** (rule 5), Elgato only.
- **Hold preview (#1120), Elgato only** (gated on `__FEATURE_DIAL_EXTENDED_GESTURES__`, like every preview). The outcome of both gestures is knowable before release: Delete's target is `pickMarkerToDelete(store.markers.list(scope), frame)` and Add's is `buildMarker` plus the dedupe check. So when the hold passes the threshold, the strip shows what the release will do — the marker that would go, as "DELETE 3 / 5", or "ADD −5 s" — and `onThreshold` returns `false`, leaving the strip still, when the release would do nothing (no marker within the window, a duplicate Add, no telemetry). Absent telemetry previews nothing, never a default (trap 2). The pending state goes into the render arguments and the displayed signature (trap 3), and `up()` disarms before its early returns (trap 4).

## The display

Drawn through `dialCanvas()` / `setDialCanvas()` on every host and only when the profile is non-null (amended 2026-10-04: #1013 retired `__FEATURE_DIAL_FEEDBACK__`), so the same code draws the Stream Deck+ strip and the Mirabox knob screen. Rendered through the shared `renderDialBox` with `dialAppearanceFields` so its colours are adjustable like the Setup dials', and its `pending` slot carrying the hold preview.

- **Label:** `MARKERS`.
- **Value:** `k / N` when the current frame is at marker *k* — at or up to 120 frames (2 s) past it, the same window Previous treats as "still playing"; otherwise `N` alone with the side marks showing which way there is somewhere to go; `NONE` when the session has no markers.
- **Side marks:** the left and right marks lit when a counter-clockwise or clockwise turn would jump, dimmed when it would send nothing — the same predicate as the rotation, so the strip cannot promise a jump the dial will not make. `renderDialBox`'s `sideMarker` takes one side today; it widens to light either, both or neither, additively, in both the strip and the knob renderer, with the existing callers' output byte-identical. The Replay Control dial (#1316) needs the same widening; whichever lands first does it.
- **From the car:** both side marks dimmed (no turn can jump), the value still shows the count, and a small caption reads `ADD −5 s` so the press is readable while driving. `renderDialBox` has no caption today; it gains an optional `caption` line, additively and in both renderers, which #1316 reuses for its resume speed. The strip is not greyed as a whole, because Add and Delete work from the car.
- **No store or no telemetry:** the whole box dims, like the keypad's unavailable look.
- **Confirmation:** a successful Add or Delete shows `ADDED k / N` or `DELETED` for `CONFIRMATION_FLASH_MS` (1 s), the keypad's flash time; a press that does nothing shows nothing.
- **Rendering cadence:** re-evaluated on each SDK tick, but the dedupe signature is built from what is displayed (label, value, side marks, caption, pending, flash), never the raw frame, so a playing replay does not push a frame per tick; pushes are throttled to at most 10 per second per dial (rule 6).

## Settings

A new `dial` root object on `ReplayMarkersSettings`, `.prefault({})`, holding `secondsBack`, `pressAction`, `longPressAction`, `tapAction`, `longTouchAction` and the `dialAppearanceFields` colours, each with a `.catch` to its default. Dial keys live under `dial` so the two surfaces cannot collide (the Fuel Service rule). A stored setting is a persisted contract, and this change only adds optional keys: existing keypad instances parse exactly as before, nothing is renamed or removed, and no migration is written. The top-level `mode` is still parsed on a dial instance and ignored there. The PI branches on `actionInfo.payload.controller` (`fuel-service.ejs` is the pattern) and shows the dial section only on a dial; the gesture selects label their options Add Marker / Delete Marker / None, and Long Press, Tap Display and Long Touch are hidden where `dialExtendedGestures` is off.

## Communication

Every jump is one SDK broadcast; Add and Delete are stored by iRaceDeck and send nothing to iRacing. So the dial needs no key binding, carries no #612 missing-binding warning, and its comms-catalog entry lists rotation as `api` with Add and Delete absent, as the keypad's are (`pnpm generate:action-comms`).

## Alternatives rejected

- **Push + turn as a faster step, or to adjust Seconds back.** A hidden second speed adds nothing an uncapped `|ticks|` walk does not, and turning a persisted setting with a gesture writes settings from a drive-time input.
- **Wrap at the ends of the list.** A wrap is a jump the strip cannot explain mid-spin.
- **One command per tick.** Sending five `setPlayPosition` in one event only lands on the last; one command to the final target is the same result with no intermediate seeks.
- **Reviving Replay Control's dormant dial for markers.** Markers are their own action with their own store (#1162's reasoning); the dial belongs to it.
- **A self-drawn pixmap instead of `renderDialBox`.** The box already carries the label/value/pending/colour shape this needs, on both canvases; only its side marks and a caption line are added.

## Out of scope

- An Ulanzi dial declaration — withheld until its dials are verified (rule 7).
- Jumping to the first or last marker, naming markers, or a markers browser on the strip.
- A dial for Replay Control, or merging the two actions.
- Anything the #1162 spec leaves open (the renumbering risks, the saved-file lag).

## Testing

Unit tests, in `replay-markers-dial-surface.test.ts` under the deck-core mock:

- Rotation: clockwise / counter-clockwise send `setPlayPosition(Begin, frame)` to the same marker the keypad's Next / Previous pick from the same frame; `ticks = 3` walks three markers and sends once; `ticks = 9` walks nine markers, or to the end of the list, with no cap; the end of the list stops without wrapping; nothing is sent from the car, with no marker in the direction, or without store or telemetry.
- The pending landing: a second event before telemetry catches up steps from the last target, not the stale frame; after `DIAL_LANDING_HOLD_MS` or once telemetry arrives, the live frame anchors again.
- `cancelReplayCursorOwner` is called before every send and never when nothing is sent.
- Gestures: short press adds with `dial.secondsBack`, long press deletes the `pickMarkerToDelete` target, push + turn fires nothing on release, None does nothing, the tap slots are inert and no release classifies as long with `__FEATURE_DIAL_EXTENDED_GESTURES__` off.
- Hold preview: armed at threshold for a deletable marker and for a non-duplicate Add; `onThreshold` false when the release would do nothing or telemetry is absent; `up()` reverts on every early-return path.
- Strip: `k / N` inside the 2 s window, `N` outside it, `NONE` with no markers, side marks matching the rotation predicate, from-the-car caption, whole-box dim without store or telemetry, confirmation flash for 1 s; a playing replay with an unchanged display pushes no frame; pushes throttled to 10/s; a null `dialCanvas()` pushes nothing; with `__FEATURE_DIAL_EXTENDED_GESTURES__` off no preview helper is constructed.
- Settings: a keypad instance's stored settings parse unchanged; an empty `dial` fills every default; out-of-range and blank `secondsBack` clamp and default as the keypad's do.
- The widened `renderDialBox` (`sideMarker` on both sides, `caption`): existing callers render byte-identical output on both canvases (the strip fixtures stay green).

Manual, on a Stream Deck+ and a Mirabox knob in the sim (the gate before the PR):

1. Live, press the dial twice a few seconds apart: the strip flashes `ADDED`, the count rises, both side marks stay dimmed, the caption reads the Seconds back.
2. Open the in-session replay: turn counter-clockwise, land about 5 s before the second press, the strip reads `2 / 2`; turn again, land on the first; clockwise returns. A fast spin across several markers lands on the right one and does not stick.
3. Long-press on a marker: past the threshold the strip previews `DELETE`, release removes it; long-press away from any marker: the strip stays still, release does nothing.
4. Start Jump to Fastest Lap from Replay Control and turn the dial mid-walk: the walk stops and the dial's jump stands.
5. On the Mirabox knob: rotate steps markers, press adds, the knob screen shows the same box; with Press set to Delete Marker, a press deletes.
6. The Ulanzi build still shows Replay Markers as a key only.
