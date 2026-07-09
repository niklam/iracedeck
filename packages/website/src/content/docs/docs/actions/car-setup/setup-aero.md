---
title: Setup Aero
description: Adjust aerodynamic settings like front wing, rear wing, and qualifying tape during a session.
sidebar:
  badge:
    text: "6 modes"
    variant: tip
---

Adjust aerodynamic setup options from the cockpit — front and rear wing angles, qualifying tape, and the right-front brake attachment. Placed on a **Stream Deck+ dial**, the same action becomes an aero-setup dial with the live value on the touch strip — see [On a dial](#on-a-dial) below.

## View sub-modes

The **View …** entries turn the key into a continuously updating display of the current value in the car. With **dual-press** enabled (default) the same key also adjusts the value: a short press fires one direction and a long press fires the opposite — so one key replaces the separate Increase / Decrease keys you'd otherwise need.

| View setting | Telemetry source | Format | Typical range |
|---|---|---|---|
| View Front Wing | `dcFrontWing` | integer | car-dependent slot or angle |
| View Rear Wing | `dcRearWing` | integer | car-dependent slot or angle |

Cars without a driver-adjustable wing render "---". Qualifying tape and the RF brake attachment toggle have no `dc*` telemetry on common cars, so they don't have View entries.

### Dual-press control

Each View sub-mode exposes a single extra setting in the Property Inspector:

- **Enable dual-press** (default *on*) — when off, the key stays a pure read-only display and presses do nothing. When on, presses dispatch to the matching adjustment binding (e.g. View Front Wing dispatches to *Front Wing +* / *Front Wing −*), so configure those bindings in the **Global Settings → Setup Aero** section.

The tap direction is a single plugin-wide setting under **Global Common Settings → Dual-Press → Directions** (default *Tap increases, long-press decreases*; the long-press always fires the opposite of the tap). The threshold separating "short" from "long" is a sibling setting **Long-press threshold (ms)** (200–2000 ms, default 500 ms). Both take effect on the next press without needing a restart.

## Modes

Select the mode from the **Setting** dropdown in the Property Inspector. Directional modes also expose a **Direction** setting for Increase / Decrease.

### Front Wing

Adjust the front wing angle. The **Direction** setting picks whether pressing the button increases or decreases the angle.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Front Wing + and Front Wing - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button increases the front wing angle
- **Decrease** — Pressing the button decreases the front wing angle

---

### Rear Wing

Adjust the rear wing angle. The **Direction** setting picks whether pressing the button increases or decreases the angle.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Rear Wing + and Rear Wing - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button increases the rear wing angle
- **Decrease** — Pressing the button decreases the rear wing angle

---

### Qualifying Tape

Adjust the amount of qualifying tape covering the radiators. The **Direction** setting picks whether pressing the button adds or removes tape.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Qualifying Tape + and Qualifying Tape - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button adds more tape
- **Decrease** — Pressing the button removes tape

---

### RF Brake Attached

Toggle the right-front brake attachment.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

## On a dial

Placed on a Stream Deck+ dial, Setup Aero becomes an aero-setup dial. Pick one value with the dial's **Setting** dropdown; turning the dial steps it up or down in the car, and the touch strip shows that value live as a big, color-coded number. It uses the same key bindings as the keypad modes, so no extra configuration is needed if you already use them. The Property Inspector automatically shows the dial settings below (instead of the keypad Setting and Direction) when the instance sits on a dial. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

#### Details

- **Method:** Key binding — the same Setup Aero increase/decrease bindings the keypad modes use, plus the *RF Brake Attached* binding for the press gestures. Configure them in the **Related Key Bindings** section; the Property Inspector shows a status line indicating whether each is set.
- **Dial:** Rotating adjusts the selected value (clockwise = increase, counter-clockwise = decrease). Both the increase and decrease key bindings must be set.
- **Telemetry-aware:** Yes for the wings — the touch strip shows the live value from telemetry (see the table below). Qualifying Tape has no telemetry, so its strip shows the label only.

#### Controls

- **Elgato Stream Deck+** — dial rotation, a press (short or long), and a touchscreen readout that always shows. A touchscreen tap or long tap runs its own configured Tap Display / Long Touch action.

Dials are currently Stream Deck+ only — the action can't be placed on Mirabox knobs or Ulanzi dials yet (see [Dials](/docs/features/dials/)).

#### Setting: Setting

The aero value the dial controls. Each renders as a color-coded "dash box": a short label on top and the live value as a large number. Each setting has a built-in accent color, but you can override the border, label, value, and background colors — and add an optional border glow — in the **Dash Box Appearance** section of the dial settings. The RF Brake Attached toggle isn't offered as a rotation setting (it's a press gesture instead).

| Setting | Label | Telemetry source | Shown as |
|---|---|---|---|
| Front Wing | FRONT | `dcFrontWing` | integer |
| Rear Wing | REAR | `dcRearWing` | integer |
| Qualifying Tape | TAPE | *(none — iRacing exposes no tape value)* | label only |

When a telemetry-backed setting has no data the box shows `---`. Qualifying Tape still rotates (it uses its increase/decrease bindings); its strip just can't show a live number.

#### Setting: Press Action / Long Press

What a short or long press of the dial button does, chosen from:

- **None** (default for both) — does nothing.
- **Toggle RF Brake** — taps the Setup Aero *RF Brake Attached* binding.

A press is classified when you release the dial — a hold past the [Long-press threshold](/docs/features/dials/#the-long-press-threshold) fires the Long Press action. Turning the dial while pressed adjusts the value (a "push + turn") and never fires the press action.

#### Setting: Tap Display / Long Touch

Optional touch-strip gestures (Stream Deck+ only), each over { Toggle RF Brake, None }. Both default to **None** for VR safety.

## Key Styles — paired +/− buttons

Adjustment modes with a live value (on Setup Aero: Front Wing and Rear Wing) can render as **paired keys**: place two keys with opposite directions next to each other (or three, with a View key in the middle) and both show the live value — no separate display key needed. Choose the look under **Key Style**:

- **Legacy (arrows)** — the classic static arrow icon (default for existing keys).
- **Split** — label on top, live value in the middle, a big +/− below (default for newly placed keys).
- **Edge chevrons**, **Joined pill** — alternative value-showing pair looks.
- **Big +/−**, **Big chevrons**, **Pill end** — no-value styles for the outer keys of a 3-key group; the View key in the middle shows the value (set its **Display Style** to *Pill middle* to span the pill across all three keys).

Values are shown without units for maximum size. **Edge chevrons**, **Joined pill**, **Pill end**, and **Big chevrons** take a **Position in Pair** setting (*Auto* follows the direction: increase right, decrease left; pick *Top*/*Bottom* for vertical stacks). Holding a paired key repeats the adjustment until released. Colors follow the normal color overrides (the +/− accent is the *Graphic 1* slot); pill styles disable the normal border — the pill itself is the frame.
