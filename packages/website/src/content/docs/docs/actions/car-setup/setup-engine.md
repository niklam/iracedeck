---
title: Setup Engine
description: Adjust engine settings including power, throttle shaping, boost level, and launch RPM during a session.
sidebar:
  badge:
    text: "7 modes"
    variant: tip
---

Adjust engine-related setup options from the cockpit: engine power, throttle shaping, boost level, and launch RPM. Placed on a **Stream Deck+ dial**, the same action becomes an engine-setup dial with the live value on the touch strip — see [On a dial](#on-a-dial) below.

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

Select the mode from the **Setting** dropdown in the Property Inspector. **Adjust** modes are directional — pick **Increase** or **Decrease** in the **Direction** setting to control what a button press does. **View** modes show a live readout and, with **Enable dual-press** on (default), also accept short / long presses — see [View sub-modes](#view-sub-modes) above. They don't use the per-action **Direction** setting; the tap direction is the plugin-wide **Global Common Settings → Dual-Press → Directions**.

### Engine Power

Adjust the engine power setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Engine Power + and Engine Power - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises engine power
- **Decrease** — Pressing the button lowers engine power

---

### Throttle Shaping

Adjust the throttle shape (linear / progressive curve).

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Throttle Shape + and Throttle Shape - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### Boost Level

Adjust the engine boost level.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Boost + and Boost - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises boost
- **Decrease** — Pressing the button lowers boost

---

### Launch RPM

Adjust the launch control RPM target.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Launch RPM + and Launch RPM - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the RPM target
- **Decrease** — Pressing the button lowers the RPM target

## On a dial

Placed on a Stream Deck+ dial, Setup Engine becomes an engine-setup dial. Pick one value with the dial's **Setting** dropdown; turning the dial steps it up or down in the car, and the touch strip shows that value live as a big, color-coded number. It uses the same key bindings as the keypad modes, so no extra configuration is needed if you already use them. The Property Inspector automatically shows the dial settings below (instead of the keypad Setting and Direction) when the instance sits on a dial. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

#### Details

- **Method:** Key binding — the same Setup Engine increase/decrease bindings the keypad modes use. Configure them in the **Related Key Bindings** section; the Property Inspector shows a status line indicating whether each is set.
- **Dial:** Rotating adjusts the selected value (clockwise = increase, counter-clockwise = decrease). Both the increase and decrease key bindings must be set.
- **Telemetry-aware:** Yes for most settings — the touch strip shows the live value from telemetry (see the table below). Boost Level has no telemetry, so its strip shows the label only.

#### Controls

- **Elgato Stream Deck+** — dial rotation and a touchscreen readout that always shows.

Dials are currently Stream Deck+ only — the action can't be placed on Mirabox knobs or Ulanzi dials yet (see [Dials](/docs/features/dials/)).

#### Setting: Setting

The engine value the dial controls. Each renders as a color-coded "dash box": a short label on top and the live value as a large number.

| Setting | Label | Telemetry source | Shown as |
|---|---|---|---|
| Engine Power | POWER | `dcEnginePower` | integer |
| Throttle Shaping | THR | `dcThrottleShape` | integer |
| Boost Level | BOOST | *(none — iRacing exposes no boost value)* | label only |
| Launch RPM | LAUNCH | `dcLaunchRPM` | integer |

When a telemetry-backed setting has no data the box shows `---`. Boost Level still rotates (it uses its increase/decrease bindings); its strip just can't show a live number.

#### Press and touch gestures

Setup Engine has no on/off toggle, so the dial press and touchscreen taps do nothing — the dial is rotation-only.

## Key Styles — paired +/− buttons

Adjustment modes with a live value (on Setup Engine: Engine Power, Throttle Shaping, and Launch RPM) can render as **paired keys**: place two keys with opposite directions next to each other (or three, with a View key in the middle) and both show the live value — no separate display key needed. Choose the look under **Key Style**:

- **Legacy (arrows)** — the classic static arrow icon (default for existing keys).
- **Split** — label on top, live value in the middle, a big +/− below (default for newly placed keys).
- **Edge chevrons**, **Joined pill** — alternative value-showing pair looks.
- **Big +/−**, **Big chevrons**, **Pill end** — no-value styles for the outer keys of a 3-key group; the View key in the middle shows the value (set its **Display Style** to *Pill middle* to span the pill across all three keys).

Values are shown without units for maximum size. **Edge chevrons**, **Joined pill**, **Pill end**, and **Big chevrons** take a **Position in Pair** setting (*Auto* follows the direction: increase right, decrease left; pick *Top*/*Bottom* for vertical stacks). Holding a paired key repeats the adjustment until released. Colors follow the normal color overrides (the +/− accent is the *Graphic 1* slot); pill styles disable the normal border — the pill itself is the frame.
