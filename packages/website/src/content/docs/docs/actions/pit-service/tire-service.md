---
title: Tire Service
description: Manage tire changes, per-wheel toggles, and compound selection for pit stops.
sidebar:
  badge:
    text: "4 modes"
    variant: tip
---

Tire Service handles everything tire-related for your pit stops. Change all tires at once, toggle individual wheels, clear tire selections, or switch between dry and wet compounds.

:::note
Tire Service is telemetry-aware — the icon updates with live data from the sim so you always see the current tire state.
:::

## Modes

Select the mode from the **Action** dropdown in the Property Inspector.

### Change All Tires

Request new tires on all four corners. Uses iRacing's `#t` pit chat macro.

**Encoder:** No rotation support.

**Settings:** No additional settings.

---

### Clear Tires

Clear all tire change requests — removes all tires from the pit service.

**Encoder:** No rotation support.

**Settings:** No additional settings.

---

### Toggle Tires

Toggle tire changes per wheel. You choose which tires (LF, RF, LR, RR) the button controls, and how the button behaves when pressed.

**Encoder:** No rotation support.

##### Setting: Operation

- **Select configured tires** (default for new actions) — Clears all tires first, then selects exactly the configured set. Pressing "right side" always results in only the right side tires being selected, regardless of what was selected before. If the configured tires are already the only ones selected, pressing the button clears them.
- **Toggle configured tires** (default for actions created before v1.13.0) — Flips each configured tire without clearing first. The result depends on which tires are currently selected — pressing "right side" when all four tires are selected will turn right side *off*, leaving left side selected.

:::tip
**Select configured tires** is recommended for most setups. It lets you switch between tire configurations (e.g., "all four" → "right side only") with a single button press — useful when pit strategy changes quickly during a caution.
:::

##### Setting: Tires

All four tires are selected by default. Choose which tires the button controls: Left Front, Right Front, Left Rear, Right Rear.

Common configurations:
- **All four** — toggle all tires on/off
- **Left side** (LF + LR) — toggle left side only
- **Right side** (RF + RR) — toggle right side only

When all four, left-only, or right-only tires are selected, the action uses iRacing's shorthand macros (`#!t`, `#!l`, `#!r`) which work even with cars that only support all-or-nothing tire changes.

---

### Change Compound

Cycle through available tire compounds. Each press advances to the next compound (e.g., DRY → WET → DRY).

The available compounds depend on the car — most cars have DRY and WET, while some have additional options like Soft, Medium, and Hard.

**Encoder:** No rotation support.

**Settings:** No additional settings.
