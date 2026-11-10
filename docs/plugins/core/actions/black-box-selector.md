# Black Box Selector

Cycles through or directly selects iRacing black box screens, toggles the open box between small and large (#1238), and operates the selected control of the open box (#1585), from a keypad button, a Stream Deck+ dial (#808) or a Mirabox knob (#1013).

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.black-box-selector` |
| Type | Multi-toggle (keypad) / +/- (dial) |
| SDK Support | No |
| Encoder Support | Yes (Elgato Stream Deck+ dial; Mirabox knob — turn and push only) |
| Communication Method | Key binding |

> Every path — keypad and dial alike — is key-binding-backed; black box selection has no SDK support.

## Behavior

### Button Press
- **Direct mode**: Opens the selected black box immediately
- **Next/Previous mode**: Cycles to the next or previous black box
- **Toggle Size mode** (#1238): Single-taps the global `blackBoxToggleSize` binding, which flips whichever black box is showing between iRacing's small and large size. iRacing exposes only the toggle and no telemetry for the current size, so there is no "make large" or "make small"; with no box open the tap does nothing in the sim. It does not use the #818 prime-then-target sequence — resizing is independent of which box is shown. The binding has no default (iRacing ships it unassigned), so the key shows the #612 missing-binding state and the PI its binding warning until the user sets it
- **Selected Control mode** (#1585): The `control` sub-setting (default `next`) picks one of five presses on the selected control of whichever box is open — **Select Next Control** (`blackBoxSelectNextControl`), **Select Previous Control** (`blackBoxSelectPreviousControl`), **Increment Selected Control** (`blackBoxIncrementControl`), **Decrement Selected Control** (`blackBoxDecrementControl`) and **Toggle Selected Control** (`blackBoxToggleControl`), mapped by `BLACK_BOX_SELECTED_CONTROL_KEYS` in `shared/black-box.ts`. Increment and Decrement repeat while held (the shared `RepeatController` with the setup actions' repeat constants: a tap on press, repeats after the dual-press threshold until release; like every hold-to-repeat key it keeps the press sounds' default tap shape, since the repeat's steps are their own feedback, #269); the other three tap once, since repeating a selection or a toggle would overshoot. No #818 prime sequence — the presses act on the box already open, and with no box open iRacing does nothing. All five bindings ship unassigned. `blackBox` and `control` each keep their value while unused, so switching modes restores the user's choice

### Dial (Stream Deck+)

- **Rotate**: What a turn does is `dial.rotation` (#1585, the dial PI's **Mode** dropdown), one tap per detent of its clockwise / counter-clockwise pair (`ROTATION_KEYS` in the dial surface). A fast spin coalesces into multiple taps (up to 5 per rotate event) rather than one tap per detent regardless of speed.
  - `boxes` (**Cycle Black Boxes**, the default) — clockwise **Cycle Next**, counter-clockwise **Cycle Previous**, the same bindings the keypad Next/Previous mode uses. A dial stored before the choice existed has no `dial.rotation` and parses to `boxes`, so it is unchanged.
  - `select-control` (**Select Control**) — clockwise **Select Next Control**, counter-clockwise **Select Previous Control**.
  - `adjust-control` (**Adjust Control**) — clockwise **Increment Selected Control**, counter-clockwise **Decrement Selected Control**.
- **Push** (short press, fires on `dialUp`): Runs the configured **Press Action** gesture. Default by rotation (below): **Toggle Selected Control** on `select-control` / `adjust-control`, **None** on `boxes`.
- **Long Press** (held past the **Long-press threshold** global setting, default 500 ms, with no turn, fires on `dialUp`): Runs the configured **Long Press** gesture. Default **Switch Select / Adjust** on `select-control` / `adjust-control`, **None** on `boxes`.
- **Rotation-resolved defaults** (#1585, the one dial with gesture defaults other than None): `dial.pressAction` / `dial.longPressAction` have no schema default, so a slot the user never stored stays unset and `resolveGestures` gives it its default from `ROTATION_GESTURE_DEFAULTS` at read time; a stored value always wins, `none` included. Every dial stored before #1585 parses to `boxes` and keeps None. The PI shows an unset slot's default by retargeting the dropdown's render-only `default` attribute from the Mode, so it never writes the slot. The press sounds and the trigger description read the slots through `firingGestures`, which also silences `switch-rotation` on a `boxes` dial.
- Press and long-press are classified at `dialUp` (a duration comparison, with a guard so a rotation while held pre-empts both press actions) — there is no mid-hold timer.
- The gesture actions are **Open Selected Box**, which taps the per-box binding chosen by the **Box to Open** setting — the same 11 bindings the keypad Direct mode uses; like a Direct keypad press, it toggles the box: pressing again while it is already open closes it — and **Toggle Box Size** (#1238), which single-taps `blackBoxToggleSize` exactly like the keypad Toggle Size mode — and the three one-shot selected-control presses (#1585): **Select Next Control** (`next-control`), **Select Previous Control** (`previous-control`) and **Toggle Selected Control** (`toggle-control`), each a single tap of its binding — and **Switch Select / Adjust** (`switch-rotation`, #1585), which sends nothing: it flips this dial's `dial.rotation` between `select-control` and `adjust-control` (`SWITCHED_ROTATION`), redraws the strip and trigger description at once and persists the patch through `persistDialPatch`, so it survives a restart and the PI's Mode follows; on a `boxes` dial it does nothing (logged at debug). The surface therefore keeps its context authoritative (encoders rule 10): `refreshContext` refreshes the action only, and the gesture updates `ctx.dial` before the write, so a quick double press flips back. It has no binding and no comms entry, like Fuel Service's `switch-mode`. The strip's #612 dim tracks only the pair the chosen rotation turns, so an unset gesture binding does not dim it (its PI status line reports it).
- With the defaults, one Select Control dial works the whole box: turn to pick a control, long-press to Adjust, turn to change it, press to toggle it, long-press back. On a Mirabox knob (no long press) the same comes from Press on **Switch Select / Adjust**, or rotation on **Adjust Control** with Press on **Select Next Control**.
- There is no Push + Turn gesture: a turn while pressed does what the rotation does and fires no press.

### Touchscreen (Elgato only)

- The 200×100 strip slot is self-drawn as one pixmap showing the action's **identity only** — what a turn does, with no readback: a "BB" badge over `BLACK BOX` for `boxes`, and no badge or word for the other two (#1585) — a large up/down arrow pair around a muted centre dot for `select-control`, a left/right pair for `adjust-control`, drawn like the Selected Control key icons. iRacing exposes no telemetry for which black box is currently open or which control is selected, so the strip cannot show live state (the same #782 identity-only compromise as other dials with no telemetry readback).
- **Tap Display**: Runs the configured **Tap Display** gesture. Default **None** (VR safety).
- **Long Touch**: Runs the configured **Long Touch** gesture. Default **None** (VR safety).
- The strip's only live element is the #612 missing-binding warning, which dims the strip when either binding of the chosen rotation's pair is unset; it refreshes per dial on global-settings changes, not telemetry, so the surface never subscribes to the telemetry tick.

### Platform availability (dial)

On a **Mirabox knob** (#1013) the same dial surface runs with its identity drawing on the 176×112 screen above the knob; a knob has turn and push only (pushing the knob, however long, or tapping its screen fires Press once, at the moment of pressing), so the dial PI shows only the rotation settings, the appearance colours and the Push slot, whose rotation-resolved default (Toggle Selected Control on Select / Adjust) still applies. The Ulanzi manifest declares no dial controllers. See `docs/reference/stream-deck-plus-encoders.md` §8.

## Settings

The Property Inspector shows the settings for the surface the instance sits on: keypad instances see the keypad settings, dial instances the dial settings.

### Keypad settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Mode | Dropdown | Direct | Selection mode |
| Black Box | Dropdown | Lap Timing | Target black box (Direct mode only) |
| Control | Dropdown | Select Next Control | Which press on the open box's selected control (Selected Control mode only) |

#### Mode Options
- **Direct** - Opens a specific black box immediately
- **Next** - Cycles to the next black box
- **Previous** - Cycles to the previous black box
- **Toggle Size** - Toggles the open black box between small and large (key title `BOX SIZE`)
- **Selected Control** - Operates the selected control of the open box; the **Control** setting picks the press

#### Control Options
- **Select Next Control** - Moves to the next control of the open box (key title `NEXT CTRL`)
- **Select Previous Control** - Moves to the previous control (key title `PREV CTRL`)
- **Increment Selected Control** - Increases the selected control; repeats while held (key title `CTRL +`)
- **Decrement Selected Control** - Decreases the selected control; repeats while held (key title `CTRL -`)
- **Toggle Selected Control** - Toggles the selected control (key title `CTRL TOGGLE`)

#### Black Box Options
- Lap Timing
- Standings
- Relative
- Fuel
- Tires
- Tire Info
- Pit-stop Adjustments
- In-car Adjustments
- Quick Access
- Radio Adjustments
- Weather

### Dial settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Mode | Dropdown | Cycle Black Boxes | What a turn does (`dial.rotation`, #1585) |
| Box to Open | Dropdown | Lap Timing | Which box the **Open Selected Box** gesture opens — the same 11 options as the keypad's Black Box setting |
| Press Action | Dropdown | Toggle Selected Control on Select / Adjust Control, None on Cycle Black Boxes | What a short dial press does (unset until chosen; resolved from the Mode) |
| Long Press | Dropdown | Switch Select / Adjust on Select / Adjust Control, None on Cycle Black Boxes | What a long dial press does (unset until chosen; resolved from the Mode) |
| Tap Display | Dropdown | None | What a touch-strip tap does, or None to disable taps (Elgato only) |
| Long Touch | Dropdown | None | What a touch-strip long tap does, or None to disable it (Elgato only) |

#### Dial Mode Options (`dial.rotation`)
- **Cycle Black Boxes** (`boxes`, default) - Clockwise Cycle Next, counter-clockwise Cycle Previous; strip shows the "BB" badge and `BLACK BOX`
- **Select Control** (`select-control`) - Clockwise Select Next Control, counter-clockwise Select Previous Control; strip shows up/down arrows
- **Adjust Control** (`adjust-control`) - Clockwise Increment Selected Control, counter-clockwise Decrement Selected Control; strip shows left/right arrows

#### Gesture Action Options (Press Action, Long Press, Tap Display, Long Touch)
- **None** - The gesture does nothing; rotation still does what its Mode says
- **Open Selected Box** - Taps the binding for the box chosen in **Box to Open** — toggles it open/closed, same as a Direct keypad press
- **Toggle Box Size** - Taps the **Toggle Black Box Size** binding — flips the open box between small and large, same as a Toggle Size keypad press
- **Select Next Control** - Taps the **Select Next Control** binding, same as the keypad Selected Control mode's Select Next Control
- **Select Previous Control** - Taps the **Select Previous Control** binding
- **Toggle Selected Control** - Taps the **Toggle Selected Control** binding
- **Switch Select / Adjust** - Flips this dial's Mode between Select Control and Adjust Control and saves it; sends nothing to iRacing; does nothing on a Cycle Black Boxes dial

There is no Push + Turn gesture for the dial — a turn while pressed does what the Mode's rotation does.

## Keyboard Simulation

### Direct Mode
| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Lap Timing | F1 | Lap Timing Black Box |
| Standings | F2 | Standings Black Box |
| Relative | F3 | Relative Black Box |
| Fuel | F4 | Fuel Black Box |
| Tires | F5 | Tires Black Box |
| Tire Info | F6 | Tire Info Black Box |
| Pit-stop Adjustments | F7 | Pit-stop Adjustments Black Box |
| In-car Adjustments | F8 | In-car Adjustments Black Box |
| Quick Access | F9 | Quick Access |
| Radio Adjustments | F10 | Radio Adjustments Black Box |
| Weather | F11 | Weather Black Box |

### Next/Previous Mode
| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Next | *(none)* | Next Black Box |
| Previous | *(none)* | Prev Black Box |

### Toggle Size Mode
| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Toggle Size | *(none)* | Toggle Black Box Size |

### Selected Control Mode
| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Select Next Control | *(none)* | Select Next Control |
| Select Previous Control | *(none)* | Select Previous Control |
| Increment Selected Control | *(none)* | Increment Selected Control |
| Decrement Selected Control | *(none)* | Decrement Selected Control |
| Toggle Selected Control | *(none)* | Toggle Selected Control |

### Dial

The dial reuses the bindings above rather than defining its own — Rotate taps the pair its Mode names (the keypad Next/Previous bindings for Cycle Black Boxes, Select Next / Previous Control for Select Control, Increment / Decrement Selected Control for Adjust Control), the **Open Selected Box** gesture taps the same per-box binding as keypad Direct mode for whichever box **Box to Open** selects, the **Toggle Box Size** gesture taps the same `blackBoxToggleSize` binding as keypad Toggle Size mode, and the three control gestures tap the same bindings as the keypad Selected Control mode. **Switch Select / Adjust** uses no binding.

## Icon States

All Direct mode icons include a small "BB" label in the corner to distinguish them from similar icons used elsewhere.

| Mode | Icon |
|------|------|
| Next | "BB" with up arrow |
| Previous | "BB" with down arrow |
| Toggle Size | Small solid box in the corner of a muted larger outline, with a diagonal double-headed arrow; title `BOX SIZE` |
| Selected Control | A d-pad (four triangles and a centre circle) inside the frame, the press's part solid and the rest muted: down for Select Next (`NEXT CTRL`), up for Select Previous (`PREV CTRL`), right for Increment (`CTRL +`), left for Decrement (`CTRL -`), centre for Toggle (`CTRL TOGGLE`) |
| Direct: Lap Timing | Stopwatch + BB label |
| Direct: Standings | Podium + BB label |
| Direct: Relative | Gap indicator (±) + BB label |
| Direct: Fuel | Fuel gauge + BB label |
| Direct: Tires | Tire + BB label |
| Direct: Tire Info | Tire with temperature bars + BB label |
| Direct: Pit-stop | Pit board + BB label |
| Direct: In-car | Sliders/adjustments + BB label |
| Direct: Quick Access | Settings menu (sub-page chevrons + amber switch) + BB label |
| Direct: Radio | Headset + BB label |
| Direct: Weather | Cloud + BB label |

### Dial (touch strip)

A dial instance has no keypad icon — its display is the self-drawn 200×100 touch-strip slot on a Stream Deck+, or a separate knob drawing at 176×112 on the screen above a Mirabox knob, one pair per Mode (`renderBlackBoxStrip` / `renderBlackBoxKnob` for Cycle Black Boxes, `renderSelectControlStrip` / `renderSelectControlKnob`, `renderAdjustControlStrip` / `renderAdjustControlKnob`). Unlike other dials, the strip shows **identity only**: iRacing exposes no telemetry for which black box is open, so there is no live readback to render.

| State | Strip slot |
|-------|------------|
| Normal, Cycle Black Boxes | Inset panel with a "BB" badge and `BLACK BOX` |
| Normal, Select Control | Inset panel with a large up and down arrow around a muted centre dot; no badge or word |
| Normal, Adjust Control | Inset panel with a large left and right arrow around a muted centre dot; no badge or word |
| Rotation binding missing | Same panel, dimmed under the centered #612 warning triangle (either binding of the chosen Mode's pair is unset) |

## Notes

- Next/Previous, Toggle Size and Selected Control modes require configuring custom keybindings in iRacing (no defaults set)
- The Selected Control presses act on whichever box is open; with no box open iRacing does nothing
- Direct mode uses iRacing's default F1–F11 bindings
- Every dial path is key-binding-backed — black box selection has no SDK support, on either surface
- Rotation coalesces a fast spin into up to 5 binding taps per rotate event rather than tapping once per detent regardless of speed
- Press and long-press are classified at `dialUp` (a duration comparison against the **Long-press threshold** global setting, default 500 ms, with a guard so a rotation while held pre-empts both press actions) — there is no mid-hold timer
- The touch slots default to **None** for VR drivers who cannot see the touch strip — rotation and press still work
- The Long Press, Tap Display and Long Touch settings are hidden on Mirabox, whose knob has turn and push only
