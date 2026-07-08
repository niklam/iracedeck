---
title: Setup Fuel
description: Adjust in-car fuel settings including mixture, fuel cut position, and FCY mode during a session.
sidebar:
  badge:
    text: "7 modes"
    variant: tip
---

Adjust in-car fuel settings from the cockpit: fuel mixture, fuel cut position, disable fuel cut, low fuel accept, and full-course yellow mode. These are live car adjustments, not pit service fuel requests.

## View sub-modes

The **View …** entries turn the key into a continuously updating display of the current value in the car. With **dual-press** enabled (default) the same key also adjusts the value: a short press fires one direction and a long press fires the opposite — so one key replaces the separate Increase / Decrease keys you'd otherwise need.

| View setting | Telemetry source | Format | Typical range |
|---|---|---|---|
| View Fuel Mixture | `dcFuelMixture` | integer | car-dependent slot |
| View Fuel Cut Position | `dcFuelCutPosition` | integer | car-dependent slot |

### Dual-press control

Each View sub-mode exposes a single extra setting in the Property Inspector:

- **Enable dual-press** (default *on*) — when off, the key stays a pure read-only display and presses do nothing. When on, presses dispatch to the matching adjustment binding (e.g. View Fuel Mixture dispatches to *Fuel Mixture +* / *Fuel Mixture −*), so configure those bindings in the **Global Settings → Setup Fuel** section.

The tap direction is a single plugin-wide setting under **Global Common Settings → Dual-Press → Directions** (default *Tap increases, long-press decreases*; the long-press always fires the opposite of the tap). The threshold separating "short" from "long" is a sibling setting **Long-press threshold (ms)** (200–2000 ms, default 500 ms). Both take effect on the next press without needing a restart.

## Modes

Select the mode from the **Setting** dropdown in the Property Inspector. Directional modes (Fuel Mixture, Fuel Cut Position) also expose a **Direction** setting for Increase / Decrease.

### Fuel Mixture

Adjust the fuel / air mixture setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Fuel Mixture + and Fuel Mixture - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the mixture
- **Decrease** — Pressing the button lowers the mixture

---

### Fuel Cut Position

Adjust the fuel cut position setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Fuel Cut Position + and Fuel Cut Position - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### Disable Fuel Cut

Toggle the fuel cut disable setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Low Fuel Accept

Accept the low fuel warning dialog that appears in some series.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### FCY Mode Toggle

Toggle full-course yellow mode on or off.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

## Key Styles — paired +/− buttons

Adjustment modes with a live value (on Setup Fuel: Fuel Mixture and Fuel Cut Position) can render as **paired keys**: place two keys with opposite directions next to each other (or three, with a View key in the middle) and both show the live value — no separate display key needed. Choose the look under **Key Style**:

- **Legacy (arrows)** — the classic static arrow icon (default for existing keys).
- **Split** — label on top, live value in the middle, a big +/− below (default for newly placed keys).
- **Edge chevrons**, **Joined pill** — alternative value-showing pair looks.
- **Big +/−**, **Big chevrons**, **Pill end** — no-value styles for the outer keys of a 3-key group; the View key in the middle shows the value (set its **Display Style** to *Pill middle* to span the pill across all three keys).

Values are shown without units for maximum size. **Edge chevrons**, **Joined pill**, **Pill end**, and **Big chevrons** take a **Position in Pair** setting (*Auto* follows the direction: increase right, decrease left; pick *Top*/*Bottom* for vertical stacks). Holding a paired key repeats the adjustment until released. Colors follow the normal color overrides (the +/− accent is the *Graphic 1* slot); pill styles disable the normal border — the pill itself is the frame.
