---
title: Cockpit Misc
description: Miscellaneous cockpit controls — wipers, latency, dash pages, and in-lap mode — from a Stream Deck button or dial.
sidebar:
  badge:
    text: "6 modes + dial"
    variant: tip
---

Cockpit Misc groups together various cockpit controls that don't fit neatly into other categories. Manage wipers, latency reporting, dashboard pages, and in-lap mode. Placed on a **Stream Deck+ dial**, the same action becomes a dash-page dial with the live page number on the touch strip — see [On a dial](#on-a-dial) below.

:::note
FFB Max Force now lives in the [Force Feedback](/docs/actions/cockpit/force-feedback/) action as the FFB Force mode. Existing Cockpit Misc buttons configured with the old mode keep working, but new buttons should use Force Feedback.
:::

## Modes

Select the mode from the **Control** dropdown in the Property Inspector. Directional modes (Dash Page 1, Dash Page 2) also expose a **Direction** setting for Increase / Decrease. Modes apply to keypad instances; a dial instance uses the dial behavior described in [On a dial](#on-a-dial).

### Toggle Wipers

Toggle the windshield wipers on or off.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Shift+W`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Trigger Wipers

Trigger a single wiper sweep.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Ctrl+Alt+W`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Report Latency

Report the current network latency in chat.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `L`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Dash Page 1

Cycle through the pages on dashboard display 1. The **Direction** setting picks whether pressing the button advances to the next page or goes back to the previous one.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Dash Page 1 + and Dash Page 1 - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button advances to the next page
- **Decrease** — Pressing the button goes back to the previous page

---

### Dash Page 2

Cycle through the pages on dashboard display 2. The **Direction** setting picks whether pressing the button advances to the next page or goes back to the previous one.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Dash Page 2 + and Dash Page 2 - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button advances to the next page
- **Decrease** — Pressing the button goes back to the previous page

---

### In-Lap Mode

Toggle in-lap mode (used for practice and qualifying to mark the return to pit).

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Shift+Alt+L`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

## On a dial

Placed on a Stream Deck+ dial, Cockpit Misc becomes a dash-page dial. Pick which dashboard display the dial controls with its **Setting** dropdown; turning the dial cycles that display's pages, and the touch strip shows the page the car is currently on as a big, color-coded number. It uses the same key bindings as the keypad Dash Page modes, so no extra configuration is needed if you already use them. The Property Inspector automatically shows the dial settings below (instead of the keypad Control and Direction) when the instance sits on a dial. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

#### Details

- **Method:** Key binding — the same Cockpit Misc dash-page increase/decrease bindings the keypad modes use, plus the *Toggle Wipers* / *In Lap Mode* bindings for the press and touch gestures. Configure them in the **Related Key Bindings** section; the Property Inspector shows a status line indicating whether each is set.
- **Dial:** Rotating cycles the selected dashboard page (clockwise = next, counter-clockwise = previous). Both the increase and decrease key bindings must be set.
- **Default binding:** No default key binding — both directions of the chosen dash page must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** Yes — the touch strip shows the live page number from telemetry (`dcDashPage` / `dcDashPage2`)

#### Controls

- **Elgato Stream Deck+** — dial rotation, a press (short or long), and a touchscreen readout that always shows. A touchscreen tap or long tap runs its own configured Tap Display / Long Touch action.

Dials are currently Stream Deck+ only — the action can't be placed on Mirabox knobs or Ulanzi dials yet (see [Dials](/docs/features/dials/)).

#### Setting: Setting

The dashboard display the dial controls. Each setting renders as a color-coded "dash box": a short label on top and the live page number as a large number. Each setting has a built-in accent color so multiple dials stay distinguishable at a glance; you can override the border, label, value, and background colors in the **Dash Box Appearance** section of the dial settings.

| Setting | Label | Color | Telemetry source | Shown as |
|---|---|---|---|---|
| Dash Page 1 | DASH 1 | blue | `dcDashPage` | e.g. `2` |
| Dash Page 2 | DASH 2 | amber | `dcDashPage2` | e.g. `4` |

When telemetry isn't available — or the car has no dashboard pages — the box shows `---`. FFB Max Force is not offered as a rotation setting here; its dial rotation lives in the [Force Feedback](/docs/actions/cockpit/force-feedback/) action.

#### Setting: Press Action / Long Press

What a short or long press of the dial button does, chosen from:

- **Toggle Wipers** — taps the Cockpit Misc *Toggle Wipers* binding.
- **In-Lap Mode** — taps the Cockpit Misc *In Lap Mode* binding.
- **None** (default for both) — does nothing.

A press is classified when you release the dial — a hold past the [Long-press threshold](/docs/features/dials/#the-long-press-threshold) fires the Long Press action. Turning the dial while pressed cycles the page (a "push + turn") and never fires the press action.

#### Setting: Tap Display / Long Touch

Optional touch-strip gestures (Stream Deck+ only), each over { Toggle Wipers, In-Lap Mode, None }. Both default to **None** for VR safety.
