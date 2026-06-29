---
title: Setup Brakes Dial
description: Adjust a brake setup value with a Stream Deck+ dial — brake bias, peak bias, bias fine, brake misc, engine braking, or ABS — with the live value on the touch strip.
sidebar:
  badge:
    text: "6 modes"
    variant: tip
---

A Stream Deck+ **dial** for brake setup adjustments. Pick one brake value with the **Setting** dropdown; turning the dial steps it up or down in the car, and the touch strip shows that value live as a big, color-coded number. It uses the same key bindings as the [Setup Brakes](/docs/actions/car-setup/setup-brakes/) action, so no extra configuration is needed if you already use it.

This action is **Stream Deck+ only**. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

## Settings

### Setting

The brake value the dial controls. Each setting renders as a color-coded "dash box": a short label on top and the live value as a large number. The `%` is dropped (bias values read as percentages). The label and color are fixed per setting so multiple dials stay distinguishable at a glance, and adjustment goes through the matching **Setup Brakes** key bindings (configured in the action's **Related Key Bindings** section).

| Setting | Label | Color | Telemetry source | Shown as |
|---|---|---|---|---|
| Brake Bias | BB | red | `dcBrakeBias` | e.g. `54.0` |
| Brake Bias Fine | BBF | amber | `dcBrakeBiasFine` | e.g. `0.5` |
| Peak Brake Bias | PEAK | purple | `dcPeakBrakeBias` | e.g. `65.0` |
| Brake Misc | MISC | blue | `dcBrakeMisc` | integer (car-dependent) |
| Engine Braking | ENG | green | `dcEngineBraking` | integer (car-dependent) |
| ABS Adjust | ABS | yellow | `dcABS` | integer (car-dependent) |

When telemetry isn't available the box shows `---`.

### Press Action / Long Press

What a short or long press of the dial button does, chosen from:

- **Toggle ABS** (default for Press) — taps the Setup Brakes *ABS Toggle* binding.
- **None** (default for Long Press) — does nothing.

A press is classified when you release the dial — a hold past the [Long-press threshold](/docs/features/dials/#the-long-press-threshold) fires the Long Press action. Turning the dial while pressed adjusts the value (a "push + turn") and never fires the press action.

### Tap Display / Long Touch

Optional touch-strip gestures (Stream Deck+ only), each over { Toggle ABS, None }. Both default to **None** for VR safety.

## Controls

| Control | Behavior |
|---|---|
| Turn | Adjusts the selected setting (clockwise = increase, counter-clockwise = decrease) |
| Push | Runs the Press Action (default: Toggle ABS) |
| Long Press | Runs the Long Press action (default: None) |
| Tap Display / Long Touch | Run the configured touch gestures (default: None) |
| Keypad button | With no dial, a press runs the Press Action |

## Communication method

Every adjustment uses a **key binding** — the same Setup Brakes increase/decrease bindings the keypad action uses, plus the *ABS Toggle* binding for the press gesture. Configure them in the **Related Key Bindings** section; the Property Inspector shows a status line indicating whether each is set.
