---
title: Setup Chassis
description: Adjust chassis setup options — differential, anti-roll bars, springs, shocks, and power steering — during a session.
sidebar:
  badge:
    text: "22 modes"
    variant: tip
---

Adjust chassis setup options from the cockpit: differential curves, anti-roll bars, spring preloads, shock absorbers, and power steering.

## View sub-modes

The **View …** entries turn the key into a continuously updating display of the current value in the car. With **dual-press** enabled (default) the same key also adjusts the value: a short press fires one direction and a long press fires the opposite — so one key replaces the separate Increase / Decrease keys you'd otherwise need.

| View setting | Telemetry source | Format | Typical range |
|---|---|---|---|
| View Diff Preload | `dcDiffPreload` | integer | car-dependent slot |
| View Diff Entry | `dcDiffEntry` | integer | car-dependent slot |
| View Diff Middle | `dcDiffMiddle` | integer | car-dependent slot |
| View Diff Exit | `dcDiffExit` | integer | car-dependent slot |
| View Anti-Roll Front | `dcAntiRollFront` | integer | car-dependent slot |
| View Anti-Roll Rear | `dcAntiRollRear` | integer | car-dependent slot |
| View Power Steering | `dcPowerSteering` | integer | car-dependent slot |
| View Weight Jacker Left | `dcWeightJackerLeft` | signed percent | ±a few % |
| View Weight Jacker Right | `dcWeightJackerRight` | signed percent | ±a few % |

### Dual-press control

Each View sub-mode exposes a single extra setting in the Property Inspector:

- **Enable dual-press** (default *on*) — when off, the key stays a pure read-only display and presses do nothing. When on, presses dispatch to the matching adjustment binding (e.g. View Diff Preload dispatches to *Diff Preload +* / *Diff Preload −*), so configure those bindings in the **Global Settings → Setup Chassis** section. Weight Jacker Left / Right do not appear as adjustment modes in the Setting dropdown; their +/- bindings still live in **Global Settings → Setup Chassis** so the View can drive them via dual-press.

The tap direction is a single plugin-wide setting under **Global Common Settings → Dual-Press → Directions** (default *Tap increases, long-press decreases*; the long-press always fires the opposite of the tap). The threshold separating "short" from "long" is a sibling setting **Long-press threshold (ms)** (200–2000 ms, default 500 ms). Both take effect on the next press without needing a restart.

## Modes

Select the mode from the **Setting** dropdown in the Property Inspector. **Adjust** modes are directional — pick **Increase** or **Decrease** in the **Direction** setting to control what a button press does. **View** modes show a live readout and, with **Enable dual-press** on (default), also accept short / long presses — see [View sub-modes](#view-sub-modes) above. They don't use the per-action **Direction** setting; the tap direction is the plugin-wide **Global Common Settings → Dual-Press → Directions**.

### Differential Preload

Adjust the differential preload value.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Diff Preload + and Diff Preload - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### Differential Entry

Adjust the differential entry (on-throttle) setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Diff Entry + and Diff Entry - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### Differential Middle

Adjust the differential middle (coasting) setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Diff Middle + and Diff Middle - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### Differential Exit

Adjust the differential exit setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Diff Exit + and Diff Exit - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### Front ARB

Adjust the front anti-roll bar stiffness.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Front ARB + and Front ARB - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button stiffens the ARB
- **Decrease** — Pressing the button softens the ARB

---

### Rear ARB

Adjust the rear anti-roll bar stiffness.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Rear ARB + and Rear ARB - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button stiffens the ARB
- **Decrease** — Pressing the button softens the ARB

---

### Left Spring

Adjust the left-side spring preload.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Left Spring + and Left Spring - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### Right Spring

Adjust the right-side spring preload.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Right Spring + and Right Spring - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### LF Shock

Adjust the left-front shock setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both LF Shock + and LF Shock - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### RF Shock

Adjust the right-front shock setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both RF Shock + and RF Shock - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### LR Shock

Adjust the left-rear shock setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both LR Shock + and LR Shock - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### RR Shock

Adjust the right-rear shock setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both RR Shock + and RR Shock - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### Power Steering

Adjust the power steering assist level.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Power Steering + and Power Steering - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the assist level
- **Decrease** — Pressing the button lowers the assist level

## Key Styles — paired +/− buttons

Adjustment modes with a live value (on Setup Chassis: Differential Preload, Differential Entry, Differential Middle, Differential Exit, Front ARB, Rear ARB, and Power Steering) can render as **paired keys**: place two keys with opposite directions next to each other (or three, with a View key in the middle) and both show the live value — no separate display key needed. Choose the look under **Key Style**:

- **Legacy (arrows)** — the classic static arrow icon (default for existing keys).
- **Split** — label on top, live value in the middle, a big +/− below (default for newly placed keys).
- **Corner badge**, **Ghost +/−**, **Edge chevrons**, **Joined pill** — alternative value-showing pair looks.
- **Big +/−**, **Big chevrons**, **Pill end** — no-value styles for the outer keys of a 3-key group; the View key in the middle shows the value (set its **Display Style** to *Pill middle* to span the pill across all three keys).

Values are shown without units for maximum size. **Edge chevrons**, **Joined pill**, **Pill end**, and **Big chevrons** take a **Position in Pair** setting (*Auto* follows the direction: increase right, decrease left; pick *Top*/*Bottom* for vertical stacks). Holding a paired key repeats the adjustment until released. Colors follow the normal color overrides (the +/− accent is the *Graphic 1* slot); pill styles disable the normal border — the pill itself is the frame.

Springs and shocks have no live telemetry value, so they stay legacy-only — no Key Style control appears for them. Weight Jacker Left / Right exist only as View sub-modes here; their Display Style dropdown offers the pill-middle options like any other View.
