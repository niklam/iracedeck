---
title: Dials
description: How rotary dial (encoder) actions work in iRaceDeck — turn, press, long press, push + turn, and touch gestures.
---

Some iRaceDeck actions are built for a **rotary dial** (encoder) — the knobs on a Stream Deck+, Mirabox, or Ulanzi device. A dial action also works as a plain keypad button where no dial is present. This page explains the gestures every dial action shares; each action's own page describes what those gestures do for it.

## Gestures

A dial exposes more than one gesture. In an action's Property Inspector, each configurable gesture is a dropdown, so you can map it to whatever that action offers.

- **Turn** — the dial's primary adjustment (for example, raising or lowering a value). Some dial actions are **modal**: what the turn adjusts depends on live state, not a setting.
- **Push** — a short press of the dial button.
- **Long Press** — holding the dial button past the **Long-press threshold** without turning. Because it needs no screen and no touch, it is the **blind-safe** gesture — the one to reach for in VR.
- **Push + Turn** — turning the dial while its button is held. This is a single _bidirectional_ adjustment: the two turn directions are always the same operation with opposite signs (more / less, finer +/−), so it is used for a second or finer axis when an action provides one.
- **Tap Display** — a tap on the touch strip. Stream Deck+ only.
- **Long Touch** — a long press on the touch strip. Stream Deck+ only.

## How presses are classified

Push, Long Press, and Push + Turn are all decided **when you release** the dial button, from how long it was held (compared against the Long-press threshold) and whether you turned the dial while holding it. There is no mid-hold timer, so the three gestures never conflict with one another. This also means a knob that reports its release instantly simply treats a hold as a short press — dial gestures work on Stream Deck+, Mirabox, and Ulanzi knobs alike, degrading gracefully where the hardware can't distinguish a hold.

## The touch strip is Stream Deck+ only

**Tap Display** and **Long Touch** act on the Stream Deck+ touchscreen. Mirabox and Ulanzi devices have no plugin-facing touch strip, so those gestures don't apply there.

Both touch gestures **default to None** for safety: in VR you can't see the strip and a stray brush could fire an action you didn't intend. Turn them on only if you can see the strip (pancake or triple-screen). The action's live readout still shows on the strip regardless — the setting only controls what a _tap_ does.

## Key bindings vs the iRacing API

A gesture talks to iRacing in one of two ways, depending on what you map it to:

- via the **iRacing API** — no setup needed; or
- via a **key binding** — the gesture sends a keyboard shortcut (or a [SimHub Control Mapper](/docs/features/key-bindings/) role) that must be configured.

When a gesture needs a key binding, the Property Inspector shows a small status line under that dropdown indicating whether the binding is set, and the action has a **Related Key Bindings** section where you configure it. See [Key Bindings](/docs/features/key-bindings/) and [Communication Methods](/docs/features/communication-methods/).

## The Long-press threshold

How long you must hold the dial button for a press to count as a **Long Press** is set by the plugin-wide **Long-press threshold** (in the global _Common Settings_ section, default 500 ms, range 200–2000 ms). The same threshold is shared with other long-press features, so one setting tunes them all.
