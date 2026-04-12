---
title: Fuel Service
description: Control pit stop fuel amount, autofuel, and lap margin from your Stream Deck.
sidebar:
  badge:
    text: "8 modes"
    variant: tip
---

Full control over your pit stop fueling strategy. Toggle fuel fill with live telemetry feedback, adjust the fuel amount with a fixed macro, toggle autofuel, or fine-tune the lap margin — all without opening the pit menu.

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector.

### Toggle Fuel Fill

Toggle the fuel fill checkbox on or off via the iRacing SDK. The icon shows the current refuel amount from telemetry (in your iRacing display units) with a green ON / red OFF status bar and a matching border color reflecting whether fuel fill is enabled.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — shows the current refuel amount and an on/off indicator driven by `PitSvFlags.FuelFill`

#### Settings

- No additional settings

---

### Add Fuel

Queue an "add fuel" chat macro. Pressing the button sends `#fuel +<amount><unit>$` (e.g., `#fuel +2l$`) to increase the pending fuel for the next pit stop. Dial rotation is bidirectional — clockwise adds, counter-clockwise reduces (using the Reduce Fuel macro) so you can fine-tune with a single dial.

#### Details

- **Dial:** Rotation adjusts fuel (clockwise = add, counter-clockwise = reduce)
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Amount

The increment to add. Numeric — supports comma or period decimal separators (e.g., `1`, `2.5`, `0,5`). Defaults to `1`.

#### Setting: Unit

- **L** (default) — Liters
- **GAL** — Gallons
- **KG** — Kilograms

---

### Reduce Fuel

Queue a "reduce fuel" chat macro. Pressing the button sends `#fuel -<amount><unit>$` (e.g., `#fuel -2l$`) to decrease the pending fuel for the next pit stop. Dial rotation is bidirectional — clockwise reduces, counter-clockwise adds (using the Add Fuel macro).

#### Details

- **Dial:** Rotation adjusts fuel (clockwise = reduce, counter-clockwise = add)
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Amount

The decrement to subtract. Numeric — supports comma or period decimal separators. Defaults to `1`.

#### Setting: Unit

- **L** (default) — Liters
- **GAL** — Gallons
- **KG** — Kilograms

---

### Set Fuel Amount

Queue a "set fuel" chat macro. Pressing the button sends `#fuel <amount><unit>$` (e.g., `#fuel 30l$`) to set the pending fuel to an absolute value.

:::note
When iRacing's autofuel "enable fueling on change" setting is off and your fuel fill checkbox is currently off, the macro uses the `#-fuel` prefix instead of `#fuel` so your fuel fill stays off after the command. You don't need to do anything for this — it happens automatically based on your live pit service state.
:::

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Amount

The target fuel amount. Numeric — supports comma or period decimal separators. Defaults to `1`.

#### Setting: Unit

- **L** (default) — Liters
- **GAL** — Gallons
- **KG** — Kilograms

---

### Clear Fuel

Clear the pending fuel request via the iRacing SDK. Removes the fuel line from the pit service.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Toggle Autofuel

Toggle iRacing's autofuel checkbox on or off. The icon shows the current refuel amount and a green ON / red OFF status bar plus matching border color reflecting whether autofuel is active.

#### Details

- **Dial:** No rotation support
- **Default binding:** `Shift+Ctrl+A`
- **Telemetry-aware icon:** Yes — shows the current refuel amount and an on/off indicator driven by `PitSvFlags.FuelAutofill`

#### Settings

- No additional settings

---

### Lap Margin Increase

Raise the autofuel lap margin by one. Pressing the button taps the iRacing "Lap Margin Increase" hotkey. Dial rotation is bidirectional — clockwise increases, counter-clockwise decreases.

#### Details

- **Dial:** Rotation adjusts lap margin (clockwise = increase, counter-clockwise = decrease)
- **Default binding:** `Shift+Alt+X`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Lap Margin Decrease

Lower the autofuel lap margin by one. Pressing the button taps the iRacing "Lap Margin Decrease" hotkey. Dial rotation is bidirectional — clockwise decreases, counter-clockwise increases.

#### Details

- **Dial:** Rotation adjusts lap margin (clockwise = decrease, counter-clockwise = increase)
- **Default binding:** `Shift+Alt+S`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings
