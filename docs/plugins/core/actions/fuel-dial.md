# Fuel Dial

Sets the pit-stop fuel from a Stream Deck+ dial with a live touch-strip readout. The dial sets either the amount to add or the desired total after the stop, depending on the Dial Mode.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.fuel-dial` |
| Type | +/- |
| SDK Support | Yes |
| Encoder Support | Yes |
| Communication Method | iRacing API |

This is the first action to (re-)support a Stream Deck+ dial/encoder and touchscreen since the dial rebuild.

## Behavior

### Encoder (Dial)

- **Rotate**: Adjusts the dialed value by the step size per detent, in the displayed unit. In **Add amount** mode this is the amount to add; in **Target level** mode it is the desired total after the stop. The resulting amount to add is sent to iRacing (`pit.fuel`) and clamped to the remaining tank space.
- **Short press**: Runs the configured Press Action.
- **Long press** (Elgato only): Runs the configured Long-Press Action.

### Touchscreen (Elgato only)

- Always shows a live "<total> / <capacity> <unit>" readout (the total after the stop) with a two-segment fuel bar: the static current fuel as the first segment and the fuel-to-add butted onto it (green when fuel-fill is on, gray when off).
- **Tap**: Runs the configured Touch Screen action (independent of the dial-button Press Action). Set to **None** to disable taps; the readout still shows.

### Button Press (keypad)

- The icon shows the total after the stop with the same two-segment fuel bar (no rotation support on a plain keypad).
- **Press**: Runs the configured Press Action.

### Platform differences

| Controller | Rotate | Touchscreen | Long-press |
|------------|--------|-------------|------------|
| Elgato Stream Deck+ | Yes | Yes | Yes |
| Mirabox knob | Yes | No | No |
| Plain keypad | No | No | No |

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Dial Mode | Dropdown | Add amount | Whether the dial sets the amount to add or the target total |
| Step Size | Number | 1 | Amount the dialed value changes per detent, in the displayed unit |
| Press Action | Dropdown | Toggle Fueling | What a short dial press (or keypad press) does |
| Long-Press Action | Dropdown | Clear Fueling | What a long dial press does (Elgato only) |
| Touch Screen | Dropdown | Toggle Fueling | What a touch-strip tap does, or None to disable taps (Elgato only) |
| Units | Dropdown | Auto (from iRacing) | Display unit for the readout and step |

### Dial Mode Options
- **Add amount** - The dial sets the amount of fuel to add; the request is clamped to the remaining tank space
- **Target level** - The dial sets the total you want in the tank after the stop. The amount to add (target − current) is rounded up so the stop never finishes under target, and is kept topped up automatically (re-sent every 30 s) as fuel burns while fuel-fill is on

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

The Fuel Dial icon uses a distinct dial/knob motif so it is visually distinguishable from the Fuel Service icons. It shows the total after the stop with a two-segment fuel bar beneath it (current fuel + fuel-to-add over capacity).

| State | Icon |
|-------|------|
| Fuel-fill on | "FUEL" title, total value, current segment + green add segment |
| Fuel-fill off | "FUEL" title, total value, current segment + gray add segment |
| Tank capacity unknown | Total shown; touch-strip readout shows `--` for the capacity |

## Telemetry Integration

- Fueling on/off is derived from the live pit fuel-fill checkbox (`PitSvFlags` / `FuelFill`) on every event — never a sticky local flag — so Toggle alternates correctly with iRacing.
- The current fuel level is read from `FuelLevel` (the static first bar segment); the dialed value seeds from the live pit fuel request (`PitSvFuel`) on appear and re-seeds from telemetry when the user has not rotated recently.
- The tank capacity is read from session info (`DriverCarFuelMaxLtr × DriverCarMaxFuelPct`) and used to clamp the amount to add and cap the total; when unknown, only the lower bound (0) is enforced.
- The display unit follows iRacing's `DisplayUnits` when **Units** is set to Auto.

## Notes

- All communication uses the iRacing API (`pit.fuel` and `pit.clearFuel`) — there are no key bindings and no chat commands.
- In Target level mode the request is recomputed and re-sent every 30 s while fuel-fill is on, so the target stays topped up as fuel burns; it is never re-armed while fuel-fill is off (the user's toggle-off is respected).
- The Long-Press Action and Touch Screen settings are hidden on Mirabox, where knobs cannot hold reliably and there is no touchscreen.
- Set Touch Screen to None for VR drivers who cannot see the touch strip — the dial and press still work, and the readout still renders.
