---
title: Setup Engine
description: Adjust engine settings including power, throttle shaping, boost level, and launch RPM during a session.
sidebar:
  badge:
    text: "7 modes"
    variant: tip
---

Adjust engine-related setup options from the cockpit: engine power, throttle shaping, boost level, and launch RPM.

## View sub-modes

The **View …** entries are read-only live readouts. No Direction, no key fires on press.

| View setting | Telemetry source | Format | Typical range |
|---|---|---|---|
| View Engine Power | `dcEnginePower` | integer | car-dependent slot |
| View Throttle Shape | `dcThrottleShape` | integer | car-dependent slot |
| View Launch RPM | `dcLaunchRPM` | integer | RPM |

## Modes

Select the mode from the **Setting** dropdown in the Property Inspector. **Adjust** modes are directional — pick **Increase** or **Decrease** in the **Direction** setting to control what a button press does. **View** modes are read-only and do not use Direction.

### Engine Power

Adjust the engine power setting.

#### Details

- **Dial:** Rotation adjusts engine power (clockwise = increase, counter-clockwise = decrease), regardless of the Direction setting
- **Default binding:** No default key binding — both Engine Power + and Engine Power - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises engine power
- **Decrease** — Pressing the button lowers engine power

---

### Throttle Shaping

Adjust the throttle shape (linear / progressive curve).

#### Details

- **Dial:** Rotation adjusts throttle shaping (clockwise = increase, counter-clockwise = decrease), regardless of the Direction setting
- **Default binding:** No default key binding — both Throttle Shape + and Throttle Shape - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### Boost Level

Adjust the engine boost level.

#### Details

- **Dial:** Rotation adjusts boost (clockwise = increase, counter-clockwise = decrease), regardless of the Direction setting
- **Default binding:** No default key binding — both Boost + and Boost - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises boost
- **Decrease** — Pressing the button lowers boost

---

### Launch RPM

Adjust the launch control RPM target.

#### Details

- **Dial:** Rotation adjusts launch RPM (clockwise = increase, counter-clockwise = decrease), regardless of the Direction setting
- **Default binding:** No default key binding — both Launch RPM + and Launch RPM - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the RPM target
- **Decrease** — Pressing the button lowers the RPM target
