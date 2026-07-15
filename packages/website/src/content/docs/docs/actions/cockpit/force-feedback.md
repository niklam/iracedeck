---
title: Force Feedback
description: Force feedback and haptic controls for wheel, bass shaker, and LFE intensity.
sidebar:
  badge:
    text: "6 modes"
    variant: tip
---

Control force feedback and haptic settings from iRacing's Audio & Force Feedback page: auto-compute FFB, overall FFB force, wheel LFE loudness and intensity, bass shaker LFE loudness, and haptic LFE intensity. Placed on a **Stream Deck+ dial**, the same action becomes a force-feedback dial with the live max force in Nm on the touch strip — see [On a dial](#on-a-dial) below.

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector. Directional modes also expose a **Direction** setting.

### Auto Compute FFB Force

Toggle iRacing's auto-compute FFB force calibration.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Ctrl+A`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### FFB Force

Adjust the force feedback maximum force (iRacing's "max force" setting, in Nm). This is the canonical home of the former Cockpit Misc FFB Max Force mode — old Cockpit Misc buttons keep working and share the same global key binding, so configuring one updates the other.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both FFB Force Increase and FFB Force Decrease must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the force
- **Decrease** — Pressing the button lowers the force

---

### Wheel LFE

Adjust the wheel LFE (low-frequency effects) loudness.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Wheel LFE Louder and Wheel LFE Quieter must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button makes it louder
- **Decrease** — Pressing the button makes it quieter

---

### Bass Shaker LFE

Adjust the bass shaker LFE loudness.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Bass Shaker LFE Louder and Bass Shaker LFE Quieter must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button makes it louder
- **Decrease** — Pressing the button makes it quieter

---

### Wheel LFE Intensity

Adjust the wheel LFE intensity curve.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Wheel LFE More Intense and Wheel LFE Less Intense must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button makes it more intense
- **Decrease** — Pressing the button makes it less intense

---

### Haptic LFE Intensity

Adjust the haptic LFE intensity curve.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Haptic LFE More Intense and Haptic LFE Less Intense must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button makes it more intense
- **Decrease** — Pressing the button makes it less intense

## On a dial

Placed on a Stream Deck+ dial, Force Feedback becomes a force-feedback dial. Pick one value with the dial's **Setting** dropdown; turning the dial steps it up or down in iRacing, and for **FFB Force** the touch strip shows the live max force in Nm. It uses the same key bindings as the keypad modes, so no extra configuration is needed if you already use them. The Property Inspector automatically shows the dial settings below (instead of the keypad Mode and Direction) when the instance sits on a dial. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

#### Details

- **Method:** Key binding — the same Force Feedback increase/decrease bindings the keypad modes use, plus the *Auto Compute FFB Force* binding for the press gestures. Configure them in the **Related Key Bindings** section; the Property Inspector shows a status line indicating whether each is set.
- **Dial:** Rotating adjusts the selected value (clockwise = increase, counter-clockwise = decrease). Both the increase and decrease key bindings must be set. A fast spin advances several detents (up to five per turn event).
- **Telemetry-aware:** Yes for FFB Force — the touch strip shows the live `SteeringWheelMaxForceNm` value as `XX.X Nm`. The four LFE settings have no telemetry, so their strips show the label only.

#### Controls

- **Elgato Stream Deck+** — dial rotation, a press (short or long), and a touchscreen readout that always shows. A touchscreen tap or long tap runs its own configured Tap Display / Long Touch action.

Dials are currently Stream Deck+ only — the action can't be placed on Mirabox knobs or Ulanzi dials yet (see [Dials](/docs/features/dials/)).

#### Setting: Setting

The value the dial controls. Each renders as a color-coded "dash box": a short label on top, and for FFB Force the live value as a large number. Each setting has a built-in accent color, but you can override the border, label, value, and background colors in the **Dash Box Appearance** section of the dial settings.

| Setting | Label | Telemetry source | Shown as |
|---|---|---|---|
| FFB Force (max force) | FFB | `SteeringWheelMaxForceNm` | `XX.X Nm` |
| Wheel LFE | WHEEL | *(none — iRacing exposes no LFE state)* | label only |
| Bass Shaker LFE | SHAKER | *(none — iRacing exposes no LFE state)* | label only |
| Wheel LFE Intensity | W-INT | *(none — iRacing exposes no LFE state)* | label only |
| Haptic LFE Intensity | H-INT | *(none — iRacing exposes no LFE state)* | label only |

When FFB Force has no telemetry the box shows `---`. The LFE settings still rotate (they use their increase/decrease bindings); their strips just show the label.

#### Setting: Press Action / Long Press

What a short or long press of the dial button does, chosen from:

- **Auto FFB** — taps the Force Feedback *Auto Compute FFB Force* binding, running iRacing's auto-calibration.
- **None** (default for both) — does nothing. Auto FFB defaults off because it overwrites the max force you've been tuning, so it's never a blind default.

A press is classified when you release the dial — a hold past the [Long-press threshold](/docs/features/dials/#the-long-press-threshold) fires the Long Press action. Turning the dial while pressed adjusts the value (a "push + turn") and never fires the press action.

#### Setting: Tap Display / Long Touch

Optional touch-strip gestures (Stream Deck+ only), each over { Auto FFB, None }. Both default to **None** for VR safety.
