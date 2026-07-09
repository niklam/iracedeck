---
title: Fuel Service
description: Control pit stop fuel amount, autofuel, and lap margin from a Stream Deck button or dial.
sidebar:
  badge:
    text: "8 modes + dial"
    variant: tip
---

Full control over your pit stop fueling strategy — from a button or a dial. On a regular key, pick a mode: toggle fuel fill with live telemetry feedback, adjust the fuel amount, toggle autofuel, or fine-tune the lap margin. Placed on a **Stream Deck+ dial**, the same action becomes a fuel controller with a live touch-strip readout — see [On a dial](#on-a-dial) below. Every fuel value goes through the iRacing API, so nothing ever opens the chat window.

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector. Modes apply to keypad instances; a dial instance uses the dial behavior described in [On a dial](#on-a-dial).

### Toggle Fuel Fill

Toggle the fuel fill checkbox on or off via the iRacing SDK. The icon shows the current refuel amount from telemetry (in your iRacing display units) with a green ON / red OFF status bar and a matching border color reflecting whether fuel fill is enabled.

#### Details

- **Method:** iRacing API
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — shows the current refuel amount and an on/off indicator driven by `PitSvFlags.FuelFill`

#### Setting: Show black box

Off by default. When enabled, pressing the key opens iRacing's Fuel black box so you can watch the value change — most useful for the autofuel lap margin, which no telemetry reports.

iRacing never reveals which black box is open, and a black box hotkey is a toggle, so iRaceDeck presses a different box first and then the Fuel box. Both keypresses are sent together as one keystroke, so iRacing almost always applies them in the same frame and you never see the first box. Very occasionally a single frame slips through and it flashes for an instant.

Requires keyboard bindings for the **Fuel** black box and at least one other black box — set them under **Related Key Bindings**. If either is missing, or is bound to a SimHub role instead of a key, the fuel value still changes but no black box opens.

---

### Add Fuel

Increase the pending fuel for the next pit stop. Pressing the button raises iRacing's fuel request by the configured amount (read against the live pit request, so repeated presses stack correctly). Holding the button repeats the add about four times a second.

#### Details

- **Method:** iRacing API
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** With Unit set to Auto, the label's unit follows your iRacing display units

#### Setting: Amount

The increment to add. Numeric — supports comma or period decimal separators (e.g., `1`, `2.5`, `0,5`). Defaults to `1`. iRacing banks fuel in whole liters, so the resulting request is rounded to an integer number of liters.

#### Setting: Unit

- **Auto (from iRacing)** (default) — Liters or gallons, following your iRacing display units
- **L** — Liters
- **GAL** — Gallons
- **KG** — Kilograms, converted via the car's fuel weight from session data

#### Setting: Show black box

Off by default. When enabled, pressing the key opens iRacing's Fuel black box so you can watch the value change — most useful for the autofuel lap margin, which no telemetry reports.

iRacing never reveals which black box is open, and a black box hotkey is a toggle, so iRaceDeck presses a different box first and then the Fuel box. Both keypresses are sent together as one keystroke, so iRacing almost always applies them in the same frame and you never see the first box. Very occasionally a single frame slips through and it flashes for an instant.

Requires keyboard bindings for the **Fuel** black box and at least one other black box — set them under **Related Key Bindings**. If either is missing, or is bound to a SimHub role instead of a key, the fuel value still changes but no black box opens.

---

### Reduce Fuel

Decrease the pending fuel for the next pit stop by the configured amount. Reducing to zero (or below) empties the fuel request entirely. Holding the button repeats the reduction about four times a second.

#### Details

- **Method:** iRacing API
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** With Unit set to Auto, the label's unit follows your iRacing display units

#### Setting: Amount

The decrement to subtract. Numeric — supports comma or period decimal separators. Defaults to `1`.

#### Setting: Unit

- **Auto (from iRacing)** (default) — Liters or gallons, following your iRacing display units
- **L** — Liters
- **GAL** — Gallons
- **KG** — Kilograms, converted via the car's fuel weight from session data

#### Setting: Show black box

Off by default. When enabled, pressing the key opens iRacing's Fuel black box so you can watch the value change — most useful for the autofuel lap margin, which no telemetry reports.

iRacing never reveals which black box is open, and a black box hotkey is a toggle, so iRaceDeck presses a different box first and then the Fuel box. Both keypresses are sent together as one keystroke, so iRacing almost always applies them in the same frame and you never see the first box. Very occasionally a single frame slips through and it flashes for an instant.

Requires keyboard bindings for the **Fuel** black box and at least one other black box — set them under **Related Key Bindings**. If either is missing, or is bound to a SimHub role instead of a key, the fuel value still changes but no black box opens.

---

### Set Fuel Amount

Set the pending fuel to an absolute value. Setting `0` empties the fuel request.

:::note
When the **Auto-enable fueling** global setting is off and your fuel fill checkbox is currently off, the action restores the checkbox to off right after adjusting the amount, so adjusting fuel never silently arms fueling. You don't need to do anything for this — it happens automatically based on your live pit service state. This applies to Add Fuel, Reduce Fuel, Set Fuel Amount, and the Lap Margin modes — button presses only; a fuel dial always arms fueling when turned.
:::

#### Details

- **Method:** iRacing API
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** With Unit set to Auto, the label's unit follows your iRacing display units

#### Setting: Amount

The target fuel amount. Numeric — supports comma or period decimal separators. Defaults to `1`.

#### Setting: Unit

- **Auto (from iRacing)** (default) — Liters or gallons, following your iRacing display units
- **L** — Liters
- **GAL** — Gallons
- **KG** — Kilograms, converted via the car's fuel weight from session data

#### Setting: Show black box

Off by default. When enabled, pressing the key opens iRacing's Fuel black box so you can watch the value change — most useful for the autofuel lap margin, which no telemetry reports.

iRacing never reveals which black box is open, and a black box hotkey is a toggle, so iRaceDeck presses a different box first and then the Fuel box. Both keypresses are sent together as one keystroke, so iRacing almost always applies them in the same frame and you never see the first box. Very occasionally a single frame slips through and it flashes for an instant.

Requires keyboard bindings for the **Fuel** black box and at least one other black box — set them under **Related Key Bindings**. If either is missing, or is bound to a SimHub role instead of a key, the fuel value still changes but no black box opens.

---

### Clear Fuel

Clear the pending fuel request via the iRacing SDK. Removes the fuel line from the pit service.

#### Details

- **Method:** iRacing API
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Show black box

Off by default. When enabled, pressing the key opens iRacing's Fuel black box so you can watch the value change — most useful for the autofuel lap margin, which no telemetry reports.

iRacing never reveals which black box is open, and a black box hotkey is a toggle, so iRaceDeck presses a different box first and then the Fuel box. Both keypresses are sent together as one keystroke, so iRacing almost always applies them in the same frame and you never see the first box. Very occasionally a single frame slips through and it flashes for an instant.

Requires keyboard bindings for the **Fuel** black box and at least one other black box — set them under **Related Key Bindings**. If either is missing, or is bound to a SimHub role instead of a key, the fuel value still changes but no black box opens.

---

### Toggle Autofuel

Toggle iRacing's autofuel checkbox on or off. The icon shows a green ON / red OFF status bar plus matching border color reflecting whether autofuel is active.

#### Details

- **Method:** Key binding
- **Default binding:** No default key binding
- **Telemetry-aware icon:** Yes — shows an on/off indicator driven by `dpFuelAutoFillActive`

#### Setting: Show black box

Off by default. When enabled, pressing the key opens iRacing's Fuel black box so you can watch the value change — most useful for the autofuel lap margin, which no telemetry reports.

iRacing never reveals which black box is open, and a black box hotkey is a toggle, so iRaceDeck presses a different box first and then the Fuel box. Both keypresses are sent together as one keystroke, so iRacing almost always applies them in the same frame and you never see the first box. Very occasionally a single frame slips through and it flashes for an instant.

Requires keyboard bindings for the **Fuel** black box and at least one other black box — set them under **Related Key Bindings**. If either is missing, or is bound to a SimHub role instead of a key, the fuel value still changes but no black box opens.

---

### Lap Margin Increase

Raise the autofuel lap margin by one. Pressing the button taps the iRacing "Lap Margin Increase" hotkey.

#### Details

- **Method:** Key binding
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Setting: Show black box

Off by default. When enabled, pressing the key opens iRacing's Fuel black box so you can watch the value change — most useful for the autofuel lap margin, which no telemetry reports.

iRacing never reveals which black box is open, and a black box hotkey is a toggle, so iRaceDeck presses a different box first and then the Fuel box. Both keypresses are sent together as one keystroke, so iRacing almost always applies them in the same frame and you never see the first box. Very occasionally a single frame slips through and it flashes for an instant.

Requires keyboard bindings for the **Fuel** black box and at least one other black box — set them under **Related Key Bindings**. If either is missing, or is bound to a SimHub role instead of a key, the fuel value still changes but no black box opens.

---

### Lap Margin Decrease

Lower the autofuel lap margin by one. Pressing the button taps the iRacing "Lap Margin Decrease" hotkey.

#### Details

- **Method:** Key binding
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Setting: Show black box

Off by default. When enabled, pressing the key opens iRacing's Fuel black box so you can watch the value change — most useful for the autofuel lap margin, which no telemetry reports.

iRacing never reveals which black box is open, and a black box hotkey is a toggle, so iRaceDeck presses a different box first and then the Fuel box. Both keypresses are sent together as one keystroke, so iRacing almost always applies them in the same frame and you never see the first box. Very occasionally a single frame slips through and it flashes for an instant.

Requires keyboard bindings for the **Fuel** black box and at least one other black box — set them under **Related Key Bindings**. If either is missing, or is bound to a SimHub role instead of a key, the fuel value still changes but no black box opens.

---

## On a dial

Placed on a Stream Deck+ dial, Fuel Service becomes a fuel controller: a bare turn adjusts fuel — and when autofuel is engaged in iRacing, it adjusts the autofuel lap margin instead. Five configurable gesture slots (Push, Long Press, Push + Turn, Tap Display, Long Touch) each run a fuel action, and you watch the live readout with a continuous two-segment fuel bar on the touch strip. The Property Inspector automatically shows the dial settings below (instead of the keypad Mode settings) when the instance sits on a dial.

The dial is **modal**, read live from iRacing — never a stored setting. In **manual** mode a bare turn sets fuel; in **autofuel** mode (iRacing's autofuel is on) a bare turn adjusts the autofuel lap margin. The two manual sub-modes are deliberately distinct: **Add Amount** dials a fixed amount to add over the full tank range and shows `+<add> = <total>`, where the displayed add is the fuel iRacing actually banked (read live from telemetry, not the dialed value) and the total reflects live fuel burn; **Target Amount** dials the whole-number total you want after the stop, marks it with a red target line on the bar, and recomputes the request continuously as fuel burns. Whether fueling is armed is unmistakable at a glance: a full-width status band across the top reads `REFUEL: ON` on green when the next stop takes fuel and `REFUEL: OFF` on red when it won't — with `AUTOFUEL: ON` / `AUTOFUEL: OFF` / a gray `AUTOFUEL: N/A` in autofuel mode — drawn across the top of the dial's touch-strip display.

Rotate the dial to set the fuel value over the full tank range. Each detent changes it by the configured step size, in your display units. In **manual** mode and **Add Amount** sub-mode the dialed value is the (fixed) amount to add; in **Target Amount** it is the desired total after the stop, kept a whole integer in your display units, and the amount to add (target − current, rounded up so you never finish under target) is recomputed continuously as fuel burns and the request is updated whenever the whole-unit amount changes, while fueling is on — when fueling is off the fuel amount is not updated (rotating still plans the new target, and turning fueling on or pressing sends it). When iRacing's **autofuel** is engaged, a bare turn instead adjusts the autofuel lap margin (coalesced so a fast spin doesn't flood the black box). Turning the dial always arms fueling — the **Auto-enable fueling** global applies to button presses only.

A short press runs the configured **Push** action, a long press runs the **Long Press** action (default **Toggle Autofuel**), a pressed rotation runs **Push + Turn** (Full / No Fuel — clockwise fills, counter-clockwise empties — or None), a touch-strip tap runs **Tap Display**, and a touch-strip long tap runs **Long Touch**. For how these dial gestures work in general — including how the long press is timed and why the touch gestures default off — see [Dials](/docs/features/dials/).

The touch-strip slot is drawn by the plugin as one full pixmap: a full-width **status band** across the top — **green** `REFUEL: ON` when fueling is armed, **red** `REFUEL: OFF` when it is not (that fuel will *not* be added), `AUTOFUEL: ON` / `AUTOFUEL: OFF` in autofuel mode, and a gray `AUTOFUEL: N/A` when autofuel is engaged but unavailable — the same color language as the toggle buttons' status bars, with the state always paired with the band text, never color alone. Below the band sit the live per-mode readout — `+<add> = <total>` in Add Amount, `→ <target>` in Target Amount, `AUTO → <add>` in autofuel — and one continuous two-segment fuel bar: the current fuel as a neutral first segment and the fuel-to-add butted onto it (green when fueling is on, gray otherwise — the band carries the loud state, the bar stays subtle). Only the outer corners are rounded; the boundary between the two segments is flush. Small on-bar labels show the current amount (left, dark over the light current segment) and the amount to add (right, white over the green/gray add segment); a label is dropped when its segment is too narrow to hold it. Manual Target Amount adds a thin **red** vertical target line that spans the full bar height (confined to the bar); autofuel suppresses it. The bar and readout refresh every 5 seconds as a heartbeat and react immediately when the displayed state changes — the fueling state flips, or a displayed value moves — so the readout tracks telemetry without the up-to-5-second lag (throttled to stay within the touch-strip update cap). They also update instantly on any rotate, press, or settings change.

#### Details

- **Method:** iRacing API for the fuel actions (Toggle Fueling, Toggle Full / No Fuel) and the bare-turn manual fuel; Key binding for Toggle Autofuel and the bare-turn autofuel lap-margin adjustment; Switch Mode changes the action's own setting only (no iRacing communication)
- **Dial:** In manual mode, rotating adjusts the dialed value by the step size per detent over the full tank range (amount to add, or target total); in Target Amount the resulting add (target − current, rounded up) is recomputed continuously as fuel burns, while fueling is on. In autofuel mode, rotating adjusts the autofuel lap margin via key bindings
- **Default binding:** No keyboard binding for the fuel actions; the autofuel toggle and lap-margin use the shared Fuel Service bindings (`fuelServiceToggleAutofuel`, `fuelServiceLapMarginIncrease` / `fuelServiceLapMarginDecrease`)
- **Telemetry-aware icon:** Yes — the readout and bar reflect the live fuel level, the pit fuel request, the fuel-fill checkbox state, the autofuel state, the display units, and the tank capacity, refreshed every 5 seconds and immediately when the displayed state changes

#### Controls

- **Elgato Stream Deck+** — dial rotation, Push + Turn, a touchscreen readout that always shows, and a press (short or long). A touchscreen tap or long tap runs its own configured Tap Display / Long Touch action.

Dials are currently Stream Deck+ only — the action can't be placed on Mirabox knobs or Ulanzi dials yet (see [Dials](/docs/features/dials/)).

#### Setting: Mode

Whether a manual-mode turn sets the amount to add or the desired total. Defaults to **Add Amount**. (In autofuel mode a turn adjusts the lap margin regardless of this setting.)

- **Add Amount** (default) — The dial sets how much fuel to add over the full tank range. The add is fixed: it does not change as fuel burns. The readout shows `+<add> = <total>`; the displayed add is read live from iRacing's pit request, so it shows what the game actually banked (after its whole-litre rounding) rather than the dialed figure — it never briefly shows the dialed amount and then resyncs. The total reflects live fuel burn.
- **Target Amount** — The dial sets the whole-number total you want in the tank after the stop. The add (target − current, rounded up so you never finish under target) is recomputed continuously as fuel burns and the request is updated whenever the whole-unit amount changes, **while fuel-fill is on**. While fuel-fill is off the fuel amount is **not** updated — rotating still plans the target, and turning fueling on or pressing sends it. A red vertical target line marks the target on the bar (the readout for this mode shows `→ <target>`). The round-up alone keeps you at or above the target, so no safety buffer is needed.

#### Setting: Amount (step size)

How much the dialed value changes per dial detent, in your display units. Defaults to `1`. A comma decimal separator is accepted and normalized to a period (e.g., `0,5` becomes `0.5`).

#### Setting: Push

What a short dial press does. Defaults to **Toggle Fueling**.

- **Toggle Fueling** (default) — Reads the live fuel-fill checkbox: requests the dialed amount when fueling is off, or clears the request when it is on.
- **Toggle Full / No Fuel** — A toggle: fills the tank to full capacity, and invoking it again while already full sets it to **No Fuel** — the requested amount drops to 0, so no fuel is added. Repeatedly invoking it alternates full ↔ no fuel. Does nothing when the tank capacity is unknown.
- **Toggle Autofuel** — Switches the dial between manual and autofuel mode (taps iRacing's autofuel toggle binding).
- **Switch Mode** — Flips the manual dial **Mode** between **Add Amount** and **Target Amount** (saved to the action's settings). Sends nothing to iRacing.
- **None** — The press does nothing; the readout still shows.

#### Setting: Long Press

What a long dial press does. Defaults to **Toggle Autofuel** — a blind-safe default for VR, since you can change fuel mode without looking at the strip. A long press is classified when you release the dial button.

- **Toggle Autofuel** (default) — Switches the dial between manual and autofuel mode.
- **Toggle Fueling** — Requests or clears the fuel request based on the live fuel-fill state.
- **Toggle Full / No Fuel** — Toggles between full capacity and No Fuel (no fuel added), as in the Push action.
- **Switch Mode** — Flips the manual dial **Mode** between **Add Amount** and **Target Amount**.
- **None** — A long press does nothing; any press fires the Push action on release.

#### Setting: Push + Turn

What a pressed rotation (push and turn together) does. Defaults to **None**.

- **None** (default) — A pressed rotation does nothing.
- **Full / No Fuel** — Clockwise fills the tank to full; counter-clockwise empties it (no fuel).

#### Setting: Tap Display

What a touch-strip tap does. Defaults to **None**. The fuel readout always shows on the touch strip; this setting only controls taps. Leaving it **None** keeps the strip read-only — the safe choice for VR drivers who can't see it. This setting is Elgato-only (Mirabox has no plugin touch strip).

- **None** (default) — A tap does nothing; the readout still shows.
- **Toggle Fueling** — Requests the dialed amount or clears the request based on the live fuel-fill state.
- **Toggle Full / No Fuel** — Toggles between full capacity and No Fuel (no fuel added), as in the Push action.
- **Toggle Autofuel** — Switches the dial between manual and autofuel mode.
- **Switch Mode** — Flips the manual dial **Mode** between **Add Amount** and **Target Amount**.

#### Setting: Long Touch

What a touch-strip long tap does. Defaults to **None**, for the same VR-safety reason as Tap Display. Elgato-only.

- **None** (default) — A long tap does nothing; the readout still shows.
- **Toggle Fueling** — Requests the dialed amount or clears the request based on the live fuel-fill state.
- **Toggle Full / No Fuel** — Toggles between full capacity and No Fuel (no fuel added), as in the Push action.
- **Toggle Autofuel** — Switches the dial between manual and autofuel mode.
- **Switch Mode** — Flips the manual dial **Mode** between **Add Amount** and **Target Amount**.

#### Setting: Units

The display unit for the readout and the step size — the same shared Unit setting as the keypad modes, without the kilogram option. Defaults to **Auto (from iRacing)**.

- **Auto (from iRacing)** (default) — Follows iRacing's configured display units.
- **Liters** — Always shows liters.
- **Gallons** — Always shows gallons.
