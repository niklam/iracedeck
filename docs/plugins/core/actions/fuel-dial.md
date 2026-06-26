# Fuel Dial

Sets the pit-stop fuel from a Stream Deck+ dial with a live touch-strip readout. A bare turn adjusts fuel in **manual** mode and the autofuel lap margin in **autofuel** mode; the mode is derived live from telemetry, not stored. Five configurable gesture slots (Push, Long Press, Push + Turn, Tap Display, Long Touch) each run a fuel action.

## Properties

| Property             | Value                                              |
| -------------------- | -------------------------------------------------- |
| Action ID            | `com.iracedeck.sd.core.fuel-dial`                  |
| Type                 | +/-                                                |
| SDK Support          | Yes                                                |
| Encoder Support      | Yes                                                |
| Communication Method | iRacing API + Key binding (per gesture, see below) |

This is the first action to (re-)support a Stream Deck+ dial/encoder and touchscreen since the dial rebuild.

The fuel actions (Toggle Fueling, Toggle Full / No Fuel) and the bare-turn manual fuel use the **iRacing API** (`pit.fuel` / `pit.clearFuel`). Toggle Autofuel, and the bare-turn autofuel lap-margin adjustment, use **key bindings** (`fuelServiceToggleAutofuel`, `fuelServiceLapMarginIncrease` / `fuelServiceLapMarginDecrease`, shared with Fuel Service). Switch Mode talks to nothing — it only flips the action's own **Mode** setting.

## Behavior

### Modes (derived live from telemetry)

The action is **modal**, and the mode is read from live telemetry on every event — it is never a stored setting:

- **Manual** (`dpFuelAutoFillActive` off) — a bare turn adjusts the pit fuel (the Add Amount / Target Amount behavior below).
- **Autofuel** (`dpFuelAutoFillActive` on) — a bare turn adjusts the autofuel **lap margin** via the `fuelServiceLapMarginIncrease` / `fuelServiceLapMarginDecrease` key bindings, coalesced so a fast spin doesn't flood the black box. The readout settles a beat later from `PitSvFuel` (there is no margin value in telemetry).

The **Toggle Autofuel** gesture taps `fuelServiceToggleAutofuel` to flip between the two modes.

### Encoder (Dial)

- **Rotate (manual mode)**: Adjusts the dialed value by the step size per detent, in the displayed unit. The dial spans the full tank range (`0` to capacity) in both Mode settings:
  - **Add Amount** — the dialed value is the amount to add. The add is **fixed**: it does not change as fuel burns. The readout shows `+<add> = <total>` (e.g. `+20 = 65 L`), where the total reflects live fuel burn.
  - **Target Amount** — the dialed value is the desired **total** after the stop, kept a whole integer in the displayed unit. The amount to add (`target − current`, rounded up so you never finish under target) is sent to iRacing (`pit.fuel`) and is **recomputed continuously as fuel burns**, with the request updated whenever the whole-unit amount changes. The recompute and re-send only happen **while fueling is on** — when fueling is off the fuel amount is **not** updated (rotating still plans the new target; turning fueling on, or pressing, sends it). The readout shows `→ <target>` (e.g. `→ 65 L`).
- **Rotate (autofuel mode)**: Adjusts the autofuel lap margin (see Modes above).
- **Push** (short press, fires on `dialUp`): Runs the configured **Push** action. Default **Toggle Fueling**.
- **Long Press** (held dial button past the **Long-press threshold** — the global setting, default 500 ms — with no turn, fires on `dialUp`): Runs the configured **Long Press** action. Default **Toggle Autofuel** (blind-safe for VR). Available on all platforms.
- **Push + Turn** (a pressed rotation): Dispatches the configured bidirectional pair (clockwise → `cw` action, counter-clockwise → `ccw`). The Fuel Dial offers **Full / No Fuel** (CW fills the tank to full, CCW empties it — no fuel) or **None** (default). The pair convention is reusable by future dial actions (e.g. Traction Control coarse/fine).
- Press, long-press, and push+turn are classified at `dialUp` (a duration comparison, with a guard so a push+turn pre-empts both press actions) — there is no mid-hold timer.
- The touch-strip title and keypad title are a **mode/fuel-fill cue**: `Add Fuel` / `Fuel Target` in manual mode, `Autofuel` in autofuel mode, `FUEL OFF` when fuel-fill is off, `AUTO OFF` when autofuel is unavailable.

### Touchscreen (Elgato only)

- Always shows a live readout (per-mode, see below) with one continuous two-segment fuel bar over the tank capacity: the current fuel as a neutral first segment and the fuel-to-add butted onto it (green when fuel-fill is on, gray when off). In **manual** mode the add comes from the dialed value; in **autofuel** mode it comes from `PitSvFuel`. Only the outer corners are rounded; the current↔add boundary is flush. Small on-bar labels show the current amount (left, dark over the light current segment) and the amount to add (right, white over the green/gray add segment); a label is omitted when its segment is too narrow to hold it. In manual **Target Amount** mode a thin **red** vertical target line marks the target total, spanning the full bar height (confined to the bar); the target line is suppressed in autofuel mode.
- The bar and readout refresh every 5 seconds as a heartbeat **and immediately when the displayed state changes** (the fuel-fill color flips, or a displayed value moves), throttled to stay within the touch-strip update cap — so the readout reacts fast to telemetry rather than lagging the 5-second timer. They also update immediately on any rotate/press/settings change.
- **Tap Display** (touch-strip tap): Runs the configured **Tap Display** action (independent of the dial-button Push action). Default **None** (VR safety); the readout still shows.
- **Long Touch** (touch-strip long tap): Runs the configured **Long Touch** action. Default **None** (VR safety).

### Button Press (keypad)

- The icon shows the mode/fuel-fill cue title, the same per-mode readout, and the continuous two-segment bar (with on-bar labels, and the red target line in manual Target Amount mode). No rotation support on a plain keypad.
- **Press**: Runs the configured Push action.

### Platform differences

| Controller                 | Rotate | Push + Turn | Touchscreen (Tap Display / Long Touch) | Push | Long Press                                                            |
| -------------------------- | ------ | ----------- | -------------------------------------- | ---- | --------------------------------------------------------------------- |
| Elgato Stream Deck+        | Yes    | Yes         | Yes                                    | Yes  | Yes                                                                   |
| Mirabox knob               | Yes    | Yes         | No                                     | Yes  | Yes (degrades to a short press if the knob reports release instantly) |
| Ulanzi knob (Dial / D200X) | Yes    | Yes         | No                                     | Yes  | Yes (degrades to a short press if the knob reports release instantly) |
| Plain keypad               | No     | No          | No                                     | Yes  | No (no dial button)                                                   |

## Settings

| Setting     | Type     | Default             | Description                                                                   |
| ----------- | -------- | ------------------- | ----------------------------------------------------------------------------- |
| Mode        | Dropdown | Add Amount          | Whether a manual-mode turn sets the amount to add or the target total         |
| Step Size   | Number   | 1                   | Amount the dialed value changes per detent, in the displayed unit             |
| Push        | Dropdown | Toggle Fueling      | What a short dial press (or keypad press) does                                |
| Long Press  | Dropdown | Toggle Autofuel     | What a long dial press does                                                   |
| Push + Turn | Dropdown | None                | What a pressed rotation does — Full / No Fuel (CW fills, CCW empties) or None |
| Tap Display | Dropdown | None                | What a touch-strip tap does, or None to disable taps (Elgato only)            |
| Long Touch  | Dropdown | None                | What a touch-strip long tap does, or None to disable it (Elgato only)         |
| Units       | Dropdown | Auto (from iRacing) | Display unit for the readout and step                                         |

### Mode Options

- **Add Amount** - A manual-mode turn sets the amount of fuel to add over the full tank range. The add is fixed (it does not change as fuel burns); the readout shows `+<add> = <total>` with the total reflecting live burn
- **Target Amount** - A manual-mode turn sets the total you want in the tank after the stop, as a whole integer in the displayed unit. The amount to add (target − current, rounded up so you never finish under target) is recomputed continuously as fuel burns and the request is updated whenever the whole-unit amount changes, **while fuel-fill is on**; while fuel-fill is off the amount is **not** updated (rotating still plans the new target, and turning fueling on or pressing sends it). A red vertical target line marks the target on the bar (the on-strip/keypad title cue for this mode is still `Fuel Target`)

### Gesture Action Options (Push, Long Press, Tap Display, Long Touch)

- **Toggle Fueling** - Reads the live fuel-fill checkbox: requests the dialed amount when off, or clears it when on (iRacing API)
- **Toggle Full / No Fuel** - A toggle that fills the tank to full capacity; invoking it again while already at full sets it to **No Fuel** — the requested amount drops to 0, so no fuel is added. So repeatedly invoking it alternates full ↔ no fuel. No-op when capacity is unknown (iRacing API)
- **Toggle Autofuel** - Taps the `fuelServiceToggleAutofuel` key binding to switch the dial between manual and autofuel mode (key binding)
- **Switch Mode** - Flips the manual dial **Mode** between **Add Amount** and **Target Amount**, saved to the action's settings (no iRacing communication)
- **None** - The gesture does nothing; the readout still shows

### Push + Turn Options

- **None** (default) - A pressed rotation does nothing
- **Full / No Fuel** - Clockwise fills the tank to full; counter-clockwise empties it (no fuel)

### Units Options

- **Auto (from iRacing)** - Follows iRacing's configured display units
- **Liters** - Always shows liters
- **Gallons** - Always shows gallons

## Icon States

The Fuel Dial icon is visually distinguishable from the Fuel Service icons. It shows the mode/fuel-fill cue title, the per-mode readout, and a continuous two-segment fuel bar beneath it (current fuel + fuel-to-add over capacity) with on-bar labels.

| State                         | Icon                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| Manual Add Amount, fuel on    | "Add Fuel" title, `+<add> = <total>`, neutral current segment + green add segment              |
| Manual Target Amount, fuel on | "Fuel Target" title, `→ <target>`, two-segment bar + red vertical target line (within the bar) |
| Fuel-fill off (either mode)   | "FUEL OFF" title, readout shown, gray add segment (a text cue, not just gray)                  |
| Autofuel on                   | "Autofuel" title, `AUTO → <add> <unit>` (add sourced from `PitSvFuel`), no red target line     |
| Autofuel unavailable          | "AUTO OFF" title (red), dash readout, current segment only (`dpFuelAutoFillEnabled` is false)  |
| Tank capacity unknown         | Readout shown; the bar falls back to the requested span                                        |

## Telemetry Integration

- Fueling on/off is derived from the live pit fuel-fill checkbox (`PitSvFlags` / `FuelFill`) on every event — never a sticky local flag — so Toggle alternates correctly with iRacing.
- The current fuel level is read from `FuelLevel` (the neutral first bar segment); the dialed value seeds from the live pit fuel request (`PitSvFuel`) on appear and re-seeds from telemetry when the user has not rotated recently.
- The tank capacity is read from session info (`DriverCarFuelMaxLtr × DriverCarMaxFuelPct`) and used to bound the dial range and cap the total; when unknown, only the lower bound (0) is enforced.
- Manual vs autofuel mode is derived from `dpFuelAutoFillActive`; autofuel availability from `dpFuelAutoFillEnabled`. In autofuel mode the displayed add comes from `PitSvFuel` (open-loop — the lap margin is not in telemetry).
- The display unit follows iRacing's `DisplayUnits` when **Units** is set to Auto.

## Notes

- Communication is per gesture: the fuel actions (Toggle Fueling, Toggle Full / No Fuel) and the bare-turn manual fuel use the iRacing API (`pit.fuel` / `pit.clearFuel`); Toggle Autofuel and the bare-turn autofuel lap-margin adjustment use key bindings (`fuelServiceToggleAutofuel`, `fuelServiceLapMarginIncrease` / `fuelServiceLapMarginDecrease`); Switch Mode talks to nothing (it only flips the action's own Mode setting). No chat commands.
- The bar and readout refresh every 5 seconds as a heartbeat and immediately whenever the displayed state changes (fuel-fill color flip or a displayed value move), throttled to stay within the touch-strip update cap; they also update on rotate/press/settings. Telemetry ticks that don't change the displayed state update cached state without pushing a touch-strip update.
- In manual Target Amount mode the needed add (target − current, rounded up) is recomputed continuously as fuel burns and the request is updated whenever the whole-unit amount changes, **while fuel-fill is on**, so the target stays accurate; while fuel-fill is off the fuel amount is **not** updated (the user's toggle-off is respected — rotating still plans the target, and turning fueling on or pressing sends it). The round-up alone guarantees you finish at or above the target, so no safety buffer is needed.
- Press, long-press, and push+turn are classified at `dialUp` (a duration comparison plus a rotate guard), with no mid-hold timer — so they work on every platform. A long press is available on Mirabox too; if a particular knob reports release instantly, the hold simply degrades to a short press. The Long Press default (Toggle Autofuel) and the touch-slot defaults (None) are chosen so this degradation is harmless.
- The Tap Display and Long Touch settings are hidden on Mirabox/Ulanzi, which have no plugin touch strip.
- The touch slots (Tap Display, Long Touch) default to **None** for VR drivers who cannot see the touch strip — the dial and presses still work, and the readout still renders.
