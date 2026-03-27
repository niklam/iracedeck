---
title: Key Bindings
description: How keyboard shortcuts and SimHub Control Mapper roles work in iRaceDeck.
---

Many iRaceDeck actions use keyboard shortcuts to control iRacing. These shortcuts are fully customizable to match your iRacing configuration. As an alternative, bindings can also trigger [SimHub Control Mapper](https://github.com/SHWotever/SimHub/wiki/Control-Mapper-plugin) roles.

## Global Key Bindings

Key bindings in iRaceDeck are **global** — they are shared across all instances of an action type. If you change a key binding on one Black Box Selector button, that change applies to every Black Box Selector on your device.

This means you only need to configure your key bindings once, not per button.

## Customizing Key Bindings

Each action that uses keyboard shortcuts has a **Related Key Bindings** section in the Property Inspector (the settings panel on the right side of the software). Open the collapsible section to see all configurable key bindings for that action type.

The defaults match iRacing's default key configuration. If you've changed your iRacing key bindings, update the matching iRaceDeck bindings to keep them in sync.

## Binding Modes: Keyboard vs SimHub

Each key binding has a small icon dropdown on the left side that lets you switch between two modes:

- **Keyboard** (default) — sends a keyboard shortcut to iRacing
- **SimHub** — triggers a SimHub Control Mapper role instead

### When to use SimHub mode

SimHub Control Mapper lets you map physical controller inputs (buttons, switches) to virtual controls. This is especially useful when you:

- **Have multiple wheels** — Control Mapper handles wheel hot-swapping so you don't need to rebind controls in iRacing when switching between wheels
- **Want the same action on your wheel and your deck** — map a button on your wheel and a button on your Stream Deck/Mirabox to the same SimHub role, so either one triggers the same action
- **Already use SimHub for input mapping** — if you've set up roles for your hardware, you can reuse them directly from your deck without duplicating key bindings

### Setting up SimHub Control Mapper

1. Install [SimHub](https://www.simhubdash.com/) if you haven't already
2. Enable the **Control Mapper** plugin in SimHub (Add/Remove Features)
3. **Set up a virtual controller** — Control Mapper needs a virtual or physical game controller to map roles to. You have two options:
   - **Software**: Install [vJoy](https://sourceforge.net/projects/vjoystick/) (free) — it creates a virtual joystick that SimHub can use
   - **Hardware**: Connect an **Arduino Pro Micro** or **Arduino Leonardo** — these appear as native USB game controllers and work out of the box with SimHub
4. Configure your roles in the Control Mapper settings — see the [Control Mapper wiki](https://github.com/SHWotever/SimHub/wiki/Control-Mapper-plugin) for detailed setup instructions
5. In iRaceDeck, switch any key binding to SimHub mode and select the role from the autocomplete dropdown

### SimHub connection settings

iRaceDeck connects to SimHub's HTTP API to fetch available roles and trigger them. The default connection is `127.0.0.1:8888` (SimHub's default). If your SimHub instance runs on a different host or port, update the settings in the **Global Settings** section of any action's Property Inspector.

When SimHub is not running or unreachable, bindings configured in SimHub mode will show an inactive overlay on the button.

## SDK vs Keyboard Actions

Not all actions use keyboard shortcuts. Many actions communicate directly with iRacing through the SDK, which is more reliable and doesn't depend on key bindings at all. These include:

- **Pit service** actions (fuel, tires, fast repair)
- **Chat** actions (macros, reply, whisper)
- **Replay** transport and navigation
- **Camera** switching and focus
- **Telemetry** recording controls

Actions that use the SDK work regardless of your iRacing key configuration. See the [Keyboard Shortcuts](/docs/reference/keyboard-shortcuts/) reference for which actions use the SDK.
