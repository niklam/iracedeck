# Fuel Dial

Sets the pit-stop fuel from a Stream Deck+ dial with a live touch-strip readout. The dial sets either the amount to add or the desired total after the stop, depending on the Dial Mode.

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
  - **Add amount** — the dialed value is the amount to add. The add is **fixed**: it does not change as fuel burns. The readout shows `+<add> = <total>` (e.g. `+20 = 65 L`), where the total reflects live fuel burn.
  - **Target level** — the dialed value is the desired **total** after the stop, kept a whole integer in the displayed unit. The amount to add (`target − current`) is sent to iRacing (`pit.fuel`) and **auto-recomputes** as fuel burns. The readout shows `→ <target>` (e.g. `→ 65 L`).
- **Short press**: Runs the configured Press Action.
- **Long press** (Elgato only): Runs the configured Long-Press Action.

### Touchscreen (Elgato only)

- Always shows a live readout (per-mode, see above) with one continuous two-segment fuel bar over the tank capacity: the current fuel as a neutral first segment and the fuel-to-add butted onto it (green when fuel-fill is on, gray when off). Only the outer corners are rounded; the current↔add boundary is flush. Small on-bar labels show the current amount (left) and the amount to add (right). In **Target level** mode a thin vertical "locked" line marks the target total on the bar.
- The bar and readout refresh every 5 seconds to track live fuel burn (plus immediately on any rotate/press/settings change), staying within the touch-strip update cap.
- **Tap**: Runs the configured Touch Screen action (independent of the dial-button Press Action). Set to **None** to disable taps; the readout still shows.

### Button Press (keypad)

- The icon shows the same per-mode readout and continuous two-segment bar (with on-bar labels, and the target line in Target level mode). No rotation support on a plain keypad.
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
| Dial Mode         | Dropdown | Add amount          | Whether the dial sets the amount to add or the target total        |
| Step Size         | Number   | 1                   | Amount the dialed value changes per detent, in the displayed unit  |
| Press Action      | Dropdown | Toggle Fueling      | What a short dial press (or keypad press) does                     |
| Long-Press Action | Dropdown | Clear Fueling       | What a long dial press does (Elgato only)                          |
| Touch Screen      | Dropdown | Toggle Fueling      | What a touch-strip tap does, or None to disable taps (Elgato only) |
| Units             | Dropdown | Auto (from iRacing) | Display unit for the readout and step                              |

### Dial Mode Options

- **Add amount** - The dial sets the amount of fuel to add over the full tank range. The add is fixed (it does not change as fuel burns); the readout shows `+<add> = <total>` with the total reflecting live burn
- **Target level** - The dial sets the total you want in the tank after the stop, as a whole integer in the displayed unit. The amount to add (target − current) is kept topped up automatically (re-sent every 30 s) as fuel burns while fuel-fill is on; a vertical "locked" line marks the target on the bar

### Press / Touch Screen Action Options

- **Toggle Fueling** - Reads the live fuel-fill checkbox: requests the dialed amount when off, or clears it when on
- **Clear Fueling** - Clears the pending fuel request
- **Fill To Max** - Fills the tank to capacity (no-op when capacity is unknown)
- **None** (Touch Screen only) - A tap does nothing; the readout still shows

### Long-Press Action Options

- **Clear Fueling** - Clears the pending fuel request
- **Fill To Max** - Fills the tank to capacity
- **Toggle Fueling** - Requests or clears the fuel request based on the live fuel-fill state
- **None** - A long press does nothing; any press fires the Press Action on release

### Units Options

- **Auto (from iRacing)** - Follows iRacing's configured display units
- **Liters** - Always shows liters
- **Gallons** - Always shows gallons

## Icon States

The Fuel Dial icon is visually distinguishable from the Fuel Service icons. It shows the per-mode readout with a continuous two-segment fuel bar beneath it (current fuel + fuel-to-add over capacity) with on-bar labels.

| State                     | Icon                                                                          |
| ------------------------- | ----------------------------------------------------------------------------- |
| Add amount, fuel-fill on  | "FUEL" title, `+<add> = <total>`, neutral current segment + green add segment |
| Add amount, fuel-fill off | "FUEL" title, `+<add> = <total>`, neutral current segment + gray add segment  |
| Target level              | "FUEL" title, `→ <target>`, two-segment bar + vertical "locked" target line   |
| Tank capacity unknown     | Readout shown; the bar falls back to the requested span                       |

## Telemetry Integration

- Fueling on/off is derived from the live pit fuel-fill checkbox (`PitSvFlags` / `FuelFill`) on every event — never a sticky local flag — so Toggle alternates correctly with iRacing.
- The current fuel level is read from `FuelLevel` (the neutral first bar segment); the dialed value seeds from the live pit fuel request (`PitSvFuel`) on appear and re-seeds from telemetry when the user has not rotated recently.
- The tank capacity is read from session info (`DriverCarFuelMaxLtr × DriverCarMaxFuelPct`) and used to bound the dial range and cap the total; when unknown, only the lower bound (0) is enforced.
- The display unit follows iRacing's `DisplayUnits` when **Units** is set to Auto.

## Notes

- All communication uses the iRacing API (`pit.fuel` and `pit.clearFuel`) — there are no key bindings and no chat commands.
- The bar and readout refresh every 5 seconds (plus immediately on rotate/press/settings) to track live fuel burn without exceeding the touch-strip update cap; telemetry ticks update cached state but do not push a touch-strip update on every tick.
- In Target level mode the request is recomputed and re-sent every 30 s while fuel-fill is on, so the target stays topped up as fuel burns; it is never re-armed while fuel-fill is off (the user's toggle-off is respected).
- The Long-Press Action and Touch Screen settings are hidden on Mirabox, where knobs cannot hold reliably and there is no touchscreen.
- Set Touch Screen to None for VR drivers who cannot see the touch strip — the dial and press still work, and the readout still renders.
