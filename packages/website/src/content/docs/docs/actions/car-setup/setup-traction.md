---
title: Setup Traction
description: Adjust traction control settings across multiple TC slots during a session.
sidebar:
  badge:
    text: "9 modes"
    variant: tip
---

Adjust traction control from the cockpit: toggle TC on or off, and step the four independent TC slot levels.

## View sub-modes

The **View TC1 / TC2 / TC3 / TC4** entries turn the key into a continuously updating display of the slot's current value. With **dual-press** enabled (default) the same key also adjusts that slot: a short press fires one direction and a long press fires the opposite — so one key replaces the separate Increase / Decrease keys you'd otherwise need.

| View setting | Telemetry source | Format | Typical range |
|---|---|---|---|
| View TC1 | `dcTractionControl` | integer | 0–10 slot |
| View TC2 | `dcTractionControl2` | integer | 0–10 slot |
| View TC3 | `dcTractionControl3` | integer | 0–10 slot |
| View TC4 | `dcTractionControl4` | integer | 0–10 slot |

Slot 1 is the canonical `dcTractionControl` field iRacing exposes for every TC-equipped car. Slots 2–4 are populated on cars that have multiple TC presets; cars that only have a single TC value render "---" for the higher slots.

### Dual-press control

Each View sub-mode exposes a single extra setting in the Property Inspector:

- **Enable dual-press** (default *on*) — when off, the key stays a pure read-only display and presses do nothing. When on, presses dispatch to the matching adjustment binding (e.g. View TC1 dispatches to *TC Slot 1 +* / *TC Slot 1 −*), so configure those bindings in the **Global Settings → Setup Traction** section.

The tap direction is a single plugin-wide setting under **Global Common Settings → Dual-Press → Directions** (default *Tap increases, long-press decreases*; the long-press always fires the opposite of the tap). The threshold separating "short" from "long" is a sibling setting **Long-press threshold (ms)** (200–2000 ms, default 500 ms). Both take effect on the next press without needing a restart.

## Modes

Select the mode from the **Setting** dropdown in the Property Inspector. TC1–TC4 modes expose a **Direction** setting for Increase / Decrease; TC Toggle does not.

### TC Toggle

Toggle traction control on or off.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### TC1

Adjust TC slot 1.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both TC1 + and TC1 - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### TC2

Adjust TC slot 2.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both TC2 + and TC2 - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### TC3

Adjust TC slot 3.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both TC3 + and TC3 - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### TC4

Adjust TC slot 4.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both TC4 + and TC4 - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value
