---
title: Setup Hybrid
description: Control hybrid system settings including MGU-K regen, deploy modes, and HYS boost/regen during a session.
sidebar:
  badge:
    text: "9 modes"
    variant: tip
---

Control hybrid energy recovery and deployment settings from the cockpit: MGU-K regeneration gain, deploy mode, fixed deploy level, HYS (Hybrid System) boost, HYS regen, and the HYS no-boost toggle.

## View sub-modes

The **View …** entries turn the key into a continuously updating display of the current value in the car. With **dual-press** enabled (default) the same key also adjusts the value: a short press fires one direction and a long press fires the opposite — so one key replaces the separate Increase / Decrease keys you'd otherwise need.

| View setting | Telemetry source | Format | Typical range |
|---|---|---|---|
| View MGU-K Deploy Mode | `dcMGUKDeployMode` | integer | 0–4 |
| View MGU-K Regen Gain | `dcMGUKRegenGain` | integer | car-dependent slot |
| View MGU-K Deploy Fixed | `dcMGUKDeployFixed` | integer | car-dependent slot |

### Dual-press control

Each View sub-mode exposes a single extra setting in the Property Inspector:

- **Enable dual-press** (default *on*) — when off, the key stays a pure read-only display and presses do nothing. When on, presses dispatch to the matching adjustment binding (e.g. View MGU-K Regen Gain dispatches to *MGU-K Regen Gain +* / *MGU-K Regen Gain −*), so configure those bindings in the **Global Settings → Setup Hybrid** section.

The tap direction is a single plugin-wide setting under **Global Common Settings → Dual-Press → Directions** (default *Tap increases, long-press decreases*; the long-press always fires the opposite of the tap). The threshold separating "short" from "long" is a sibling setting **Long-press threshold (ms)** (200–2000 ms, default 500 ms). Both take effect on the next press without needing a restart.

## Modes

Select the mode from the **Setting** dropdown in the Property Inspector. Directional modes (MGU-K Re-Gen Gain, MGU-K Deploy Mode, MGU-K Fixed Deploy) also expose a **Direction** setting for Increase / Decrease. HYS Boost and HYS Regen use a hold pattern — the key is held while the button is pressed and released when you release it.

### MGU-K Re-Gen Gain

Adjust the MGU-K regeneration gain.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both MGU-K Re-Gen Gain + and MGU-K Re-Gen Gain - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the regen gain
- **Decrease** — Pressing the button lowers the regen gain

---

### MGU-K Deploy Mode

Step through the MGU-K deploy modes.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both MGU-K Deploy Mode + and MGU-K Deploy Mode - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button advances to the next deploy mode
- **Decrease** — Pressing the button goes back to the previous deploy mode

---

### MGU-K Fixed Deploy

Adjust the fixed MGU-K deployment level.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both MGU-K Fixed Deploy + and MGU-K Fixed Deploy - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the deploy level
- **Decrease** — Pressing the button lowers the deploy level

---

### HYS Boost

Hold the HYS boost key for as long as the button is pressed. Release the button to stop boosting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### HYS Regen

Hold the HYS regen key for as long as the button is pressed. Release the button to stop regenerating.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### HYS No Boost

Toggle the "no boost" mode on or off.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

## Key Styles — paired +/− buttons

Adjustment modes with a live value (on Setup Hybrid: MGU-K Deploy Mode, MGU-K Re-Gen Gain, and MGU-K Fixed Deploy) can render as **paired keys**: place two keys with opposite directions next to each other (or three, with a View key in the middle) and both show the live value — no separate display key needed. Choose the look under **Key Style**:

- **Legacy (arrows)** — the classic static arrow icon (default for existing keys).
- **Split** — label on top, live value in the middle, a big +/− below (default for newly placed keys).
- **Corner badge**, **Ghost +/−**, **Edge chevrons**, **Joined pill** — alternative value-showing pair looks.
- **Big +/−**, **Big chevrons**, **Pill end** — no-value styles for the outer keys of a 3-key group; the View key in the middle shows the value (set its **Display Style** to *Pill middle* to span the pill across all three keys).

Values are shown without units for maximum size. **Edge chevrons**, **Joined pill**, **Pill end**, and **Big chevrons** take a **Position in Pair** setting (*Auto* follows the direction: increase right, decrease left; pick *Top*/*Bottom* for vertical stacks). Holding a paired key repeats the adjustment until released. Colors follow the normal color overrides (the +/− accent is the *Graphic 1* slot); pill styles disable the normal border — the pill itself is the frame.
