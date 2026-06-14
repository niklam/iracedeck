---
title: Fuel Dial
description: Set pit-stop fuel from a Stream Deck+ dial with a live touch-strip readout.
sidebar:
  badge:
    text: "1 mode"
    variant: tip
---

Fuel Dial turns a Stream Deck+ dial into a fuel controller. Choose whether the dial sets the **amount to add** or the **total you want after the stop**, watch the live "total / capacity" readout with a two-segment fuel bar on the touch strip, and tap or press to toggle, clear, or fill the tank. It is the first action to support the Stream Deck+ dial and touchscreen since the dial rebuild — but it also works on a plain keypad button and on a Mirabox knob.

The amount sent to iRacing is always clamped to the remaining tank space, so you can never request more fuel than the tank holds.

## Modes

This action has a single mode — there is no Mode dropdown in the Property Inspector.

### Fuel

Rotate the dial to set the fuel value. Each detent changes it by the configured step size, in your display units. In **Add amount** mode the dialed value is the amount to add; in **Target level** mode it is the desired total after the stop, and the amount to add (target − current) is rounded up so the stop never finishes under target. The resulting amount is sent to iRacing and clamped to the remaining tank space. A short press runs the configured **Press Action**, a long press (Elgato only) runs the **Long-Press Action**, and a touch-strip tap runs the **Touch Screen** action.

The touch strip always shows a live "<total> / <capacity> <unit>" readout (the total after the stop) with a two-segment fuel bar: the current fuel as a static first segment and the fuel-to-add butted onto it — green when fuel-fill is on, gray when off. The keypad icon shows the same total and bar. When the car's tank capacity is unknown the capacity reads `--`.

#### Details

- **Method:** iRacing API
- **Dial:** Rotating adjusts the dialed value by the step size per detent (amount to add, or target total); the resulting add is sent and clamped to the remaining tank space
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the readout and bar reflect the live fuel level, the pit fuel request, the fuel-fill checkbox state, the display units, and the tank capacity

#### Controls

- **Elgato Stream Deck+** — dial rotation, a touchscreen readout that always shows, and a press (short or long). A touchscreen tap runs its own configured Touch Screen action.
- **Mirabox** — knob rotation and a press. There is no touchscreen and no reliable long-press, so the Long-Press Action and Touch Screen settings do not apply.
- **Plain keypad button** — press only (no rotation). The icon shows the total after the stop, and a press runs the Press Action.

#### Setting: Dial Mode

Whether the dial sets the amount to add or the desired total. Defaults to **Add amount**.

- **Add amount** (default) — The dial sets how much fuel to add; the request is clamped to the remaining tank space.
- **Target level** — The dial sets the total you want in the tank after the stop. The add (target − current) is rounded up so the stop never finishes under target, and it is kept topped up automatically (re-sent every 30 seconds) as fuel burns while fuel-fill is on. It is never re-armed while fuel-fill is off.

#### Setting: Step Size

How much the dialed value changes per dial detent, in your display units. Defaults to `1`. A comma decimal separator is accepted and normalized to a period (e.g., `0,5` becomes `0.5`).

#### Setting: Press Action

What a short dial press (or keypad press) does. Defaults to **Toggle Fueling**.

- **Toggle Fueling** (default) — Reads the live fuel-fill checkbox: requests the dialed amount when fueling is off, or clears the request when it is on.
- **Clear Fueling** — Clears the pending fuel request.
- **Fill To Max** — Fills the tank to capacity. Does nothing when the tank capacity is unknown.

#### Setting: Long-Press Action

What a long dial press does. Defaults to **Clear Fueling**. This setting is Elgato-only — Mirabox knobs cannot hold reliably, so it is hidden there.

- **Clear Fueling** (default) — Clears the pending fuel request.
- **Fill To Max** — Fills the tank to capacity.
- **Toggle Fueling** — Requests or clears the fuel request based on the live fuel-fill state.
- **None** — A long press does nothing; any press fires the Press Action on release.

#### Setting: Touch Screen

What a touch-strip tap does. Defaults to **Toggle Fueling**. The fuel readout always shows on the touch strip; this setting only controls taps. Set it to **None** to ignore taps — useful for VR drivers who can't see the strip. This setting is Elgato-only.

- **Toggle Fueling** (default) — Requests the dialed amount or clears the request based on the live fuel-fill state.
- **Clear Fueling** — Clears the pending fuel request.
- **Fill To Max** — Fills the tank to capacity.
- **None** — A tap does nothing; the readout still shows.

#### Setting: Units

The display unit for the readout and the step size. Defaults to **Auto (from iRacing)**.

- **Auto (from iRacing)** (default) — Follows iRacing's configured display units.
- **Liters** — Always shows liters.
- **Gallons** — Always shows gallons.
