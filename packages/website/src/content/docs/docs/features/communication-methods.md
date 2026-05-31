---
title: How Actions Talk to iRacing
description: The three ways iRaceDeck actions communicate with iRacing — API, key binding, and chat — and how to tell which one a mode uses.
---

Every iRaceDeck action mode controls iRacing through one of three mechanisms. Which one a mode uses affects how reliable it is and whether you need to configure anything — so iRaceDeck now shows the method, and the binding state, right in the Property Inspector and on the key icon.

## The three methods

### iRacing API

The mode sends a command straight to iRacing through its SDK (the same broadcast channel iRacing's own UI uses). This is the most reliable method: it works regardless of your key bindings, needs no setup, and can't be intercepted by another window.

Examples: pit service (fuel fill, clear tires, fast repair), camera switching and focus, replay transport, telemetry recording.

### Key binding

The mode simulates a control that you've bound — either a **keyboard shortcut** or a **SimHub Control Mapper role**. A key binding is needed when iRacing exposes no SDK command for the feature (camera editor, look-around, black-box pages, most car-setup adjustments, UI toggles).

Key-binding modes only work once the binding is configured, and a keyboard binding must match your iRacing key configuration. See [Key Bindings](/docs/features/key-bindings/) for how to set keyboard shortcuts and SimHub roles.

:::caution[SimHub must be running]
A binding set to a **SimHub** role only fires while SimHub (with the Control Mapper plugin) is running. iRaceDeck polls SimHub and shows a red "SimHub not connected" line in the Property Inspector when it isn't reachable.
:::

### Chat command

The mode types an iRacing chat/text command — typically a `#…` pit macro such as `#fuel`, `#t` (tires), or a race-control command. Chat commands cover features that have neither an SDK command nor a dedicated key binding.

Chat is the least direct method: it opens iRacing's chat box, types the command, and submits it, so it depends on chat being available and can be affected by timing on a busy system.

## Reliability, in short

When iRaceDeck has a choice, it prefers methods in this order:

1. **iRacing API** — direct and reliable, no setup
2. **Key binding** — reliable once configured; depends on your key config (keyboard) or SimHub running (SimHub role)
3. **Chat command** — works everywhere iRacing chat does, but the least direct

A single action can mix all three across its modes. Fuel Service is the clearest example: *Toggle Fuel Fill* and *Clear Fuel* use the API, *Add/Reduce/Set Fuel* use `#fuel` chat macros, and *Toggle Autofuel* / *Lap Margin* use key bindings.

## How to tell which method a mode uses

### In the Property Inspector

Directly under the **Mode** selector, iRaceDeck shows a status line for the current mode:

- ✓ **iRacing API** / ✓ **Chat command** — no binding needed
- ✓ **Key binding: Ctrl+Shift+A** — a keyboard binding is set
- ✓ **SimHub binding: «role»** — a SimHub role is set (plus a red **SimHub not connected** line if SimHub is down)
- ⚠ **No binding set — set it here** — the mode needs a binding and none is configured. The **set it here** link opens the *Related Key Bindings* section so you can set one.

The line updates live as you change the mode or set, clear, or switch the binding.

### On the key icon

When a mode needs a binding and **neither** a keyboard shortcut **nor** a SimHub role is set, the key shows a centered ⚠ warning over its dimmed artwork — so a missing binding is obvious on the deck without opening the Property Inspector. It clears the moment you configure either binding type.

Per-mode method labels also appear in each action's documentation, under the mode's **Details** list.
