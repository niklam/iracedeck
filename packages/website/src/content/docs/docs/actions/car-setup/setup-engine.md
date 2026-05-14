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

The **View …** entries turn the key into a continuously updating display of the current value in the car. With **dual-press** enabled (default) the same key also adjusts the value: a short press fires one direction and a long press fires the opposite — so one key replaces the separate Increase / Decrease keys you'd otherwise need. (Boost Level has no View counterpart — iRacing doesn't expose a matching `dc*` field, so Boost Level remains a directional-only adjustment mode.)

| View setting | Telemetry source | Format | Typical range |
|---|---|---|---|
| View Engine Power | `dcEnginePower` | integer | car-dependent slot |
| View Throttle Shape | `dcThrottleShape` | integer | car-dependent slot |
| View Launch RPM | `dcLaunchRPM` | integer | RPM |

### Dual-press control

Each View sub-mode exposes a single extra setting in the Property Inspector:

- **Enable dual-press** (default *on*) — when off, the key stays a pure read-only display and presses do nothing. When on, presses dispatch to the matching adjustment binding (e.g. View Engine Power dispatches to *Engine Power +* / *Engine Power −*), so configure those bindings in the **Global Settings → Setup Engine** section.

The tap direction is a single plugin-wide setting under **Global Common Settings → Dual-Press → Directions** (default *Tap increases, long-press decreases*; the long-press always fires the opposite of the tap). The threshold separating "short" from "long" is a sibling setting **Long-press threshold (ms)** (200–2000 ms, default 500 ms). Both take effect on the next press without needing a restart.

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
