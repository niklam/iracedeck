---
title: Setup Chassis
description: Adjust chassis setup options — differential, anti-roll bars, springs, shocks, and power steering — during a session.
sidebar:
  badge:
    text: "22 modes"
    variant: tip
---

Adjust chassis setup options from the cockpit: differential curves, anti-roll bars, spring preloads, shock absorbers, and power steering. Placed on a **Stream Deck+ dial**, the same action becomes a chassis-setup dial with the live value on the touch strip — see [On a dial](#on-a-dial) below.

## View sub-modes

The **View …** entries turn the key into a continuously updating display of the current value in the car. With **dual-press** enabled (default) the same key also adjusts the value: a short press fires one direction and a long press fires the opposite — so one key replaces the separate Increase / Decrease keys you'd otherwise need.

| View setting | Telemetry source | Format | Typical range |
|---|---|---|---|
| View Diff Preload | `dcDiffPreload` | integer | car-dependent slot |
| View Diff Entry | `dcDiffEntry` | integer | car-dependent slot |
| View Diff Middle | `dcDiffMiddle` | integer | car-dependent slot |
| View Diff Exit | `dcDiffExit` | integer | car-dependent slot |
| View Anti-Roll Front | `dcAntiRollFront` | integer | car-dependent slot |
| View Anti-Roll Rear | `dcAntiRollRear` | integer | car-dependent slot |
| View Power Steering | `dcPowerSteering` | integer | car-dependent slot |
| View Weight Jacker Left | `dcWeightJackerLeft` | signed percent | ±a few % |
| View Weight Jacker Right | `dcWeightJackerRight` | signed percent | ±a few % |
| View LR Spring Offset | `dpWeightJackerLeft` | mm or inches, per the sim's display units | pending next-stop value |
| View RR Spring Offset | `dpWeightJackerRight` | mm or inches, per the sim's display units | pending next-stop value |

The two **Spring Offset** Views show the *pending next-pit-stop* LR/RR spring adjustment — the value you dial into iRacing's F7 Pit Stop black box — formatted exactly as the sim displays it (whole millimeters, or three-decimal inches with english display units). Only cars with the F7 spring rows (the stock-car family) expose these fields; on other cars the key shows `---`, and some cars expose only one side.

### Dual-press control

Each View sub-mode exposes a single extra setting in the Property Inspector:

- **Enable dual-press** (default *on*) — when off, the key stays a pure read-only display and presses do nothing. When on, presses dispatch to the matching adjustment binding (e.g. View Diff Preload dispatches to *Diff Preload +* / *Diff Preload −*), so configure those bindings in the **Global Settings → Setup Chassis** section. Weight Jacker Left / Right do not appear as adjustment modes in the Setting dropdown; their +/- bindings still live in **Global Settings → Setup Chassis** so the View can drive them via dual-press.

The tap direction is a single plugin-wide setting under **Global Common Settings → Dual-Press → Directions** (default *Tap increases, long-press decreases*; the long-press always fires the opposite of the tap). The threshold separating "short" from "long" is a sibling setting **Long-press threshold (ms)** (200–2000 ms, default 500 ms). Both take effect on the next press without needing a restart.

## Show black box

Off by default. When enabled, pressing the key opens the iRacing black box the adjusted value lives in, so you can watch it change: **In-Car Adjustments** (F8) for the differential, ARBs, power steering, and weight jackers; **Pit Stop Adjustments** (F7) for the springs and shocks. One checkbox covers every mode of the key, including dual-press adjustments from a View key; hold-to-repeat shows the box once per press, not on every step.

iRacing never reveals which black box is open, and a black box hotkey is a toggle, so iRaceDeck presses a different box first and then the target box. Both keypresses are sent together as one keystroke, so iRacing almost always applies them in the same frame and you never see the first box.

Requires keyboard bindings for the target black box and at least one other black box — set them under **Related Key Bindings** (the In-Car, Pit Stop, and Lap Timing rows are listed there). If either is missing, or is bound to a SimHub role instead of a key, the value still changes but no black box opens.

## Modes

Select the mode from the **Setting** dropdown in the Property Inspector. **Adjust** modes are directional — pick **Increase** or **Decrease** in the **Direction** setting to control what a button press does. **View** modes show a live readout and, with **Enable dual-press** on (default), also accept short / long presses — see [View sub-modes](#view-sub-modes) above. They don't use the per-action **Direction** setting; the tap direction is the plugin-wide **Global Common Settings → Dual-Press → Directions**.

### Differential Preload

Adjust the differential preload value.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Diff Preload + and Diff Preload - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### Differential Entry

Adjust the differential entry (on-throttle) setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Diff Entry + and Diff Entry - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### Differential Middle

Adjust the differential middle (coasting) setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Diff Middle + and Diff Middle - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### Differential Exit

Adjust the differential exit setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Diff Exit + and Diff Exit - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### Front ARB

Adjust the front anti-roll bar stiffness.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Front ARB + and Front ARB - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button stiffens the ARB
- **Decrease** — Pressing the button softens the ARB

---

### Rear ARB

Adjust the rear anti-roll bar stiffness.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Rear ARB + and Rear ARB - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button stiffens the ARB
- **Decrease** — Pressing the button softens the ARB

---

### LR Spring

Adjust the left-rear spring offset applied at the next pit stop (iRacing's F7 *LR Spring Offset* row).

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both LR Spring + and LR Spring - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### RR Spring

Adjust the right-rear spring offset applied at the next pit stop (iRacing's F7 *RR Spring Offset* row).

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both RR Spring + and RR Spring - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### LF Shock

Adjust the left-front shock setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both LF Shock + and LF Shock - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### RF Shock

Adjust the right-front shock setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both RF Shock + and RF Shock - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### LR Shock

Adjust the left-rear shock setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both LR Shock + and LR Shock - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### RR Shock

Adjust the right-rear shock setting.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both RR Shock + and RR Shock - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the value
- **Decrease** — Pressing the button lowers the value

---

### Power Steering

Adjust the power steering assist level.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — both Power Steering + and Power Steering - must be configured in iRacing and in the Property Inspector
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Increase** (default) — Pressing the button raises the assist level
- **Decrease** — Pressing the button lowers the assist level

## On a dial

Placed on a Stream Deck+ dial, Setup Chassis becomes a chassis-setup dial. Pick one component with the dial's **Mode** dropdown; turning the dial steps it up or down in the car, and the touch strip shows that value live as a big, color-coded number. It uses the same key bindings as the keypad modes, so no extra configuration is needed if you already use them. The Property Inspector automatically shows the dial settings below (instead of the keypad Component and Direction) when the instance sits on a dial. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

#### Details

- **Method:** Key binding — the same Setup Chassis increase/decrease bindings the keypad modes use. Configure them in the **Related Key Bindings** section; the Property Inspector shows a status line indicating whether each is set.
- **Dial:** Rotating adjusts the selected component (clockwise = increase, counter-clockwise = decrease). Both the increase and decrease key bindings must be set.
- **Telemetry-aware:** Yes for the differential, anti-roll bars, power steering, and the LR/RR springs — the touch strip shows the live value from telemetry (see the table below; the springs show the pending next-pit-stop offset). Shocks have no telemetry, so their strips show the label only.

#### Controls

- **Elgato Stream Deck+** — dial rotation and a touchscreen readout that always shows.

Dials are currently Stream Deck+ only — the action can't be placed on Mirabox knobs or Ulanzi dials yet (see [Dials](/docs/features/dials/)).

#### Setting: Mode

The chassis component the dial controls (the **Mode** dropdown). Each renders as a color-coded "dash box": a short label on top and the live value as a large number. Each setting has a built-in accent color, but you can override the border, label, value, and background colors in the **Dash Box Appearance** section of the dial settings. Weight jackers and the View sub-modes aren't offered as rotation settings.

| Component | Label | Telemetry source | Shown as |
|---|---|---|---|
| Differential Preload | PRELD | `dcDiffPreload` | integer |
| Differential Entry | D-IN | `dcDiffEntry` | integer |
| Differential Middle | D-MID | `dcDiffMiddle` | integer |
| Differential Exit | D-OUT | `dcDiffExit` | integer |
| Front ARB | FARB | `dcAntiRollFront` | integer |
| Rear ARB | RARB | `dcAntiRollRear` | integer |
| LR Spring | ◀ LR SPR | `dpWeightJackerLeft` | mm or inches, pending next stop |
| RR Spring | RR SPR ▶ | `dpWeightJackerRight` | mm or inches, pending next stop |
| LF Shock | LF | *(none)* | label only |
| RF Shock | RF | *(none)* | label only |
| LR Shock | LR | *(none)* | label only |
| RR Shock | RR | *(none)* | label only |
| Power Steering | PWR | `dcPowerSteering` | integer |

The two spring boxes carry fixed left/right arrow markers flanking the label — the side you're editing lights up while the other stays dim, so LR and RR are distinguishable at a glance mid-race. When a telemetry-backed component has no data the box shows `---` — including the springs on cars that don't expose the F7 spring rows (only the stock-car family does, and some cars expose one side only). Shocks still rotate (they use their increase/decrease bindings); their strips just can't show a live number.

#### Press and touch gestures

Each gesture slot (**Press Action**, **Long Press**, **Tap Display**, **Long Touch**) offers two actions, and all slots default to **None**:

- **Show Pit Stop Black Box** — brings up iRacing's F7 Pit Stop box (the screen the spring offsets live on) regardless of which box was open before. It uses the Black Box key bindings (at minimum *Pit Stop*, plus one other box binding used to switch deterministically), configured under **Related Key Bindings**.
- **Switch LR / RR Spring** — flips the dial's Mode between the LR and RR spring (from any other mode it jumps to LR Spring) and remembers the choice, so one dial covers both rear springs; the lit side-arrow on the strip shows which spring you're editing. Needs no key bindings.

## Key Styles — paired +/− buttons

Adjustment modes with a live value (on Setup Chassis: Differential Preload, Differential Entry, Differential Middle, Differential Exit, Front ARB, Rear ARB, Power Steering, and the LR/RR Springs) can render as **paired keys**: place two keys with opposite directions next to each other (or three, with a View key in the middle) and both show the live value — no separate display key needed. Choose the look under **Key Style**:

- **Legacy (arrows)** — the classic static arrow icon (default for existing keys).
- **Split** — label on top, live value in the middle, a big +/− below (default for newly placed keys).
- **Edge chevrons**, **Joined pill** — alternative value-showing pair looks.
- **Big +/−**, **Big chevrons**, **Pill end** — no-value styles for the outer keys of a 3-key group; the View key in the middle shows the value (set its **Display Style** to *Pill middle* to span the pill across all three keys).

Values are shown without units for maximum size. **Edge chevrons**, **Joined pill**, **Pill end**, and **Big chevrons** take a **Position in Pair** setting (*Auto* follows the direction: increase right, decrease left; pick *Top*/*Bottom* for vertical stacks). Holding a paired key repeats the adjustment until released. Colors follow the normal color overrides (the +/− accent is the *Graphic 1* slot); pill styles disable the normal border — the pill itself is the frame.

Shocks have no live telemetry value, so they stay legacy-only — no Key Style control appears for them. Weight Jacker Left / Right exist only as View sub-modes here; their Display Style dropdown offers the pill-middle options like any other View.
