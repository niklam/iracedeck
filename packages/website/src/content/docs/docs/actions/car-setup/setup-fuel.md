---
title: Setup Fuel
description: Adjust in-car fuel settings including mixture, fuel cut position, and FCY mode during a session.
sidebar:
  badge:
    text: "7 modes"
    variant: tip
---

Adjust in-car fuel settings from the cockpit: fuel mixture, fuel cut position, disable fuel cut, low fuel accept, and full-course yellow mode. These are live car adjustments, not pit service fuel requests. Placed on a **Stream Deck+ dial**, the same action becomes a fuel-setup dial with the live value on the touch strip — see [On a dial](#on-a-dial) below.

## View sub-modes

The **View …** entries turn the key into a continuously updating display of the current value in the car. With **dual-press** enabled (default) the same key also adjusts the value: a short press fires one direction and a long press fires the opposite — so one key replaces the separate Increase / Decrease keys you'd otherwise need.

| View setting | Telemetry source | Format | Typical range |
|---|---|---|---|
| View Fuel Mixture | `dcFuelMixture` | integer | car-dependent slot |
| View Fuel Cut Position | `dcFuelCutPosition` | integer | car-dependent slot |

### Dual-press control

Each View sub-mode exposes a single extra setting in the Property Inspector:

- **Enable dual-press** (default *on*) — when off, the key stays a pure read-only display and presses do nothing. When on, presses dispatch to the matching adjustment binding (e.g. View Fuel Mixture dispatches to *Fuel Mixture +* / *Fuel Mixture −*), so configure those bindings in the **Global Settings → Setup Fuel** section.

The tap direction is a single plugin-wide setting under **Global Common Settings → Dual-Press → Directions** (default *Tap increases, long-press decreases*; the long-press always fires the opposite of the tap). The threshold separating "short" from "long" is a sibling setting **Long-press threshold (ms)** (200–2000 ms, default 500 ms). Both take effect on the next press without needing a restart.

## Modes

Select the mode from the **Setting** dropdown in the Property Inspector. Directional modes (Fuel Mixture, Fuel Cut Position) also expose a **Direction** setting for Increase / Decrease.

### Fuel Mixture

Adjust the fuel / air mixture setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Fuel Mixture + and Fuel Mixture - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the mixture
- **Decrease** — Pressing the button lowers the mixture

---

### Fuel Cut Position

Adjust the fuel cut position setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Fuel Cut Position + and Fuel Cut Position - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### Disable Fuel Cut

Toggle the fuel cut disable setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Low Fuel Accept

Accept the low fuel warning dialog that appears in some series.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### FCY Mode Toggle

Toggle full-course yellow mode on or off.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

## On a dial

Placed on a Stream Deck+ dial, Setup Fuel becomes a fuel-setup dial (distinct from the Fuel Service pit-fuel dial — this adjusts the in-car fuel mixture and cut). Pick one value with the dial's **Setting** dropdown; turning the dial steps it up or down in the car, and the touch strip shows that value live as a big, color-coded number. It uses the same key bindings as the keypad modes, so no extra configuration is needed if you already use them. The Property Inspector automatically shows the dial settings below (instead of the keypad Setting and Direction) when the instance sits on a dial. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

#### Details

- **Method:** Key binding — the same Setup Fuel increase/decrease bindings the keypad modes use, plus the *FCY Mode Toggle* binding for the press gestures. Configure them in the **Related Key Bindings** section; the Property Inspector shows a status line indicating whether each is set.
- **Dial:** Rotating adjusts the selected value (clockwise = increase, counter-clockwise = decrease). Both the increase and decrease key bindings must be set.
- **Telemetry-aware:** Yes — the touch strip shows the live value from telemetry (see the table below).

#### Controls

- **Elgato Stream Deck+** — dial rotation, a press (short or long), and a touchscreen readout that always shows. A touchscreen tap or long tap runs its own configured Tap Display / Long Touch action.

Dials are currently Stream Deck+ only — the action can't be placed on Mirabox knobs or Ulanzi dials yet (see [Dials](/docs/features/dials/)).

#### Setting: Setting

The fuel value the dial controls. Each renders as a color-coded "dash box": a short label on top and the live value as a large number. Only the two adjustable values are offered — the one-shot toggles (Disable Fuel Cut, Low Fuel Accept, FCY Mode Toggle) don't map to a rotary.

| Setting | Label | Telemetry source | Shown as |
|---|---|---|---|
| Fuel Mixture | MIX | `dcFuelMixture` | integer |
| Fuel Cut Position | CUT | `dcFuelCutPosition` | integer |

When telemetry isn't available the box shows `---`.

#### Setting: Press Action / Long Press

What a short or long press of the dial button does, chosen from:

- **None** (default for both) — does nothing.
- **Toggle FCY Mode** — taps the Setup Fuel *FCY Mode Toggle* binding.

A press is classified when you release the dial — a hold past the [Long-press threshold](/docs/features/dials/#the-long-press-threshold) fires the Long Press action. Turning the dial while pressed adjusts the value (a "push + turn") and never fires the press action.

#### Setting: Tap Display / Long Touch

Optional touch-strip gestures (Stream Deck+ only), each over { Toggle FCY Mode, None }. Both default to **None** for VR safety.

## Key Styles — paired +/− buttons

Adjustment modes with a live value (on Setup Fuel: Fuel Mixture and Fuel Cut Position) can render as **paired keys**: place two keys with opposite directions next to each other (or three, with a View key in the middle) and both show the live value — no separate display key needed. Choose the look under **Key Style**:

- **Legacy (arrows)** — the classic static arrow icon (default for existing keys).
- **Split** — label on top, live value in the middle, a big +/− below (default for newly placed keys).
- **Edge chevrons**, **Joined pill** — alternative value-showing pair looks.
- **Big +/−**, **Big chevrons**, **Pill end** — no-value styles for the outer keys of a 3-key group; the View key in the middle shows the value (set its **Display Style** to *Pill middle* to span the pill across all three keys).

Values are shown without units for maximum size. **Edge chevrons**, **Joined pill**, **Pill end**, and **Big chevrons** take a **Position in Pair** setting (*Auto* follows the direction: increase right, decrease left; pick *Top*/*Bottom* for vertical stacks). Holding a paired key repeats the adjustment until released. Colors follow the normal color overrides (the +/− accent is the *Graphic 1* slot); pill styles disable the normal border — the pill itself is the frame.
