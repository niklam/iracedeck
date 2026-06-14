---
title: Fuel Dial
description: Set pit-stop fuel from a Stream Deck+ dial with a live touch-strip readout.
sidebar:
  badge:
    text: "1 mode"
    variant: tip
---

Fuel Dial turns a Stream Deck+ dial into a fuel controller. Choose whether the dial sets the **amount to add** or the **total you want after the stop**, watch the live readout with a continuous two-segment fuel bar on the touch strip, and tap or press to toggle, clear, or fill the tank. It is the first action to support the Stream Deck+ dial and touchscreen since the dial rebuild — but it also works on a plain keypad button and on a Mirabox knob.

The two modes are deliberately distinct. **Add Amount** dials a fixed amount to add over the full tank range and shows `+<add> = <total>` (the total reflects live fuel burn). **Fill To** dials the whole-number total you want after the stop, marks it with a red target line on the bar, and automatically tops the request up as fuel burns. The title — on the touch strip and the keypad icon — is mode-aware: `Fuel: Add Amount` or `Fuel: Fill To`.

## Modes

This action has a single mode — there is no Mode dropdown in the Property Inspector.

### Fuel

Rotate the dial to set the fuel value over the full tank range. Each detent changes it by the configured step size, in your display units. In **Add Amount** mode the dialed value is the (fixed) amount to add; in **Fill To** mode it is the desired total after the stop, kept a whole integer in your display units, and the amount to add (target − current) auto-recomputes as fuel burns. A short press runs the configured **Press Action**, a long press (Elgato only) runs the **Long-Press Action**, and a touch-strip tap runs the **Touch Screen** action.

The touch strip always shows a live per-mode readout — `+<add> = <total>` in Add Amount, `→ <target>` in Fill To — with one continuous two-segment fuel bar: the current fuel as a neutral first segment and the fuel-to-add butted onto it (green when fuel-fill is on, gray when off). Only the outer corners are rounded; the boundary between the two is flush. Small on-bar labels show the current amount (left, dark over the light current segment) and the amount to add (right, white over the green/gray add segment); a label is dropped when its segment is too narrow to hold it. Fill To adds a thin **red** vertical target line that extends past the top and bottom of the bar. The bar and readout refresh every 5 seconds as a heartbeat and react immediately when the displayed state changes — the fuel-fill color flips, or a displayed value moves — so the readout tracks telemetry without the up-to-5-second lag (throttled to stay within the touch-strip update cap). They also update instantly on any rotate, press, or settings change. The keypad icon shows the same mode-aware title, readout, and bar.

#### Details

- **Method:** iRacing API
- **Dial:** Rotating adjusts the dialed value by the step size per detent over the full tank range (amount to add, or target total); in Fill To mode the resulting add auto-recomputes as fuel burns
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the readout and bar reflect the live fuel level, the pit fuel request, the fuel-fill checkbox state, the display units, and the tank capacity, refreshed every 5 seconds and immediately when the displayed state changes

#### Controls

- **Elgato Stream Deck+** — dial rotation, a touchscreen readout that always shows, and a press (short or long). A touchscreen tap runs its own configured Touch Screen action.
- **Mirabox** — knob rotation and a press. There is no touchscreen and no reliable long-press, so the Long-Press Action and Touch Screen settings do not apply.
- **Plain keypad button** — press only (no rotation). The icon shows the total after the stop, and a press runs the Press Action.

#### Setting: Mode

Whether the dial sets the amount to add or the desired total. Defaults to **Add Amount**.

- **Add Amount** (default) — The dial sets how much fuel to add over the full tank range. The add is fixed: it does not change as fuel burns. The readout shows `+<add> = <total>`, and the total reflects live fuel burn.
- **Fill To** — The dial sets the whole-number total you want in the tank after the stop. The add (target − current) is kept topped up automatically (re-sent every 30 seconds) as fuel burns while fuel-fill is on, and a red vertical target line marks the target on the bar. It is never re-armed while fuel-fill is off.

#### Setting: Step Size

How much the dialed value changes per dial detent, in your display units. Defaults to `1`. A comma decimal separator is accepted and normalized to a period (e.g., `0,5` becomes `0.5`).

#### Setting: Press Action

What a short dial press (or keypad press) does. Defaults to **Toggle Fueling**.

- **Toggle Fueling** (default) — Reads the live fuel-fill checkbox: requests the dialed amount when fueling is off, or clears the request when it is on.
- **Clear Fueling** — Clears the pending fuel request.
- **Fill To Max** — A toggle: fills the tank to full capacity, and invoking it again while already full drops the amount to ~empty (1 L — the smallest fill the SDK can request). Repeatedly invoking it alternates full ↔ empty. Does nothing when the tank capacity is unknown.

#### Setting: Long-Press Action

What a long dial press does. Defaults to **Clear Fueling**. This setting is Elgato-only — Mirabox knobs cannot hold reliably, so it is hidden there.

- **Clear Fueling** (default) — Clears the pending fuel request.
- **Fill To Max** — Toggles between full capacity and ~empty (1 L), as in the Press Action.
- **Toggle Fueling** — Requests or clears the fuel request based on the live fuel-fill state.
- **None** — A long press does nothing; any press fires the Press Action on release.

#### Setting: Touch Screen

What a touch-strip tap does. Defaults to **Toggle Fueling**. The fuel readout always shows on the touch strip; this setting only controls taps. Set it to **None** to ignore taps — useful for VR drivers who can't see the strip. This setting is Elgato-only.

- **Toggle Fueling** (default) — Requests the dialed amount or clears the request based on the live fuel-fill state.
- **Clear Fueling** — Clears the pending fuel request.
- **Fill To Max** — Toggles between full capacity and ~empty (1 L), as in the Press Action.
- **None** — A tap does nothing; the readout still shows.

#### Setting: Units

The display unit for the readout and the step size. Defaults to **Auto (from iRacing)**.

- **Auto (from iRacing)** (default) — Follows iRacing's configured display units.
- **Liters** — Always shows liters.
- **Gallons** — Always shows gallons.
