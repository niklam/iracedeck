# Fuel Dial

Sets the pit-stop fuel-to-add amount from a Stream Deck+ dial with a live touch-strip readout.

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

- **Rotate**: Adjusts the fuel-to-add target by the step size per detent, in the displayed unit. The new amount is sent to iRacing as an absolute fuel request (`pit.fuel`) and clamped to the car's tank capacity.
- **Short press**: Runs the configured Press Action.
- **Long press** (Elgato only): Runs the configured Long-Press Action.

### Touchscreen (Elgato only)

- Shows a live "<target> / <capacity> <unit>" readout with a fill bar.
- **Tap**: Mimics the dial button — runs the configured Press Action.
- **Long touch**: Runs the configured Long-Press Action.

### Button Press (keypad)

- The icon shows the current fuel-to-add value with a fill bar (no rotation support on a plain keypad).
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
| Step Size | Number | 1 | Amount the target changes per detent, in the displayed unit |
| Press Action | Dropdown | Toggle Fueling | What a short press or touchscreen tap does |
| Long-Press Action | Dropdown | Clear Fueling | What a long dial press or long touch does (Elgato only) |
| Touch Screen | Checkbox | Checked | Show the fuel readout on the touch strip (Elgato only) |
| Units | Dropdown | Auto (from iRacing) | Display unit for the readout and step |

### Press Action Options
- **Toggle Fueling** - Arms a fuel request for the current target, or clears it if already armed
- **Clear Fueling** - Clears the pending fuel request
- **Fill To Max** - Sets the target to the full tank capacity and arms the request (no-op when capacity is unknown)

### Long-Press Action Options
- **Clear Fueling** - Clears the pending fuel request
- **Fill To Max** - Sets the target to the full tank capacity and arms the request
- **Toggle Fueling** - Arms or clears the fuel request for the current target
- **None** - A long press does nothing; any press fires the Press Action on release

### Units Options
- **Auto (from iRacing)** - Follows iRacing's configured display units
- **Liters** - Always shows liters
- **Gallons** - Always shows gallons

## Icon States

The Fuel Dial icon uses a distinct dial/knob motif so it is visually distinguishable from the Fuel Service icons. It shows the current fuel-to-add value with a fill bar beneath it.

| State | Icon |
|-------|------|
| Fueling armed | "FUEL" title, current value, green fill bar |
| Fueling not armed | "FUEL" title, current value, gray fill bar |
| Tank capacity unknown | Value shown with an empty fill bar; touch-strip readout shows `--` for the capacity |

## Telemetry Integration

- The target seeds from the live pit fuel request (`PitSvFuel`) on appear and re-seeds from telemetry when the user has not rotated recently, so the readout stays in sync with iRacing.
- The tank capacity is read from session info (`DriverCarFuelMaxLtr × DriverCarMaxFuelPct`) and used to clamp the target and drive the fill bar; when unknown, only the lower bound (0) is enforced.
- The display unit follows iRacing's `DisplayUnits` when **Units** is set to Auto.

## Notes

- All communication uses the iRacing API (`pit.fuel` absolute set and `pit.clearFuel`) — there are no key bindings and no chat commands.
- The rotation sets an **absolute** fuel amount, not a relative add/reduce; it is always clamped to the car's tank capacity.
- The Long-Press Action and Touch Screen settings are hidden on Mirabox, where knobs cannot hold reliably and there is no touchscreen.
- Disable the touch screen for VR drivers who cannot see the touch strip — the dial and press still work.
