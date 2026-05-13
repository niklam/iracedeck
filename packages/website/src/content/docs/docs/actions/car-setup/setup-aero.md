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

The **View …** entries are read-only live readouts. No Direction, no key fires on press.

| View setting | Telemetry source | Format | Typical range |
|---|---|---|---|
| View Front Wing | `dcFrontWing` | integer | car-dependent slot or angle |
| View Rear Wing | `dcRearWing` | integer | car-dependent slot or angle |

Cars without a driver-adjustable wing render "---". Qualifying tape and the RF brake attachment toggle have no `dc*` telemetry on common cars, so they don't have View entries.

## Modes

Select the mode from the **Setting** dropdown in the Property Inspector. Directional modes also expose a **Direction** setting for Increase / Decrease.

### Front Wing

Adjust the front wing angle. The **Direction** setting picks whether pressing the button increases or decreases the angle.

#### Details

- **Dial:** Rotation adjusts the front wing (clockwise = increase, counter-clockwise = decrease), regardless of the Direction setting
- **Default binding:** No default key binding — both Front Wing + and Front Wing - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button increases the front wing angle
- **Decrease** — Pressing the button decreases the front wing angle

---

### Rear Wing

Adjust the rear wing angle. The **Direction** setting picks whether pressing the button increases or decreases the angle.

#### Details

- **Dial:** Rotation adjusts the rear wing (clockwise = increase, counter-clockwise = decrease), regardless of the Direction setting
- **Default binding:** No default key binding — both Rear Wing + and Rear Wing - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button increases the rear wing angle
- **Decrease** — Pressing the button decreases the rear wing angle

---

### Qualifying Tape

Adjust the amount of qualifying tape covering the radiators. The **Direction** setting picks whether pressing the button adds or removes tape.

#### Details

- **Dial:** Rotation adjusts qualifying tape (clockwise = more tape, counter-clockwise = less tape), regardless of the Direction setting
- **Default binding:** No default key binding — both Qualifying Tape + and Qualifying Tape - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button adds more tape
- **Decrease** — Pressing the button removes tape

---

### RF Brake Attached

Toggle the right-front brake attachment.

#### Details

- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings
