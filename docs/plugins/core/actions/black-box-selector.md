# Black Box Selector

Cycles through or directly selects iRacing black box screens, from a keypad button or a Stream Deck+ dial (#808).

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.black-box-selector` |
| Type | Multi-toggle (keypad) / +/- (dial) |
| SDK Support | No |
| Encoder Support | Yes (Elgato Stream Deck+ only) |
| Communication Method | Key binding |

> Every path — keypad and dial alike — is key-binding-backed; black box selection has no SDK support.

## Behavior

### Button Press
- **Direct mode**: Opens the selected black box immediately
- **Next/Previous mode**: Cycles to the next or previous black box

### Dial (Stream Deck+)

- **Rotate**: Steps through iRacing's black boxes one at a time — clockwise taps the **Cycle Next** binding, counter-clockwise taps **Cycle Previous** — the same bindings the keypad Next/Previous mode uses. A fast spin coalesces into multiple taps (up to 5 per rotate event) rather than one tap per detent regardless of speed.
- **Push** (short press, fires on `dialUp`): Runs the configured **Press Action** gesture. Default **None**.
- **Long Press** (held past the **Long-press threshold** global setting, default 500 ms, with no turn, fires on `dialUp`): Runs the configured **Long Press** gesture. Default **None**.
- Press and long-press are classified at `dialUp` (a duration comparison, with a guard so a rotation while held pre-empts both press actions) — there is no mid-hold timer.
- The only gesture action is **Open Selected Box**: taps the per-box binding chosen by the **Box to Open** setting — the same 11 bindings the keypad Direct mode uses. Like a Direct keypad press, it toggles the box: pressing again while it is already open closes it.
- There is no Push + Turn gesture and no rotation-mode setting — rotation always cycles.

### Touchscreen (Elgato only)

- The 200×100 strip slot is self-drawn as one pixmap showing the action's **identity only** — a "BB" badge and the "BLACK BOX" wordmark — with no open-box readback. iRacing exposes no telemetry for which black box is currently open, so the strip cannot show live state (the same #782 identity-only compromise as other dials with no telemetry readback).
- **Tap Display**: Runs the configured **Tap Display** gesture. Default **None** (VR safety).
- **Long Touch**: Runs the configured **Long Touch** gesture. Default **None** (VR safety).
- The strip's only live element is the #612 missing-binding warning, which dims the strip when either Cycle binding is unset; it refreshes on global-settings changes, not telemetry, so the surface never subscribes to the telemetry tick.

### Platform availability (dial)

The dial surface is **Elgato Stream Deck+ only** (#786): the Mirabox and Ulanzi manifests declare no dial controllers, so the action registers keypad-only there until knob/dial input is verified on real hardware (`docs/reference/stream-deck-plus-encoders.md` §8).

## Settings

The Property Inspector shows the settings for the surface the instance sits on: keypad instances see the keypad settings, dial instances the dial settings.

### Keypad settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Mode | Dropdown | Direct | Selection mode |
| Black Box | Dropdown | Lap Timing | Target black box (Direct mode only) |

#### Mode Options
- **Direct** - Opens a specific black box immediately
- **Next** - Cycles to the next black box
- **Previous** - Cycles to the previous black box

#### Black Box Options
- Lap Timing
- Standings
- Relative
- Fuel
- Tires
- Tire Info
- Pit-stop Adjustments
- In-car Adjustments
- Mirror Adjustments
- Radio Adjustments
- Weather

### Dial settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Box to Open | Dropdown | Lap Timing | Which box the **Open Selected Box** gesture opens — the same 11 options as the keypad's Black Box setting |
| Press Action | Dropdown | None | What a short dial press does |
| Long Press | Dropdown | None | What a long dial press does |
| Tap Display | Dropdown | None | What a touch-strip tap does, or None to disable taps (Elgato only) |
| Long Touch | Dropdown | None | What a touch-strip long tap does, or None to disable it (Elgato only) |

#### Gesture Action Options (Press Action, Long Press, Tap Display, Long Touch)
- **None** - The gesture does nothing; rotation still cycles black boxes
- **Open Selected Box** - Taps the binding for the box chosen in **Box to Open** — toggles it open/closed, same as a Direct keypad press

There is no Push + Turn gesture and no rotation-mode setting for the dial — rotation always cycles next/previous.

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
| Mirror Adjustments | F9 | Mirror Adjustments Black Box |
| Radio Adjustments | F10 | Radio Adjustments Black Box |
| Weather | F11 | Weather Black Box |

### Next/Previous Mode
| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Next | *(none)* | Next Black Box |
| Previous | *(none)* | Prev Black Box |

### Dial

The dial reuses the bindings above rather than defining its own — Rotate taps the same Next/Previous bindings as keypad Next/Previous mode, and the **Open Selected Box** gesture taps the same per-box binding as keypad Direct mode for whichever box **Box to Open** selects.

## Icon States

All Direct mode icons include a small "BB" label in the corner to distinguish them from similar icons used elsewhere.

| Mode | Icon |
|------|------|
| Next | "BB" with up arrow |
| Previous | "BB" with down arrow |
| Direct: Lap Timing | Stopwatch + BB label |
| Direct: Standings | Podium + BB label |
| Direct: Relative | Gap indicator (±) + BB label |
| Direct: Fuel | Fuel gauge + BB label |
| Direct: Tires | Tire + BB label |
| Direct: Tire Info | Tire with temperature bars + BB label |
| Direct: Pit-stop | Pit board + BB label |
| Direct: In-car | Sliders/adjustments + BB label |
| Direct: Mirror | Mirror + BB label |
| Direct: Radio | Headset + BB label |
| Direct: Weather | Cloud + BB label |

### Dial (touch strip)

A dial instance has no keypad icon — its display is the self-drawn 200×100 touch-strip slot (Elgato Stream Deck+ only). Unlike other dials, the strip shows **identity only**: iRacing exposes no telemetry for which black box is open, so there is no live readback to render.

| State | Strip slot |
|-------|------------|
| Normal | Inset panel with a "BB" badge and the "BLACK BOX" wordmark |
| Cycle binding missing | Same panel, dimmed under the centered #612 warning triangle (either Cycle Next or Cycle Previous is unset) |

## Notes

- Next/Previous mode requires configuring custom keybindings in iRacing (no defaults set)
- Direct mode uses iRacing's default F1–F11 bindings
- Every dial path is key-binding-backed — black box selection has no SDK support, on either surface
- Rotation coalesces a fast spin into up to 5 binding taps per rotate event rather than tapping once per detent regardless of speed
- Press and long-press are classified at `dialUp` (a duration comparison against the **Long-press threshold** global setting, default 500 ms, with a guard so a rotation while held pre-empts both press actions) — there is no mid-hold timer
- The touch slots default to **None** for VR drivers who cannot see the touch strip — rotation and press still work
- The Tap Display and Long Touch settings are hidden on Mirabox, which has no plugin touch strip
