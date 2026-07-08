---
title: Setup Aero
description: Adjust aerodynamic settings like front wing, rear wing, and qualifying tape during a session.
sidebar:
  badge:
    text: "6 modes"
    variant: tip
---

Adjust aerodynamic setup options from the cockpit — front and rear wing angles, qualifying tape, and the right-front brake attachment.

## View sub-modes

The **View …** entries turn the key into a continuously updating display of the current value in the car. With **dual-press** enabled (default) the same key also adjusts the value: a short press fires one direction and a long press fires the opposite — so one key replaces the separate Increase / Decrease keys you'd otherwise need.

| View setting | Telemetry source | Format | Typical range |
|---|---|---|---|
| View Front Wing | `dcFrontWing` | integer | car-dependent slot or angle |
| View Rear Wing | `dcRearWing` | integer | car-dependent slot or angle |

Cars without a driver-adjustable wing render "---". Qualifying tape and the RF brake attachment toggle have no `dc*` telemetry on common cars, so they don't have View entries.

### Dual-press control

Each View sub-mode exposes a single extra setting in the Property Inspector:

- **Enable dual-press** (default *on*) — when off, the key stays a pure read-only display and presses do nothing. When on, presses dispatch to the matching adjustment binding (e.g. View Front Wing dispatches to *Front Wing +* / *Front Wing −*), so configure those bindings in the **Global Settings → Setup Aero** section.

The tap direction is a single plugin-wide setting under **Global Common Settings → Dual-Press → Directions** (default *Tap increases, long-press decreases*; the long-press always fires the opposite of the tap). The threshold separating "short" from "long" is a sibling setting **Long-press threshold (ms)** (200–2000 ms, default 500 ms). Both take effect on the next press without needing a restart.

## Modes

Select the mode from the **Setting** dropdown in the Property Inspector. Directional modes also expose a **Direction** setting for Increase / Decrease.

### Front Wing

Adjust the front wing angle. The **Direction** setting picks whether pressing the button increases or decreases the angle.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Front Wing + and Front Wing - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button increases the front wing angle
- **Decrease** — Pressing the button decreases the front wing angle

---

### Rear Wing

Adjust the rear wing angle. The **Direction** setting picks whether pressing the button increases or decreases the angle.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Rear Wing + and Rear Wing - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button increases the rear wing angle
- **Decrease** — Pressing the button decreases the rear wing angle

---

### Qualifying Tape

Adjust the amount of qualifying tape covering the radiators. The **Direction** setting picks whether pressing the button adds or removes tape.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Qualifying Tape + and Qualifying Tape - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button adds more tape
- **Decrease** — Pressing the button removes tape

---

### RF Brake Attached

Toggle the right-front brake attachment.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

## Key Styles — paired +/− buttons

Adjustment modes with a live value (on Setup Aero: Front Wing and Rear Wing) can render as **paired keys**: place two keys with opposite directions next to each other (or three, with a View key in the middle) and both show the live value — no separate display key needed. Choose the look under **Key Style**:

- **Legacy (arrows)** — the classic static arrow icon (default for existing keys).
- **Split** — label on top, live value in the middle, a big +/− below (default for newly placed keys).
- **Edge chevrons**, **Joined pill** — alternative value-showing pair looks.
- **Big +/−**, **Big chevrons**, **Pill end** — no-value styles for the outer keys of a 3-key group; the View key in the middle shows the value (set its **Display Style** to *Pill middle* to span the pill across all three keys).

Values are shown without units for maximum size. **Edge chevrons**, **Joined pill**, **Pill end**, and **Big chevrons** take a **Position in Pair** setting (*Auto* follows the direction: increase right, decrease left; pick *Top*/*Bottom* for vertical stacks). Holding a paired key repeats the adjustment until released. Colors follow the normal color overrides (the +/− accent is the *Graphic 1* slot); pill styles disable the normal border — the pill itself is the frame.
