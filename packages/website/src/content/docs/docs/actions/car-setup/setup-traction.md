---
title: Setup Traction
description: Adjust traction control settings across multiple TC slots during a session.
sidebar:
  badge:
    text: "9 modes"
    variant: tip
---

Adjust traction control from the cockpit: toggle TC on or off, and step the four independent TC slot levels. Placed on a **Stream Deck+ dial**, the same action becomes a traction-control dial with the live value on the touch strip — see [On a dial](#on-a-dial) below.

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

## On a dial

Placed on a Stream Deck+ dial, Setup Traction becomes a traction-control dial. Pick one TC slot with the dial's **Setting** dropdown; turning the dial steps it up or down in the car, and the touch strip shows that slot's value live as a big, color-coded number. It uses the same key bindings as the keypad modes, so no extra configuration is needed if you already use them. The Property Inspector automatically shows the dial settings below (instead of the keypad Setting and Direction) when the instance sits on a dial. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

#### Details

- **Method:** Key binding — the same Setup Traction increase/decrease bindings the keypad modes use, plus the *TC Toggle* binding for the press gestures. Configure them in the **Related Key Bindings** section; the Property Inspector shows a status line indicating whether each is set.
- **Dial:** Rotating adjusts the selected slot (clockwise = increase, counter-clockwise = decrease). Both the increase and decrease key bindings must be set.
- **Telemetry-aware:** Yes — the touch strip shows the live value from telemetry (see the table below).

#### Controls

- **Elgato Stream Deck+** — dial rotation, a press (short or long), and a touchscreen readout that always shows. A touchscreen tap or long tap runs its own configured Tap Display / Long Touch action.

Dials are currently Stream Deck+ only — the action can't be placed on Mirabox knobs or Ulanzi dials yet (see [Dials](/docs/features/dials/)).

#### Setting: Setting

The TC slot the dial controls. Each renders as a color-coded "dash box": a short label on top and the live value as a large number. Each setting has a built-in accent color, but you can override the border, label, value, and background colors in the **Dash Box Appearance** section of the dial settings.

| Setting | Label | Telemetry source | Shown as |
|---|---|---|---|
| TC1 | TC1 | `dcTractionControl` | integer |
| TC2 | TC2 | `dcTractionControl2` | integer |
| TC3 | TC3 | `dcTractionControl3` | integer |
| TC4 | TC4 | `dcTractionControl4` | integer |

When telemetry isn't available the box shows `---`. TC Toggle and the View sub-modes aren't offered as rotation settings — the dial already shows the live value, and a toggle doesn't map to a rotary (TC Toggle remains available as a press gesture).

#### Setting: Press Action / Long Press

What a short or long press of the dial button does, chosen from:

- **Toggle TC** (default for Press) — taps the Setup Traction *TC Toggle* binding.
- **None** (default for Long Press) — does nothing.

A press is classified when you release the dial — a hold past the [Long-press threshold](/docs/features/dials/#the-long-press-threshold) fires the Long Press action. Turning the dial while pressed adjusts the value (a "push + turn") and never fires the press action.

#### Setting: Tap Display / Long Touch

Optional touch-strip gestures (Stream Deck+ only), each over { Toggle TC, None }. Both default to **None** for VR safety.

## Key Styles — paired +/− buttons

Adjustment modes with a live value (on Setup Traction: TC1, TC2, TC3, and TC4) can render as **paired keys**: place two keys with opposite directions next to each other (or three, with a View key in the middle) and both show the live value — no separate display key needed. Choose the look under **Key Style**:

- **Legacy (arrows)** — the classic static arrow icon (default for existing keys).
- **Split** — label on top, live value in the middle, a big +/− below (default for newly placed keys).
- **Edge chevrons**, **Joined pill** — alternative value-showing pair looks.
- **Big +/−**, **Big chevrons**, **Pill end** — no-value styles for the outer keys of a 3-key group; the View key in the middle shows the value (set its **Display Style** to *Pill middle* to span the pill across all three keys).

Values are shown without units for maximum size. **Edge chevrons**, **Joined pill**, **Pill end**, and **Big chevrons** take a **Position in Pair** setting (*Auto* follows the direction: increase right, decrease left; pick *Top*/*Bottom* for vertical stacks). Holding a paired key repeats the adjustment until released. Colors follow the normal color overrides (the +/− accent is the *Graphic 1* slot); pill styles disable the normal border — the pill itself is the frame.
