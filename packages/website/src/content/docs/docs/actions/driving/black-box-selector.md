---
title: Black Box Selector
description: Navigate iRacing's black box overlays with direct selection or cycling, toggle their size, and work the open box's controls.
sidebar:
  badge:
    text: "5 modes"
    variant: tip
---

Open any of iRacing's black box overlays directly, cycle through them sequentially, switch the open black box between its small and large size, or work the controls inside the open box — select a control, change it or toggle it. Direct-selection acts as a toggle — pressing a button opens the black box, and pressing it again while that black box is already selected closes it. Placed on a **Stream Deck+ dial** or a **Mirabox knob**, the same action becomes a black-box dial — turn to step through the boxes, or to select and adjust the open box's controls, and press to open one — see [On a dial](#on-a-dial) below.

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector. In **Direct** mode, also pick which overlay the button opens from the **Black Box** dropdown; in **Selected Control** mode, pick what the key does from the **Control** dropdown.

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
- **Quick Access** (default `F9`) — iRacing's Quick Access menu, the F9 black box since 2026 Season 4
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

---

### Toggle Size

Switch the black box that is currently showing between iRacing's small and large size. Each press toggles the size, so pressing again switches it back. The key shows **BOX SIZE**.

iRacing only offers this as a toggle and does not report which size a box is shown at, so there is no separate key to make a box small or large. If no black box is open, the press does nothing in the sim.

iRacing ships **Toggle Black Box Size** without a key, so assign one in iRacing's controls first, then set the same key on the **Toggle Black Box Size** binding in the Property Inspector. Until it is set, the key shows the missing-binding warning and the Property Inspector says the binding is not set.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Selected Control

Work the controls inside the black box that is open. Many of iRacing's black boxes, such as the In-Car box with brake bias or the Pit-Stop box with its requests, have a selected control: you move the selection between the box's controls, then change or toggle the one selected. This mode puts one of those presses on a key, picked from the **Control** dropdown, so a few neighbouring keys can work a whole box.

The key shows a small d-pad on the black box frame with the part it presses lit: up for Select Previous Control, down for Select Next Control, left for Decrement, right for Increment and the centre for Toggle.

These presses act on whichever box is open. If no black box is open, the press does nothing in the sim — open one first, for example with a Direct key.

iRaceDeck ships all five controls without a key. For each one you use, assign a key in iRacing's controls first, then set the same key on its binding in the Property Inspector or on the [Key Bindings tab](/docs/getting-started/settings/#key-bindings) of iRaceDeck's settings window. Until it is set, the key shows the missing-binding warning and the Property Inspector says the binding is not set.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Setting: Control

Which press on the open box's selected control the key sends (default *Select Next Control*). Each option has its own key binding of the same name.

- **Select Next Control** (default) — moves the selection to the next control in the open box. The key shows **NEXT CTRL**.
- **Select Previous Control** — moves the selection to the previous control. The key shows **PREV CTRL**.
- **Increment Selected Control** — increases the selected control, such as moving brake bias one step. Holding the key repeats it until you let go. The key shows **CTRL +**.
- **Decrement Selected Control** — decreases the selected control. Holding the key repeats it until you let go. The key shows **CTRL -**.
- **Toggle Selected Control** — switches the selected control, for a control that is either on or off. The key shows **CTRL TOGGLE**.

Select Next, Select Previous and Toggle send one press however long you hold the key, so a long press never skips past a control.

## On a dial

Placed on a Stream Deck+ dial or a Mirabox knob, Black Box Selector becomes a black-box dial. Its **Mode** dropdown picks what turning it does: step through iRacing's black boxes (the default), move between the controls of the open box, or change the selected control. A press can jump straight to one box you pick, toggle the open box's size, select or toggle a control, or switch the dial between selecting and changing controls. The Property Inspector automatically shows the dial settings below (instead of the keypad Mode and Black Box) when the instance sits on a dial. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

iRacing reports neither which black box is open nor which control is selected, so the touch strip can't show live state. It shows what a turn does, following the Mode: a "BB" badge and **BLACK BOX** for Cycle Black Boxes, up and down arrows for Select Control, and left and right arrows for Adjust Control. This is the same documented limitation as the other key-binding-driven dials. You can still recolor the strip's border, label, and background in the **Dash Box Appearance** section of the dial settings.

#### Details

- **Method:** Key binding — rotation uses the pair of bindings its Mode turns (see **Mode** below); **Open Selected Box** uses the per-box binding of the box you choose in **Box to Open**, **Toggle Box Size** uses the **Toggle Black Box Size** binding, and the control gestures use the **Select Next Control**, **Select Previous Control** and **Toggle Selected Control** bindings. **Switch Select / Adjust** changes the dial's own Mode — no iRacing command. Black boxes have no iRacing API command, so every dial path needs a binding. Configure them in the **Related Key Bindings** section; the Property Inspector shows a status line indicating whether each is set.
- **Dial:** Rotating taps the Mode's pair of bindings — clockwise for the next box, the next control or an increase, counter-clockwise for the reverse — one tap per detent; a fast spin steps several at once. Both bindings of the chosen Mode must be set.
- **Telemetry-aware:** No — iRacing exposes no open-box or selected-control state, so the touch strip is a static identity readout.

#### Controls

- **Elgato Stream Deck+** — dial rotation, a press (short or long), and a touchscreen readout that always shows. A touchscreen tap or long tap runs its own configured Tap Display / Long Touch action.
- **Mirabox knob** — turn and push, with the same label drawn on the screen above the knob; the Push slot only (see [Dials](/docs/features/dials/#mirabox-knobs)).

#### Setting: Mode

What turning the dial does (the **Mode** dropdown, default *Cycle Black Boxes*). Clockwise is always forward or up.

- **Cycle Black Boxes** (default) — steps through iRacing's black boxes: clockwise taps **Cycle Next**, counter-clockwise **Cycle Previous**, the same bindings the keypad Next and Previous modes use. The strip reads **BLACK BOX**. A dial you set up before this choice existed keeps working this way.
- **Select Control** — moves between the controls of the open box: clockwise taps **Select Next Control**, counter-clockwise **Select Previous Control**. The strip shows up and down arrows.
- **Adjust Control** — changes the selected control of the open box, such as brake bias in the In-Car box: clockwise taps **Increment Selected Control**, counter-clockwise **Decrement Selected Control**. The strip shows left and right arrows.

The strip dims under the missing-binding warning when either binding of the chosen Mode is not set. In Select Control and Adjust Control, turning with no black box open does nothing in the sim.

#### Setting: Box to Open

The black box a press opens directly, used whenever a press or touch gesture below is set to **Open Selected Box**. It offers the same eleven boxes as the keypad Direct mode (default *Lap Timing*). Opening a box behaves exactly like a Direct keypad press: it toggles the overlay, so pressing again while that box is already shown closes it. The press taps that box's own key binding — set it in the **Related Key Bindings** section.

#### Setting: Press Action / Long Press

What a short or long press of the dial button does, chosen from:

- **None** — does nothing. The default for both on a Cycle Black Boxes dial.
- **Open Selected Box** — opens the box picked in **Box to Open**.
- **Toggle Box Size** — switches the open black box between its small and large size, like the keypad Toggle Size mode. It needs the **Toggle Black Box Size** binding, which has no default key.
- **Select Next Control** — moves the selection to the next control in the open box, like the keypad Selected Control mode.
- **Select Previous Control** — moves the selection to the previous control in the open box.
- **Toggle Selected Control** — switches the selected control of the open box. The default Press Action on a Select Control or Adjust Control dial.
- **Switch Select / Adjust** — changes this dial's **Mode** between **Select Control** and **Adjust Control**, and the arrows on the strip change with it. The new Mode is saved with the dial, so it is still there after a restart, and the Mode dropdown in the Property Inspector shows it. It sends nothing to iRacing and needs no binding. On a Cycle Black Boxes dial it does nothing. The default Long Press on a Select Control or Adjust Control dial. On a Stream Deck+, once you have held long enough the strip already shows the other Mode's arrows above a small bar, so you can let go when you see them; turning or letting go early keeps the current Mode.

The three control gestures need their bindings, which have no default key.

On a **Select Control** or **Adjust Control** dial, a Press Action you have not chosen is **Toggle Selected Control** and a Long Press you have not chosen is **Switch Select / Adjust**, and the Property Inspector shows them selected. Once you pick an option, **None** included, your choice stays whatever the Mode. A **Cycle Black Boxes** dial keeps **None** for both, so a dial you set up before this release works as it did. A Mirabox knob has no long press, so there only the Press Action default applies.

A press is classified when you release the dial — a hold past the [Long-press threshold](/docs/features/dials/#the-long-press-threshold) fires the Long Press action. Turning the dial while pressed does what a turn does (a "push + turn") and never fires the press action.

:::tip
Set the Mode to **Select Control** and one dial works the whole box with the defaults: turn to move to the control you want, long-press to switch to **Adjust Control**, then turn to change it or press to toggle it. Long-press again to go back to selecting. Open the box first, for example with a Direct key. A Mirabox knob has no long press, so there set Press Action to **Switch Select / Adjust**, or keep the Mode on **Adjust Control** with Press Action on **Select Next Control**: press to move to the next control, turn to change it.
:::

#### Setting: Tap Display / Long Touch

Optional touch-strip gestures (Stream Deck+ only), each offering the same choices as Press Action: **None**, **Open Selected Box**, **Toggle Box Size**, **Select Next Control**, **Select Previous Control**, **Toggle Selected Control** or **Switch Select / Adjust**. Both default to **None** on every Mode for VR safety.
