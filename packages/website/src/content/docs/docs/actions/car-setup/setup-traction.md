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

The **View TC1 / TC2 / TC3 / TC4** entries are read-only live readouts. Each pairs with the corresponding adjustment entry in the dropdown — handy for placing a value readout next to the same slot's +/- keys. No Direction, no key fires on press.

| View setting | Telemetry source | Format | Typical range |
|---|---|---|---|
| View TC1 | `dcTractionControl` | integer | 0–10 slot |
| View TC2 | `dcTractionControl2` | integer | 0–10 slot |
| View TC3 | `dcTractionControl3` | integer | 0–10 slot |
| View TC4 | `dcTractionControl4` | integer | 0–10 slot |

Slot 1 is the canonical `dcTractionControl` field iRacing exposes for every TC-equipped car. Slots 2–4 are populated on cars that have multiple TC presets; cars that only have a single TC value render "---" for the higher slots.

## Modes

Select the mode from the **Setting** dropdown in the Property Inspector. TC1–TC4 modes expose a **Direction** setting for Increase / Decrease; TC Toggle does not.

### TC Toggle

Toggle traction control on or off.

#### Details

- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### TC1

Adjust TC slot 1.

#### Details

- **Dial:** Rotation adjusts TC slot 1 (clockwise = increase, counter-clockwise = decrease), regardless of the Direction setting
- **Default binding:** No default key binding — both TC1 + and TC1 - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### TC2

Adjust TC slot 2.

#### Details

- **Dial:** Rotation adjusts TC slot 2 (clockwise = increase, counter-clockwise = decrease), regardless of the Direction setting
- **Default binding:** No default key binding — both TC2 + and TC2 - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### TC3

Adjust TC slot 3.

#### Details

- **Dial:** Rotation adjusts TC slot 3 (clockwise = increase, counter-clockwise = decrease), regardless of the Direction setting
- **Default binding:** No default key binding — both TC3 + and TC3 - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### TC4

Adjust TC slot 4.

#### Details

- **Dial:** Rotation adjusts TC slot 4 (clockwise = increase, counter-clockwise = decrease), regardless of the Direction setting
- **Default binding:** No default key binding — both TC4 + and TC4 - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value
