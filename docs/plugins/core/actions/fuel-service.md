# Fuel Service

Manages fuel pit stop settings from a keypad button or a dial (#759). On a **keypad button** the Mode setting picks the operation: toggle fueling, add/reduce/set fuel amounts, clear fuel, toggle autofuel, and adjust lap margins. On a **Stream Deck+ dial** (or Mirabox knob) the same action is the fuel dial: a bare turn sets the pit-stop fuel with a live touch-strip readout, and five configurable gesture slots (Push, Long Press, Push + Turn, Tap Display, Long Touch) each run a fuel action.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.fuel-service` |
| Type | Multi-toggle (keypad) / +/- (dial) |
| SDK Support | Yes |
| Encoder Support | Yes |
| Communication Method | iRacing API (keyboard modes: Key binding — see note) |

> **Communication method by mode:** Toggle Fuel Fill, Add Fuel, Reduce Fuel, Set Fuel Amount, and Clear Fuel Checkbox use the **iRacing API** (`pit.fuel` / `pit.clearFuel`); Toggle Autofuel and Lap Margin Increase/Decrease use **Key binding**. On the dial, the fuel gestures (Toggle Fueling, Toggle Full / No Fuel) and the bare-turn manual fuel use the **iRacing API**; Toggle Autofuel and the bare-turn autofuel lap-margin adjustment use **Key binding** (`fuelServiceToggleAutofuel`, `fuelServiceLapMarginIncrease` / `fuelServiceLapMarginDecrease`); Switch Mode talks to nothing (it only flips the action's own dial Mode setting). No chat commands.

## Behavior

### Button Press (keypad)

- **Toggle Fuel Fill**: Toggles the "Begin Fueling" pit service checkbox (`pit.fuel(0)` to arm keeping the banked amount, `pit.clearFuel` to clear)
- **Add Fuel**: Raises the pit fuel request by the amount — `pit.fuel(round(PitSvFuel + amount))` against the live telemetry baseline
- **Reduce Fuel**: Lowers the pit fuel request by the amount; at or below zero the request is emptied instead (1 L then `pit.clearFuel` — `pit.fuel(0)` would mean "keep the existing amount")
- **Set Fuel Amount**: Sets the pit fuel request to the absolute amount (`pit.fuel(round(amount))`); zero empties the request
- **Clear Fuel Checkbox**: Clears the fuel fill checkbox (`pit.clearFuel`)
- **Toggle Autofuel**: Toggles autofuel via keyboard binding
- **Lap Margin Increase/Decrease**: Adjusts autofuel lap margin via keyboard binding

iRacing banks whole liters via the pit command, so the computed target is rounded to an integer number of liters. Gallon and kilogram amounts are converted to liters before sending — kilograms via the car's fuel weight (`DriverInfo.DriverCarFuelKgPerLtr` from session info); when that weight is unavailable the press is skipped with a warning. Amount modes need live telemetry (the `PitSvFuel` baseline) and are skipped with a warning when iRacing isn't connected.

### Long-Press (Add/Reduce only)

Holding the button repeats the action roughly every 250 ms (the `pit.fuel` broadcast is effectively instant, so the interval alone sets the cadence).

### Dial (Stream Deck+ / Mirabox knob)

The dial surface is **modal**, and the mode is read from live telemetry on every event — it is never a stored setting:

- **Manual** (`dpFuelAutoFillActive` off) — a bare turn adjusts the pit fuel (the Add Amount / Target Amount behavior below).
- **Autofuel** (`dpFuelAutoFillActive` on) — a bare turn adjusts the autofuel **lap margin** via the `fuelServiceLapMarginIncrease` / `fuelServiceLapMarginDecrease` key bindings, coalesced so a fast spin doesn't flood the black box. The readout settles a beat later from `PitSvFuel` (there is no margin value in telemetry).

The **Toggle Autofuel** gesture taps `fuelServiceToggleAutofuel` to flip between the two modes.

- **Rotate (manual mode)**: Adjusts the dialed value by the step size per detent, in the displayed unit. The dial spans the full tank range (`0` to capacity) in both dial Mode settings:
  - **Add Amount** — the dialed value is the amount to add (sent via `pit.fuel`). The add is **fixed**: it does not change as fuel burns. The readout shows `+<add> = <total>` (e.g. `+20 = 65 L`); the displayed **add is read back from the live pit request (`PitSvFuel`)** — what iRacing actually banked after its whole-litre rounding — not the optimistically-dialed figure (#726). The total reflects live fuel burn.
  - **Target Amount** — the dialed value is the desired **total** after the stop, kept a whole integer in the displayed unit. The amount to add (`target − current`, rounded up so you never finish under target) is sent to iRacing (`pit.fuel`) and is **recomputed continuously as fuel burns**, with the request updated whenever the whole-unit amount changes. The recompute and re-send only happen **while fueling is on** — when fueling is off the fuel amount is **not** updated (rotating still plans the new target; turning fueling on, or pressing, sends it). The readout shows `→ <target>` (e.g. `→ 65 L`).
- **Rotate (autofuel mode)**: Adjusts the autofuel lap margin (see above).
- **Push** (short press, fires on `dialUp`): Runs the configured **Push** action. Default **Toggle Fueling**.
- **Long Press** (held dial button past the **Long-press threshold** — the global setting, default 500 ms — with no turn, fires on `dialUp`): Runs the configured **Long Press** action. Default **Toggle Autofuel** (blind-safe for VR). Available on all platforms.
- **Push + Turn** (a pressed rotation): Dispatches the configured bidirectional pair (clockwise → `cw` action, counter-clockwise → `ccw`). Offers **Full / No Fuel** (CW fills the tank to full, CCW empties it — no fuel) or **None** (default).
- Press, long-press, and push+turn are classified at `dialUp` (a duration comparison, with a guard so a push+turn pre-empts both press actions) — there is no mid-hold timer.
- The touch-strip slot carries a top **status band**: green `REFUEL: ON` / red `REFUEL: OFF` in manual mode, `AUTOFUEL: ON` / `AUTOFUEL: OFF` in autofuel mode, and a gray `AUTOFUEL: N/A` when autofuel is engaged but unavailable (`REFUEL: N/A` when the state is unknown).
- Rotating always arms fueling (`pit.fuel` checks the box) — the **Auto-enable fueling** global does not apply to the dial (see Global Settings below).

### Touchscreen (Elgato only)

- The whole 200×100 strip slot is **drawn by the plugin as one pixmap** (the encoder layout `layouts/fuel-service.json` is a single full-canvas item — the built-in layout text items cannot have a colored background): the status band across the top, a live readout (per-mode), and one continuous two-segment fuel bar over the tank capacity: the current fuel as a neutral first segment and the fuel-to-add butted onto it (green when fueling is on, gray otherwise — the loud state cue is the band, not the bar). In **manual Target Amount** mode the add is computed from the dialed target and the live fuel level; in **manual Add Amount** and **autofuel** modes the add comes from `PitSvFuel` (the live pit request, so the bar matches the in-sim black box). Only the outer corners are rounded; the current↔add boundary is flush. Small on-bar labels show the current amount (left, dark over the light current segment) and the amount to add (right, white over the green/gray add segment); a label is omitted when its segment is too narrow to hold it. In manual **Target Amount** mode a thin **red** vertical target line marks the target total, spanning the full bar height (confined to the bar); the target line is suppressed in autofuel mode.
- The bar and readout refresh every 5 seconds as a heartbeat **and immediately when the displayed state changes** (the fuel-fill color flips, or a displayed value moves), throttled to stay within the touch-strip update cap. They also update immediately on any rotate/press/settings change.
- **Tap Display** (touch-strip tap): Runs the configured **Tap Display** action (independent of the dial-button Push action). Default **None** (VR safety); the readout still shows.
- **Long Touch** (touch-strip long tap): Runs the configured **Long Touch** action. Default **None** (VR safety).

### Platform differences (dial)

| Controller                 | Rotate | Push + Turn | Touchscreen (Tap Display / Long Touch) | Push | Long Press                                                            |
| -------------------------- | ------ | ----------- | -------------------------------------- | ---- | --------------------------------------------------------------------- |
| Elgato Stream Deck+        | Yes    | Yes         | Yes                                    | Yes  | Yes                                                                   |
| Mirabox knob               | Yes    | Yes         | No                                     | Yes  | Yes (degrades to a short press if the knob reports release instantly) |

On Ulanzi the action is registered keypad-only until Ulanzi dial support is validated.

## Settings

The Property Inspector shows the settings for the surface the instance sits on: keypad instances see the keypad settings, dial instances the dial settings. The **Unit** setting is shared by both surfaces (one control each; settings are per-instance).

### Keypad settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Mode | Dropdown | Toggle Fuel Fill | Fuel service operation mode |
| Amount | Number | 1 | Fuel amount (amount modes only) |
| Unit | Dropdown | Auto (from iRacing) | Fuel unit: Auto, Liters, Gallons, Kilograms |

#### Mode Options

- **Toggle Fuel Fill** - Toggles the "Begin Fueling" checkbox on/off
- **Add Fuel** - Adds the specified amount of fuel
- **Reduce Fuel** - Reduces fuel by the specified amount
- **Set Fuel Amount** - Sets fuel to the specified amount
- **Clear Fuel Checkbox** - Clears the fuel fill checkbox
- **Toggle Autofuel** - Toggles the autofuel setting
- **Lap Margin Increase** - Increases the autofuel lap margin
- **Lap Margin Decrease** - Decreases the autofuel lap margin

#### Unit Options

- **Auto (from iRacing)** (default for new instances) - Follows iRacing's configured display units (liters when metric, gallons when english)
- **Liters** / **Gallons** / **Kilograms** - Force the amount's unit. Kilograms convert via the car's fuel weight (`DriverCarFuelKgPerLtr`)

Instances configured before the merge keep their previous behavior: a persisted Mode with no persisted Unit is migrated to **Liters** (the old default) and the migration is saved back so the PI shows it. Fresh instances persist **Auto** the first time they appear, before the PI can ever save a Mode — so a new button whose user never opens the Unit dropdown can't be mistaken for a legacy one.

### Dial settings

| Setting     | Type     | Default             | Description                                                                   |
| ----------- | -------- | ------------------- | ----------------------------------------------------------------------------- |
| Mode        | Dropdown | Add Amount          | Whether a manual-mode turn sets the amount to add or the target total         |
| Amount      | Number   | 1                   | Amount the dialed value changes per detent, in the displayed unit             |
| Unit        | Dropdown | Auto (from iRacing) | Display unit for the readout and step (no Kilograms on the dial)              |
| Press Action | Dropdown | Toggle Fueling      | What a short dial press does                                                  |
| Long Press  | Dropdown | Toggle Autofuel     | What a long dial press does                                                   |
| Push + Turn | Dropdown | None                | What a pressed rotation does — Full / No Fuel (CW fills, CCW empties) or None |
| Tap Display | Dropdown | None                | What a touch-strip tap does, or None to disable taps (Elgato only)            |
| Long Touch  | Dropdown | None                | What a touch-strip long tap does, or None to disable it (Elgato only)         |

#### Dial Mode Options

- **Add Amount** - A manual-mode turn sets the amount of fuel to add over the full tank range. The add is fixed (it does not change as fuel burns); the readout shows `+<add> = <total>` with the total reflecting live burn
- **Target Amount** - A manual-mode turn sets the total you want in the tank after the stop, as a whole integer in the displayed unit. The amount to add (target − current, rounded up so you never finish under target) is recomputed continuously as fuel burns and the request is updated whenever the whole-unit amount changes, **while fuel-fill is on**; while fuel-fill is off the amount is **not** updated (rotating still plans the new target, and turning fueling on or pressing sends it). A red vertical target line marks the target on the bar (the readout for this mode shows `→ <target>`)

#### Gesture Action Options (Push, Long Press, Tap Display, Long Touch)

- **Toggle Fueling** - Reads the live fuel-fill checkbox: requests the dialed amount when off, or clears it when on (iRacing API)
- **Toggle Full / No Fuel** - A toggle that fills the tank to full capacity; invoking it again while already at full sets it to **No Fuel** — the requested amount drops to 0, so no fuel is added. Repeatedly invoking it alternates full ↔ no fuel. No-op when capacity is unknown (iRacing API)
- **Toggle Autofuel** - Taps the `fuelServiceToggleAutofuel` key binding to switch the dial between manual and autofuel mode (key binding)
- **Switch Mode** - Flips the manual dial **Mode** between **Add Amount** and **Target Amount**, saved to the action's settings (no iRacing communication)
- **None** - The gesture does nothing; the readout still shows

#### Push + Turn Options

- **None** (default) - A pressed rotation does nothing
- **Full / No Fuel** - Clockwise fills the tank to full; counter-clockwise empties it (no fuel)

## Global Settings

### Auto-Enable Fueling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Auto-enable fueling when adjusting fuel or lap margin | Checkbox | Checked | Controls whether keypad fuel/lap-margin adjustments auto-enable the "Begin Fueling" checkbox |

When **checked** (default): adjusting the amount arms the fueling checkbox (standard iRacing `pit.fuel` behavior).

When **unchecked**: keypad presses preserve the current fueling state — if "Begin Fueling" is **currently off**, the amount is sent with `pit.fuel` and the checkbox is immediately cleared again with `pit.clearFuel` (the checkbox blips on/off in iRacing); if it is **currently on**, nothing is cleared.

**This setting applies to keypad button presses only.** The dial always arms fueling when turned — its live state machine (toggle gestures, continuous Target Amount top-up, the status band) depends on the checkbox reflecting the rotation, and a fuel+clear pair per rotation window would flood iRacing.

This setting appears in the PI for: Add Fuel, Reduce Fuel, Set Fuel Amount, Lap Margin Increase, and Lap Margin Decrease modes.

### Keyboard Bindings

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Toggle Autofuel | *(none)* | Toggle Autofuel |
| Lap Margin Increase | *(none)* | Increase Lap Margin |
| Lap Margin Decrease | *(none)* | Decrease Lap Margin |

## Icon States

### Keypad

| Mode | Icon |
|------|------|
| Toggle Fuel Fill (on) | Fuel icon with green "ON" status bar |
| Toggle Fuel Fill (off) | Fuel icon with red "OFF" status bar |
| Add Fuel | Green-accented icon with amount display (resolved unit label — L/GAL/KG) |
| Reduce Fuel | Red-accented icon with amount display (resolved unit label) |
| Set Fuel Amount | Yellow-accented icon with amount display (resolved unit label) |
| Clear Fuel | Static "CLEAR FUEL" icon |
| Toggle Autofuel (on) | "AUTO FUEL" title with fuel amount and green "ON" status bar |
| Toggle Autofuel (off) | "AUTO FUEL" title with fuel amount and red "OFF" status bar |
| Toggle Autofuel (n/a) | "AUTO FUEL" title with fuel amount and gray "N/A" status bar (autofuel system not available for this car/series) |
| Lap Margin +/- | Static "INCREASE/DECREASE LAP MARGIN" icon |

With Unit set to **Auto**, the amount-mode labels re-render when iRacing's display units change.

### Dial (touch strip)

A dial instance has no keypad icon — its display is the self-drawn 200×100 touch-strip slot (Elgato Stream Deck+ only). A full-width **status band** across the top carries the tri-state fueling cue — green / red / gray fill with white text, the same color language as the toggle buttons' status bars but at the top of the slot (#728). Color is always paired with the band text, never color alone. Below the band sit the per-mode readout and a continuous two-segment fuel bar (current fuel + fuel-to-add over capacity, deliberately subtle) with on-bar labels. Text is positioned by explicit baselines — the deck app's QT SVG renderer ignores `dominant-baseline`.

| State                         | Strip slot                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Manual, fueling on            | Green `REFUEL: ON` band, `+<add> = <total>` or `→ <target>` readout, neutral current segment + green add segment |
| Manual, fueling off           | Red `REFUEL: OFF` band, readout shown, gray add segment                                                          |
| Manual Target Amount          | Adds a red vertical target line to the bar (within the bar)                                                      |
| Autofuel on/off               | Green `AUTOFUEL: ON` / red `AUTOFUEL: OFF` band, `AUTO → <add> <unit>` readout (from `PitSvFuel`), no target line |
| Autofuel unavailable          | Gray `AUTOFUEL: N/A` band, dash readout, current segment only (`dpFuelAutoFillEnabled` is false)                 |
| State unknown (no telemetry)  | Gray `REFUEL: N/A` band                                                                                          |
| Tank capacity unknown         | Readout shown; the bar falls back to the requested span                                                          |
| Autofuel binding missing      | Slot dimmed with the centered #612 warning triangle (a gesture slot needs the unset autofuel binding)            |

## Telemetry Integration

- Fueling on/off is derived from the live pit fuel-fill checkbox (`PitSvFlags` / `FuelFill`) on every event — never a sticky local flag — so toggles alternate correctly with iRacing.
- Keypad amount modes compute against the live pit fuel request (`PitSvFuel`, the baseline); telemetry updates at 60 Hz, so the baseline is fresh again well before each hold-repeat.
- On the dial, the current fuel level is read from `FuelLevel` (the neutral first bar segment); the dialed value seeds from `PitSvFuel` on appear and re-seeds from telemetry when the user has not rotated recently. The tank capacity is read from session info (`DriverCarFuelMaxLtr × DriverCarMaxFuelPct`) and bounds the dial range; manual vs autofuel mode is derived from `dpFuelAutoFillActive`, autofuel availability from `dpFuelAutoFillEnabled`.
- The kilogram conversion reads the car's fuel weight from session info (`DriverInfo.DriverCarFuelKgPerLtr`).
- With Unit set to **Auto**, the unit follows iRacing's `DisplayUnits`.

## Notes

- All fuel values go through the iRacing SDK (`pit.fuel` / `pit.clearFuel`) — the former `#fuel` chat macros are gone, so nothing opens the chat window and sends are effectively instant. Both surfaces share one fuel-request pipeline, so "the request was deliberately cleared" is tracked action-wide (a dial's continuous top-up never re-arms fueling that a button just cleared, and vice versa).
- `pit.fuel(0)` means "keep the existing amount" to iRacing, so an intended zero request is sent as 1 L followed by `pit.clearFuel`.
- Press, long-press, and push+turn on the dial are classified at `dialUp` (a duration comparison plus a rotate guard), with no mid-hold timer — so they work on every platform. If a particular knob reports release instantly, the hold simply degrades to a short press; the Long Press default (Toggle Autofuel) and the touch-slot defaults (None) are chosen so this degradation is harmless.
- The Tap Display and Long Touch settings are hidden on Mirabox, which has no plugin touch strip.
- The touch slots default to **None** for VR drivers who cannot see the touch strip — the dial and presses still work, and the readout still renders.
