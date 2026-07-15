---
title: Black Box Selector
description: Navigate iRacing's black box overlays with direct selection or cycling.
sidebar:
  badge:
    text: "3 modes"
    variant: tip
---

Open any of iRacing's black box overlays directly, or cycle through them sequentially. Direct-selection acts as a toggle — pressing a button opens the black box, and pressing it again while that black box is already selected closes it. Placed on a **Stream Deck+ dial**, the same action becomes a black-box browser — turn to step through the boxes and press to open one — see [On a dial](#on-a-dial) below.

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector. In **Direct** mode, also pick which overlay the button opens from the **Black Box** dropdown.

### Direct

Open a specific black box overlay. Pressing the button toggles the overlay — press once to open, press again to close. The **Black Box** setting picks which overlay the button controls.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** Depends on the selected black box — see the **Black Box** setting below
- **Telemetry-aware icon:** No

#### Setting: Black Box

The overlay this button opens. Each option has its own key binding with the defaults shown below; all bindings can be reconfigured.

- **Lap Timing** (default `F1`) — Lap Timing black box
- **Standings** (default `F2`) — Standings black box
- **Relative** (default `F3`) — Relative black box
- **Fuel** (default `F4`) — Fuel black box
- **Tires** (default `F5`) — Tires black box
- **Tire Info** (default `F6`) — Tire Info black box
- **Pit-Stop Adjustments** (default `F7`) — Pit stop adjustments black box
- **In-Car Adjustments** (default `F8`) — In-car adjustments black box
- **Mirror Adjustments** (default `F9`) — Mirror adjustments black box
- **Radio Adjustments** (default `F10`) — Radio adjustments black box
- **Weather** (default `F11`) — Weather black box

---

### Next

Cycle to the next black box.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Previous

Cycle to the previous black box.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

## On a dial

Placed on a Stream Deck+ dial, Black Box Selector becomes a black-box browser. Turning the dial steps through iRacing's black boxes — clockwise for the next box, counter-clockwise for the previous — using the same **Cycle Next** and **Cycle Previous** key bindings the keypad Next and Previous modes use, so no extra configuration is needed if you already use them. A press can jump straight to one box you pick. The Property Inspector automatically shows the dial settings below (instead of the keypad Mode and Black Box) when the instance sits on a dial. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

iRacing reports no telemetry for which black box is currently open, so the touch strip can't track your position in the ring — it shows the action's identity only: a "BB" badge and the "BLACK BOX" wordmark. This is the same documented limitation as the other key-binding-driven dials. You can still recolor the strip's border, label, and background in the **Dash Box Appearance** section of the dial settings.

#### Details

- **Method:** Key binding — rotation uses the **Cycle Next** and **Cycle Previous** bindings; the press gesture uses the per-box binding of the box you choose in **Box to Open**. Black box selection has no iRacing API command, so every dial path needs a binding. Configure them in the **Related Key Bindings** section; the Property Inspector shows a status line indicating whether each is set.
- **Dial:** Rotating cycles through the black boxes (clockwise = next, counter-clockwise = previous), one box per detent; a fast spin steps several at once. Both the Cycle Next and Cycle Previous bindings must be set.
- **Telemetry-aware:** No — iRacing exposes no open-box state, so the touch strip is a static identity readout.

#### Controls

- **Elgato Stream Deck+** — dial rotation, a press (short or long), and a touchscreen readout that always shows. A touchscreen tap or long tap runs its own configured Tap Display / Long Touch action.

Dials are currently Stream Deck+ only — the action can't be placed on Mirabox knobs or Ulanzi dials yet (see [Dials](/docs/features/dials/)).

#### Setting: Box to Open

The black box a press opens directly, used whenever a press or touch gesture below is set to **Open Selected Box**. It offers the same eleven boxes as the keypad Direct mode (default *Lap Timing*). Opening a box behaves exactly like a Direct keypad press: it toggles the overlay, so pressing again while that box is already shown closes it. The press taps that box's own key binding — set it in the **Related Key Bindings** section.

#### Setting: Press Action / Long Press

What a short or long press of the dial button does, chosen from:

- **None** (default for both) — does nothing.
- **Open Selected Box** — opens the box picked in **Box to Open**.

A press is classified when you release the dial — a hold past the [Long-press threshold](/docs/features/dials/#the-long-press-threshold) fires the Long Press action. Turning the dial while pressed cycles boxes (a "push + turn") and never fires the press action.

#### Setting: Tap Display / Long Touch

Optional touch-strip gestures (Stream Deck+ only), each over { Open Selected Box, None }. Both default to **None** for VR safety.
