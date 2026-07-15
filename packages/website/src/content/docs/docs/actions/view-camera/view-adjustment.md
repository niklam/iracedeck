---
title: View Adjustment
description: Adjust FOV, horizon, driver height, VR centering, and UI size from your Stream Deck.
sidebar:
  badge:
    text: "5 modes"
    variant: tip
---

Tweak your in-car view settings without leaving the cockpit. Each mode maps to a specific view parameter so you can dial in the perfect perspective. Placed on a **Stream Deck+ dial**, the same action becomes a view-tuning dial — especially handy in VR, where you can adjust driver height and recenter the headset by feel — see [On a dial](#on-a-dial) below.

## Modes

Select the mode from the **Adjustment** dropdown in the Property Inspector. Directional modes (FOV, Horizon, Driver Height, UI Size) also expose a **Direction** setting for Increase / Decrease.

### FOV

Adjust the field of view.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `]` (increase) and `[` (decrease)
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button widens the field of view
- **Decrease** — Pressing the button narrows the field of view

---

### Horizon

Adjust the horizon line position.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Shift+]` (increase/up) and `Shift+[` (decrease/down)
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button moves the horizon line upward
- **Decrease** — Pressing the button moves the horizon line downward

---

### Driver Height

Adjust the driver eye position.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Ctrl+]` (increase/up) and `Ctrl+[` (decrease/down)
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the driver eye position
- **Decrease** — Pressing the button lowers the driver eye position

---

### Recenter VR

Re-center the VR headset view.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `;`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### UI Size

Adjust the in-sim UI element size.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Ctrl+PageUp` (increase) and `Ctrl+PageDown` (decrease)
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button makes UI elements larger
- **Decrease** — Pressing the button makes UI elements smaller

## On a dial

Placed on a Stream Deck+ dial, View Adjustment becomes a view-tuning dial — ideal in VR, where FOV and seating tune best by feel. Pick one value with the dial's **Setting** dropdown; turning the dial nudges it up or down in the sim, and a press recenters your VR headset. It uses the same key bindings as the keypad modes, so no extra configuration is needed if you already use them. The Property Inspector automatically shows the dial settings below (instead of the keypad Adjustment and Direction) when the instance sits on a dial. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

#### Details

- **Method:** Key binding — the same View Adjustment increase/decrease bindings the keypad modes use, plus the *Recenter VR* binding for the press gestures. Configure them in the **Related Key Bindings** section; the Property Inspector shows a status line indicating whether each is set.
- **Dial:** Rotating adjusts the selected value (clockwise = increase, counter-clockwise = decrease). Both the increase and decrease key bindings must be set.
- **Telemetry-aware:** No — iRacing exposes no value for FOV, horizon, driver height, or UI size, so the touch strip shows the setting's name only, not a live number.

#### Controls

- **Elgato Stream Deck+** — dial rotation, a press (short or long), and a touchscreen that names the selected setting. A touchscreen tap or long tap runs its own configured Tap Display / Long Touch action.

Dials are currently Stream Deck+ only — the action can't be placed on Mirabox knobs or Ulanzi dials yet (see [Dials](/docs/features/dials/)).

#### Setting: Setting

The view value the dial controls. Each renders as a color-coded "dash box" showing the setting's label — there is no value to display, since iRacing reports none. Each setting has a built-in accent color, but you can override the border, label, value, and background colors in the **Dash Box Appearance** section of the dial settings. Recenter VR isn't offered here — it's non-directional, so it's a press gesture instead.

| Setting | Label | Telemetry source | Shown as |
|---|---|---|---|
| FOV | FOV | None | label only |
| Horizon | HORIZON | None | label only |
| Driver Height | HEIGHT | None | label only |
| UI Size | UI SIZE | None | label only |

#### Setting: Press Action / Long Press

What a short or long press of the dial button does, chosen from:

- **Recenter VR** (default for **Press Action**; None for Long Press) — taps the View Adjustment *Recenter VR* binding. It's blind-safe (harmless if fired by accident) and the gesture a VR driver most wants under a finger, which is why it's the press default.
- **None** — does nothing.

A press is classified when you release the dial — a hold past the [Long-press threshold](/docs/features/dials/#the-long-press-threshold) fires the Long Press action. Turning the dial while pressed adjusts the value (a "push + turn") and never fires the press action.

#### Setting: Tap Display / Long Touch

Optional touch-strip gestures (Stream Deck+ only), each over { Recenter VR, None }. Both default to **None** for VR safety.
