---
title: Splits & Reference
description: Cycle splits delta modes, toggle reference car, mark custom sectors, and use active reset.
sidebar:
  badge:
    text: "6 modes"
    variant: tip
---

Switch between iRacing's split-time delta display modes, toggle the reference car display, mark custom sector start and end points, or use active reset to practice specific track sections without leaving the cockpit. Placed on a **Stream Deck+ dial**, the same action becomes a splits-delta cycle dial — turning steps through the delta modes and pressing toggles the reference car — see [On a dial](#on-a-dial) below.

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector.

### Cycle Splits Delta

Cycle through iRacing's splits delta display modes. Pressing the button sends the direction chosen in the **Direction** setting.

#### Details

- **Method:** Key binding
- **Dial:** Rotating cycles the delta modes (clockwise = next, counter-clockwise = previous) — see [On a dial](#on-a-dial) below
- **Default binding:** Depends on the selected direction — see the **Direction** setting below
- **Telemetry-aware icon:** No

#### Setting: Direction

Which splits delta hotkey the button press sends. Both directions are globally configurable.

- **Next** (default `Tab`) — Advance to the next splits delta mode
- **Previous** (default `Shift+Tab`) — Go back to the previous splits delta mode

---

### Toggle Reference Car

Toggle the reference car overlay on or off. Replaces the old "Display Reference Car" option from the Toggle UI Elements action.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Ctrl+C`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Custom Sector Start

Mark the start point for a custom sector on the current lap.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Custom Sector End

Mark the end point for a custom sector on the current lap. Together with **Custom Sector Start**, this defines a user-chosen section you can compare against.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Set Active Reset Point

Save the current car state — position, speed, temperatures — as a reset snapshot. Solo practice sessions only.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Reset to Start Point

Teleport the car back to the saved active reset snapshot. Solo practice sessions only.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

## On a dial

Placed on a Stream Deck+ dial, Splits & Reference becomes a splits-delta cycle dial. Turning the dial steps through iRacing's delta display modes — one detent per mode — using the same **Next** and **Previous** key bindings the keypad **Cycle Splits Delta** mode uses, so no extra configuration is needed if you already use them. It has a single rotation behaviour, so there is no dial **Setting** dropdown; the Property Inspector automatically shows the dial gesture options (instead of the keypad Mode and Direction) when the instance sits on a dial. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

#### Details

- **Method:** Key binding — the same **Next** / **Previous** bindings the keypad Cycle Splits Delta mode uses. Configure them in the **Related Key Bindings** section; the Property Inspector shows a status line indicating whether each is set.
- **Dial:** Rotating cycles the delta modes (clockwise = next, counter-clockwise = previous), scaled by how fast you turn and capped at five modes per flick. Both the Next and Previous key bindings must be set.
- **Telemetry-aware:** No — iRacing exposes no telemetry for the currently selected splits mode, so the touch strip shows the action identity only (a `DELTA` label), never a live value.

#### Controls

- **Elgato Stream Deck+** — dial rotation, a configurable press, and a static touchscreen label.

Dials are currently Stream Deck+ only — the action can't be placed on Mirabox knobs or Ulanzi dials yet (see [Dials](/docs/features/dials/)).

#### Touch strip

The touch strip shows a color-coded "dash box" with just a `DELTA` label — iRacing publishes no value for the selected splits mode, so there is nothing live to display. You can override the border, label, value, and background colors in the **Dash Box Appearance** section of the dial settings.

#### Press and touch gestures

The dial press and touchscreen taps each run a configurable gesture, chosen from every one-shot mode the keypad surface offers beyond **Cycle Splits Delta** — **Toggle Reference Car**, **Custom Sector Start**, **Custom Sector End**, **Set Active Reset Point**, **Reset to Start Point** — or **None**. Each gesture taps the same key binding as its keypad-mode counterpart (e.g. **Toggle Reference Car** taps `toggleUiDisplayRefCar`, **Custom Sector Start** taps `splitsDeltaCustomSectorStart`), so nothing the keypad can do in one press is unreachable from the dial:

- **Press Action** (default *Toggle Reference Car*) — a short press.
- **Long Press** (default *None*) — a press held past the long-press threshold.
- **Tap Display** and **Long Touch** (default *None*, Elgato only) — a tap or long touch on the touch strip.

A push-and-turn (rotating while holding the dial in) cycles modes without firing the press gesture.
