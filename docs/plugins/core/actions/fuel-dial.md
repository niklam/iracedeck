# Fuel Dial

Sets the pit-stop fuel from a Stream Deck+ dial with a live touch-strip readout. The dial sets either the amount to add or the desired total after the stop, depending on the Mode.

## Properties

| Property             | Value                             |
| -------------------- | --------------------------------- |
| Action ID            | `com.iracedeck.sd.core.fuel-dial` |
| Type                 | +/-                               |
| SDK Support          | Yes                               |
| Encoder Support      | Yes                               |
| Communication Method | iRacing API                       |

This is the first action to (re-)support a Stream Deck+ dial/encoder and touchscreen since the dial rebuild.

## Behavior

### Encoder (Dial)

- **Rotate**: Adjusts the dialed value by the step size per detent, in the displayed unit. The dial spans the full tank range (`0` to capacity) in both modes:
  - **Add Amount** — the dialed value is the amount to add. The add is **fixed**: it does not change as fuel burns. The readout shows `+<add> = <total>` (e.g. `+20 = 65 L`), where the total reflects live fuel burn.
  - **Fill To** — the dialed value is the desired **total** after the stop, kept a whole integer in the displayed unit. The amount to add (`target − current`) is sent to iRacing (`pit.fuel`) and **auto-recomputes** as fuel burns. The readout shows `→ <target>` (e.g. `→ 65 L`).
- **Short press**: Runs the configured Press Action.
- **Long press** (Elgato only): Runs the configured Long-Press Action.
- The touch-strip title and keypad title are **mode-aware**: `Fuel: Add Amount` in Add Amount mode, `Fuel: Fill To` in Fill To mode.

### Touchscreen (Elgato only)

- Always shows a live readout (per-mode, see above) with one continuous two-segment fuel bar over the tank capacity: the current fuel as a neutral first segment and the fuel-to-add butted onto it (green when fuel-fill is on, gray when off). Only the outer corners are rounded; the current↔add boundary is flush. Small on-bar labels show the current amount (left, dark over the light current segment) and the amount to add (right, white over the green/gray add segment); a label is omitted when its segment is too narrow to hold it. In **Fill To** mode a thin **red** vertical target line marks the target total, extending past the bar's top and bottom edges.
- The bar and readout refresh every 5 seconds as a heartbeat **and immediately when the displayed state changes** (the fuel-fill color flips, or a displayed value moves), throttled to stay within the touch-strip update cap — so the readout reacts fast to telemetry rather than lagging the 5-second timer. They also update immediately on any rotate/press/settings change.
- **Tap**: Runs the configured Touch Screen action (independent of the dial-button Press Action). Set to **None** to disable taps; the readout still shows.

### Button Press (keypad)

- The icon shows the mode-aware title, the same per-mode readout, and the continuous two-segment bar (with on-bar labels, and the red target line in Fill To mode). No rotation support on a plain keypad.
- **Press**: Runs the configured Press Action.

### Platform differences

| Controller          | Rotate | Touchscreen | Long-press |
| ------------------- | ------ | ----------- | ---------- |
| Elgato Stream Deck+ | Yes    | Yes         | Yes        |
| Mirabox knob        | Yes    | No          | No         |
| Plain keypad        | No     | No          | No         |

## Settings

| Setting           | Type     | Default             | Description                                                        |
| ----------------- | -------- | ------------------- | ------------------------------------------------------------------ |
| Mode              | Dropdown | Add Amount          | Whether the dial sets the amount to add or the target total        |
| Step Size         | Number   | 1                   | Amount the dialed value changes per detent, in the displayed unit  |
| Press Action      | Dropdown | Toggle Fueling      | What a short dial press (or keypad press) does                     |
| Long-Press Action | Dropdown | Clear Fueling       | What a long dial press does (Elgato only)                          |
| Touch Screen      | Dropdown | Toggle Fueling      | What a touch-strip tap does, or None to disable taps (Elgato only) |
| Units             | Dropdown | Auto (from iRacing) | Display unit for the readout and step                              |

### Mode Options

- **Add Amount** - The dial sets the amount of fuel to add over the full tank range. The add is fixed (it does not change as fuel burns); the readout shows `+<add> = <total>` with the total reflecting live burn
- **Fill To** - The dial sets the total you want in the tank after the stop, as a whole integer in the displayed unit. The amount to add (target − current) is kept topped up automatically (re-sent every 30 s) as fuel burns while fuel-fill is on; a red vertical target line marks the target on the bar

### Press / Touch Screen Action Options

- **Toggle Fueling** - Reads the live fuel-fill checkbox: requests the dialed amount when off, or clears it when on
- **Clear Fueling** - Clears the pending fuel request
- **Fill To Max** - A toggle that fills the tank to full capacity; invoking it again while already at full drops the amount to ~empty (1 L — the minimum the SDK can request). So repeatedly invoking it alternates full ↔ empty. No-op when capacity is unknown
- **None** (Touch Screen only) - A tap does nothing; the readout still shows

### Long-Press Action Options

- **Clear Fueling** - Clears the pending fuel request
- **Fill To Max** - Toggles between full capacity and ~empty (1 L), as in the Press Action
- **Toggle Fueling** - Requests or clears the fuel request based on the live fuel-fill state
- **None** - A long press does nothing; any press fires the Press Action on release

### Units Options

- **Auto (from iRacing)** - Follows iRacing's configured display units
- **Liters** - Always shows liters
- **Gallons** - Always shows gallons

## Icon States

The Fuel Dial icon is visually distinguishable from the Fuel Service icons. It shows the mode-aware title, the per-mode readout, and a continuous two-segment fuel bar beneath it (current fuel + fuel-to-add over capacity) with on-bar labels.

| State                     | Icon                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| Add Amount, fuel-fill on  | "Fuel: Add Amount" title, `+<add> = <total>`, neutral current segment + green add segment       |
| Add Amount, fuel-fill off | "Fuel: Add Amount" title, `+<add> = <total>`, neutral current segment + gray add segment        |
| Fill To                   | "Fuel: Fill To" title, `→ <target>`, two-segment bar + red vertical target line (overhangs bar) |
| Tank capacity unknown     | Readout shown; the bar falls back to the requested span                                         |

## Telemetry Integration

- Fueling on/off is derived from the live pit fuel-fill checkbox (`PitSvFlags` / `FuelFill`) on every event — never a sticky local flag — so Toggle alternates correctly with iRacing.
- The current fuel level is read from `FuelLevel` (the neutral first bar segment); the dialed value seeds from the live pit fuel request (`PitSvFuel`) on appear and re-seeds from telemetry when the user has not rotated recently.
- The tank capacity is read from session info (`DriverCarFuelMaxLtr × DriverCarMaxFuelPct`) and used to bound the dial range and cap the total; when unknown, only the lower bound (0) is enforced.
- The display unit follows iRacing's `DisplayUnits` when **Units** is set to Auto.

## Notes

- All communication uses the iRacing API (`pit.fuel` and `pit.clearFuel`) — there are no key bindings and no chat commands.
- The bar and readout refresh every 5 seconds as a heartbeat and immediately whenever the displayed state changes (fuel-fill color flip or a displayed value move), throttled to stay within the touch-strip update cap; they also update on rotate/press/settings. Telemetry ticks that don't change the displayed state update cached state without pushing a touch-strip update.
- In Fill To mode the request is recomputed and re-sent every 30 s while fuel-fill is on, so the target stays topped up as fuel burns; it is never re-armed while fuel-fill is off (the user's toggle-off is respected).
- The Long-Press Action and Touch Screen settings are hidden on Mirabox, where knobs cannot hold reliably and there is no touchscreen.
- Set Touch Screen to None for VR drivers who cannot see the touch strip — the dial and press still work, and the readout still renders.
