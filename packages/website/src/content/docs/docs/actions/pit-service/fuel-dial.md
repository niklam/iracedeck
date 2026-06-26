---
title: Fuel Dial
description: Set pit-stop fuel from a Stream Deck+ dial with a live touch-strip readout.
sidebar:
  badge:
    text: "1 mode"
    variant: tip
---

Fuel Dial turns a Stream Deck+ dial into a fuel controller. A bare turn adjusts fuel — and when autofuel is engaged in iRacing, it adjusts the autofuel lap margin instead. Five configurable gesture slots (Push, Long Press, Push + Turn, Tap Display, Long Touch) each run a fuel action, you watch the live readout with a continuous two-segment fuel bar on the touch strip, and the dial works on a plain keypad button and on a Mirabox knob too.

The dial is **modal**, read live from iRacing — never a stored setting. In **manual** mode a bare turn sets fuel; in **autofuel** mode (iRacing's autofuel is on) a bare turn adjusts the autofuel lap margin. The two manual sub-modes are deliberately distinct: **Add Amount** dials a fixed amount to add over the full tank range and shows `+<add> = <total>` (the total reflects live fuel burn); **Target Amount** dials the whole-number total you want after the stop, marks it with a red target line on the bar, and recomputes the request continuously as fuel burns. The title — on the touch strip and the keypad icon — is a cue to the mode and fuel-fill state: `Add Fuel`, `Fuel Target`, `Autofuel`, `FUEL OFF`, or `AUTO OFF`.

## Modes

This action has a single mode — there is no Mode dropdown in the Property Inspector. The manual / autofuel behaviour switches automatically based on iRacing's autofuel state.

### Fuel

Rotate the dial to set the fuel value over the full tank range. Each detent changes it by the configured step size, in your display units. In **manual** mode and **Add Amount** sub-mode the dialed value is the (fixed) amount to add; in **Target Amount** it is the desired total after the stop, kept a whole integer in your display units, and the amount to add (target − current, rounded up so you never finish under target) is recomputed continuously as fuel burns and the request is updated whenever the whole-unit amount changes, while fueling is on — when fueling is off the fuel amount is not updated (rotating still plans the new target, and turning fueling on or pressing sends it). When iRacing's **autofuel** is engaged, a bare turn instead adjusts the autofuel lap margin (coalesced so a fast spin doesn't flood the black box).

A short press runs the configured **Push** action, a long press runs the **Long Press** action (default **Toggle Autofuel**), a pressed rotation runs **Push + Turn** (Full / No Fuel — clockwise fills, counter-clockwise empties — or None), a touch-strip tap runs **Tap Display**, and a touch-strip long tap runs **Long Touch**. For how these dial gestures work in general — including how the long press is timed and why the touch gestures default off — see [Dials](/docs/features/dials/).

The touch strip always shows a live per-mode readout — `+<add> = <total>` in Add Amount, `→ <target>` in Target Amount, `AUTO → <add>` in autofuel — with one continuous two-segment fuel bar: the current fuel as a neutral first segment and the fuel-to-add butted onto it (green when fuel-fill is on, gray when off). Only the outer corners are rounded; the boundary between the two is flush. Small on-bar labels show the current amount (left, dark over the light current segment) and the amount to add (right, white over the green/gray add segment); a label is dropped when its segment is too narrow to hold it. Manual Target Amount adds a thin **red** vertical target line that spans the full bar height (confined to the bar); autofuel suppresses it. The bar and readout refresh every 5 seconds as a heartbeat and react immediately when the displayed state changes — the fuel-fill color flips, or a displayed value moves — so the readout tracks telemetry without the up-to-5-second lag (throttled to stay within the touch-strip update cap). They also update instantly on any rotate, press, or settings change. The keypad icon shows the same title cue, readout, and bar.

#### Details

- **Method:** iRacing API for the fuel actions (Toggle Fueling, Toggle Full / No Fuel) and the bare-turn manual fuel; Key binding for Toggle Autofuel and the bare-turn autofuel lap-margin adjustment; Switch Mode changes the action's own setting only (no iRacing communication)
- **Dial:** In manual mode, rotating adjusts the dialed value by the step size per detent over the full tank range (amount to add, or target total); in Target Amount the resulting add (target − current, rounded up) is recomputed continuously as fuel burns, while fueling is on. In autofuel mode, rotating adjusts the autofuel lap margin via key bindings
- **Default binding:** No keyboard binding for the fuel actions; the autofuel toggle and lap-margin use the shared Fuel Service bindings (`fuelServiceToggleAutofuel`, `fuelServiceLapMarginIncrease` / `fuelServiceLapMarginDecrease`)
- **Telemetry-aware icon:** Yes — the readout and bar reflect the live fuel level, the pit fuel request, the fuel-fill checkbox state, the autofuel state, the display units, and the tank capacity, refreshed every 5 seconds and immediately when the displayed state changes

#### Controls

- **Elgato Stream Deck+** — dial rotation, a touchscreen readout that always shows, and a press (short or long). A touchscreen tap or long tap runs its own configured Tap Display / Long Touch action.
- **Mirabox** — knob rotation and a press (short or long). There is no touchscreen, so the Tap Display and Long Touch settings do not apply; the long press works, degrading to a short press only if a particular knob reports release instantly.
- **Plain keypad button** — press only (no rotation). The icon shows the readout, and a press runs the Push action.

#### Setting: Mode

Whether a manual-mode turn sets the amount to add or the desired total. Defaults to **Add Amount**. (In autofuel mode a turn adjusts the lap margin regardless of this setting.)

- **Add Amount** (default) — The dial sets how much fuel to add over the full tank range. The add is fixed: it does not change as fuel burns. The readout shows `+<add> = <total>`, and the total reflects live fuel burn.
- **Target Amount** — The dial sets the whole-number total you want in the tank after the stop. The add (target − current, rounded up so you never finish under target) is recomputed continuously as fuel burns and the request is updated whenever the whole-unit amount changes, **while fuel-fill is on**. While fuel-fill is off the fuel amount is **not** updated — rotating still plans the target, and turning fueling on or pressing sends it. A red vertical target line marks the target on the bar (the on-strip title for this mode reads `Fuel Target`). The round-up alone keeps you at or above the target, so no safety buffer is needed.

#### Setting: Step Size

How much the dialed value changes per dial detent, in your display units. Defaults to `1`. A comma decimal separator is accepted and normalized to a period (e.g., `0,5` becomes `0.5`).

#### Setting: Push

What a short dial press (or keypad press) does. Defaults to **Toggle Fueling**.

- **Toggle Fueling** (default) — Reads the live fuel-fill checkbox: requests the dialed amount when fueling is off, or clears the request when it is on.
- **Toggle Full / No Fuel** — A toggle: fills the tank to full capacity, and invoking it again while already full sets it to **No Fuel** — the requested amount drops to 0, so no fuel is added. Repeatedly invoking it alternates full ↔ no fuel. Does nothing when the tank capacity is unknown.
- **Toggle Autofuel** — Switches the dial between manual and autofuel mode (taps iRacing's autofuel toggle binding).
- **Switch Mode** — Flips the manual dial **Mode** between **Add Amount** and **Target Amount** (saved to the action's settings). Sends nothing to iRacing.
- **None** — The press does nothing; the readout still shows.

#### Setting: Long Press

What a long dial press does. Defaults to **Toggle Autofuel** — a blind-safe default for VR, since you can change fuel mode without looking at the strip. Available on all platforms; a long press is classified when you release the dial button, so on a Mirabox knob that reports release instantly it simply behaves like a short press.

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

What a touch-strip tap does. Defaults to **None**. The fuel readout always shows on the touch strip; this setting only controls taps. Leaving it **None** keeps the strip read-only — the safe choice for VR drivers who can't see it. This setting is Elgato-only (Mirabox and Ulanzi have no plugin touch strip).

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

The display unit for the readout and the step size. Defaults to **Auto (from iRacing)**.

- **Auto (from iRacing)** (default) — Follows iRacing's configured display units.
- **Liters** — Always shows liters.
- **Gallons** — Always shows gallons.
