---
title: Setup Brakes
description: Adjust brake settings including ABS, brake bias, peak brake bias, and engine braking — from a Stream Deck button or dial.
sidebar:
  badge:
    text: "13 modes + dial"
    variant: tip
---

Adjust brake-related setup options from the cockpit — ABS level, brake bias (coarse and fine), peak brake bias, miscellaneous brake settings, and engine braking. Placed on a **Stream Deck+ dial** (or Mirabox knob), the same action becomes a brake-setup dial with the live value on the touch strip — see [On a dial](#on-a-dial) below.

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

Select the mode from the **Setting** dropdown in the Property Inspector. Directional modes also expose a **Direction** setting for Increase / Decrease. Modes apply to keypad instances; a dial instance uses the dial behavior described in [On a dial](#on-a-dial).

### ABS Toggle

Toggle ABS on or off.

#### Details

- **Method:** Key binding
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### ABS Adjust

Step the ABS level up or down. The **Direction** setting picks whether pressing the button raises or lowers the level.

#### Details

- **Method:** Key binding
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
- **Default binding:** No default key binding — both Engine Braking + and Engine Braking - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises engine braking
- **Decrease** — Pressing the button lowers engine braking

## On a dial

Placed on a Stream Deck+ dial (or a Mirabox knob), Setup Brakes becomes a brake-setup dial. Pick one brake value with the dial's **Setting** dropdown; turning the dial steps it up or down in the car, and the touch strip shows that value live as a big, color-coded number. It uses the same key bindings as the keypad modes, so no extra configuration is needed if you already use them. The Property Inspector automatically shows the dial settings below (instead of the keypad Setting and Direction) when the instance sits on a dial. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

#### Details

- **Method:** Key binding — the same Setup Brakes increase/decrease bindings the keypad modes use, plus the *ABS Toggle* binding for the press gestures. Configure them in the **Related Key Bindings** section; the Property Inspector shows a status line indicating whether each is set.
- **Dial:** Rotating adjusts the selected setting (clockwise = increase, counter-clockwise = decrease). Both the increase and decrease key bindings must be set.
- **Default binding:** Brake Bias uses `=` / `-` like the keypad mode; every other setting needs both directions configured
- **Telemetry-aware icon:** Yes — the touch strip shows the live value from telemetry (see the table below)

#### Controls

- **Elgato Stream Deck+** — dial rotation, a press (short or long), and a touchscreen readout that always shows. A touchscreen tap or long tap runs its own configured Tap Display / Long Touch action.
- **Mirabox** — knob rotation and a press (short or long). There is no touchscreen, so the Tap Display and Long Touch settings do not apply.

#### Setting: Setting

The brake value the dial controls. Each setting renders as a color-coded "dash box": a short label on top and the live value as a large number. The `%` is dropped (bias values read as percentages). The label and color are fixed per setting so multiple dials stay distinguishable at a glance.

| Setting | Label | Color | Telemetry source | Shown as |
|---|---|---|---|---|
| Brake Bias | BB | red | `dcBrakeBias` | e.g. `54.0` |
| Brake Bias Fine | BBF | amber | `dcBrakeBiasFine` | e.g. `0.5` |
| Peak Brake Bias | PEAK | purple | `dcPeakBrakeBias` | e.g. `65.0` |
| Brake Misc | MISC | blue | `dcBrakeMisc` | integer (car-dependent) |
| Engine Braking | ENG | green | `dcEngineBraking` | integer (car-dependent) |
| ABS Adjust | ABS | yellow | `dcABS` | integer (car-dependent) |

When telemetry isn't available the box shows `---`. View sub-modes and ABS Toggle are not offered as rotation settings — the dial display already shows the live value, and on/off doesn't map to a rotary (ABS Toggle remains available as a press gesture).

#### Setting: Press Action / Long Press

What a short or long press of the dial button does, chosen from:

- **Toggle ABS** (default for Press) — taps the Setup Brakes *ABS Toggle* binding.
- **None** (default for Long Press) — does nothing.

A press is classified when you release the dial — a hold past the [Long-press threshold](/docs/features/dials/#the-long-press-threshold) fires the Long Press action. Turning the dial while pressed adjusts the value (a "push + turn") and never fires the press action.

#### Setting: Tap Display / Long Touch

Optional touch-strip gestures (Stream Deck+ only), each over { Toggle ABS, None }. Both default to **None** for VR safety.
