---
title: Fuel Dial
description: Set the pit-stop fuel-to-add amount from a Stream Deck+ dial with a live touch-strip readout.
sidebar:
  badge:
    text: "1 mode"
    variant: tip
---

Fuel Dial turns a Stream Deck+ dial into a fuel-to-add controller. Rotate to set how much fuel to add at your next pit stop, watch the live "target / capacity" readout on the touch strip, and tap or press to toggle, clear, or fill to the tank. It is the first action to support the Stream Deck+ dial and touchscreen since the dial rebuild — but it also works on a plain keypad button and on a Mirabox knob.

The rotation sets an **absolute** amount that is sent to iRacing and clamped to your car's tank capacity, so you can never request more fuel than the tank holds.

## Modes

This action has a single mode — there is no Mode dropdown in the Property Inspector.

### Fuel To Add

Rotate the dial to set the fuel-to-add target. Each detent changes the target by the configured step size, in your display units, and the new amount is sent to iRacing as an absolute fuel request, clamped to the car's tank capacity. A short press or touchscreen tap runs the configured **Press Action**; a long press or long touch (Elgato only) runs the configured **Long-Press Action**.

The touch strip and the keypad icon both show a live "<target> / <capacity> <unit>" readout with a fill bar that turns green while fueling is armed. When the car's tank capacity is unknown the capacity reads `--` and the fill bar stays empty.

#### Details

- **Method:** iRacing API
- **Dial:** Rotating adjusts the fuel-to-add target by the step size per detent; the value is sent as an absolute amount, clamped to the tank capacity
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the readout and fill bar reflect the live pit fuel request, the current display units, and the car's tank capacity

#### Controls

- **Elgato Stream Deck+** — dial rotation, a touchscreen readout, and a press (short or long). A touchscreen tap mimics the dial button.
- **Mirabox** — knob rotation and a press. There is no touchscreen and no reliable long-press, so the Long-Press Action and Touch Screen settings do not apply.
- **Plain keypad button** — press only (no rotation). The icon shows the current fuel-to-add value, and a press runs the Press Action.

#### Setting: Step Size

How much the fuel-to-add target changes per dial detent, in your display units. Defaults to `1`. A comma decimal separator is accepted and normalized to a period (e.g., `0,5` becomes `0.5`).

#### Setting: Press Action

What a short press or touchscreen tap does. Defaults to **Toggle Fueling**.

- **Toggle Fueling** (default) — Arms a fuel request for the current target if fueling is off, or clears the request if fueling is already armed.
- **Clear Fueling** — Clears the pending fuel request.
- **Fill To Max** — Sets the target to the full tank capacity and arms the request. Does nothing when the tank capacity is unknown.

#### Setting: Long-Press Action

What a long dial press or long touchscreen hold does. Defaults to **Clear Fueling**. This setting is Elgato-only — Mirabox knobs cannot hold reliably, so it is hidden there.

- **Clear Fueling** (default) — Clears the pending fuel request.
- **Fill To Max** — Sets the target to the full tank capacity and arms the request.
- **Toggle Fueling** — Arms or clears the fuel request for the current target.
- **None** — A long press does nothing; any press fires the Press Action on release.

#### Setting: Touch Screen

When enabled (the default), the touch strip shows the live fuel readout and accepts taps. Turn it off to stop the touchscreen readout and ignore taps — useful for VR drivers who can't see the strip. This setting is Elgato-only.

#### Setting: Units

The display unit for the readout and the step size. Defaults to **Auto (from iRacing)**.

- **Auto (from iRacing)** (default) — Follows iRacing's configured display units.
- **Liters** — Always shows liters.
- **Gallons** — Always shows gallons.
