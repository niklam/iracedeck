---
title: Setup Brakes
description: Adjust brake settings including ABS, brake bias, peak brake bias, engine braking, and more.
sidebar:
  badge:
    text: "13 modes"
    variant: tip
---

Adjust brake-related setup options from the cockpit — ABS level, brake bias (coarse and fine), peak brake bias, miscellaneous brake settings, and engine braking.

## View sub-modes

The **View …** entries at the top of the Setting dropdown turn the key into a continuously updating display of the current value in the car. With **dual-press** enabled (default) the same key also adjusts the value: a short press fires one direction and a long press fires the opposite — so one key replaces the separate Increase / Decrease keys you'd otherwise need.

| View setting | Telemetry source | Format | Typical range |
|---|---|---|---|
| View Brake Bias | `dcBrakeBias` | percent, 1 decimal | ~50–60% |
| View Brake Bias Fine | `dcBrakeBiasFine` | percent, 1 decimal | ~50–60% |
| View Peak Brake Bias | `dcPeakBrakeBias` | percent, 1 decimal | ~50–80% |
| View Brake Misc | `dcBrakeMisc` | integer | car-dependent |
| View Engine Braking | `dcEngineBraking` | integer | car-dependent slot |
| View ABS Adjust | `dcABS` | integer | car-dependent slot |

### Dual-press control

Each View sub-mode exposes a single extra setting in the Property Inspector:

- **Enable dual-press** (default *on*) — when off, the key stays a pure read-only display and presses do nothing. When on, presses dispatch to the matching adjustment binding (e.g. View Brake Bias dispatches to *Brake Bias +* / *Brake Bias −*), so configure those bindings in the **Global Settings → Setup Brakes** section.

The tap direction is a single plugin-wide setting under **Global Common Settings → Dual-Press → Directions** (default *Tap increases, long-press decreases*; the long-press always fires the opposite of the tap). The threshold separating "short" from "long" is a sibling setting **Long-press threshold (ms)** (200–2000 ms, default 500 ms). Both take effect on the next press without needing a restart.

## Modes

Select the mode from the **Setting** dropdown in the Property Inspector. Directional modes also expose a **Direction** setting for Increase / Decrease.

### ABS Toggle

Toggle ABS on or off.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### ABS Adjust

Step the ABS level up or down. The **Direction** setting picks whether pressing the button raises or lowers the level.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both ABS Adjust + and ABS Adjust - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the ABS level
- **Decrease** — Pressing the button lowers the ABS level

---

### Brake Bias

Shift the brake bias forward or rearward. The **Direction** setting picks whether pressing the button moves bias forward (increase) or rearward (decrease).

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `=` (increase) and `-` (decrease) — matches iRacing's default brake bias keys
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button shifts bias forward
- **Decrease** — Pressing the button shifts bias rearward

---

### Brake Bias Fine

Fine-adjust the brake bias in smaller increments than the main Brake Bias mode.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Brake Bias Fine + and Brake Bias Fine - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button shifts bias fine forward
- **Decrease** — Pressing the button shifts bias fine rearward

---

### Peak Brake Bias

Adjust the peak brake bias setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Peak Brake Bias + and Peak Brake Bias - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises peak brake bias
- **Decrease** — Pressing the button lowers peak brake bias

---

### Brake Misc

Adjust iRacing's "brake misc" catch-all setting. The exact effect depends on the car.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Brake Misc + and Brake Misc - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### Engine Braking

Adjust the engine braking level.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Engine Braking + and Engine Braking - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises engine braking
- **Decrease** — Pressing the button lowers engine braking
