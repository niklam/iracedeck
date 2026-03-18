---
title: Key Bindings
description: How keyboard shortcuts work in iRaceDeck and how to customize them.
---

Many iRaceDeck actions use keyboard shortcuts to control iRacing. These shortcuts are fully customizable to match your iRacing configuration.

## Global Key Bindings

Key bindings in iRaceDeck are **global** — they are shared across all instances of an action type. If you change a key binding on one Black Box Selector button, that change applies to every Black Box Selector on your Stream Deck.

This means you only need to configure your key bindings once, not per button.

## Customizing Key Bindings

Each action that uses keyboard shortcuts has a **Global Settings** section in the Property Inspector (the settings panel on the right side of the Stream Deck software). Open the collapsible section to see all configurable key bindings for that action type.

The defaults match iRacing's default key configuration. If you've changed your iRacing key bindings, update the matching iRaceDeck bindings to keep them in sync.

## SDK vs Keyboard Actions

Not all actions use keyboard shortcuts. Many actions communicate directly with iRacing through the SDK, which is more reliable and doesn't depend on key bindings at all. These include:

- **Pit service** actions (fuel, tires, fast repair)
- **Chat** actions (macros, reply, whisper)
- **Replay** transport and navigation
- **Camera** switching and focus
- **Telemetry** recording controls

Actions that use the SDK work regardless of your iRacing key configuration. See the [Keyboard Shortcuts](/docs/reference/keyboard-shortcuts/) reference for which actions use the SDK.
