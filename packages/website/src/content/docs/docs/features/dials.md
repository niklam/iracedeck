---
title: Dials
description: How rotary dial actions work in iRaceDeck on a Stream Deck+ dial and a Mirabox knob — turn, press, long press, push + turn, and touch gestures.
---

Some iRaceDeck actions are built for a **rotary dial** — the dials on an Elgato **Stream Deck+** and the knobs on a **Mirabox** Stream Dock. A dial action also works as a plain keypad button where no dial is present. Ulanzi dials are not supported yet. This page explains the gestures every dial action shares; each action's own page describes what those gestures do for it.

## Gestures

A dial exposes more than one gesture. In an action's Property Inspector, each configurable gesture is a dropdown, so you can map it to whatever that action offers.

- **Turn** — the dial's primary adjustment (for example, raising or lowering a value). Some dial actions are **modal**: what the turn adjusts depends on live state, not a setting.
- **Push** — a short press of the dial button.
- **Long Press** — holding the dial button past the **Long-press threshold** without turning. Because it needs no screen and no touch, it is the **blind-safe** gesture — the one to reach for in VR.
- **Push + Turn** — turning the dial while its button is held. This is a single _bidirectional_ adjustment: the two turn directions are always the same operation with opposite signs (more / less, finer +/−), so it is used for a second or finer axis when an action provides one.
- **Tap Display** — a tap on the touch strip. Stream Deck+ only.
- **Long Touch** — a long press on the touch strip. Stream Deck+ only.

## Mirabox knobs

On a Mirabox knob the action draws its live readout on the screen above the knob, sized for it rather than scaled from the Stream Deck+ strip, and the knob has two gestures: **Turn** and **Push**. Pushing the knob or tapping the screen above it runs the Push action once, the moment you press, however long you hold it. That is a limit of what the Stream Dock software tells plugins — it never reports when you let go of a knob, and a push, a hold, a push + turn and a tap on the screen all arrive as the same press — so Long Press, Push + Turn, Tap Display and Long Touch are not offered on a knob and its Property Inspector shows only the Turn settings, the display colours and the Push slot. Everything an action offers on those other slots can be put on Push, so nothing is out of reach; what you lose is capacity — one gesture per knob instead of up to four — and the fixed push + turn behaviours (Fuel Service's clockwise fill-to-full) have no knob equivalent.

One press action is Stream Deck+ only: Audio Controls' **Push to Talk**. It holds the talk key for as long as you hold the dial and lets go when you release it, and a knob never reports the release — so on a knob it is not offered, and a knob set up with it elsewhere does nothing when pushed.

## How presses are classified

Push, Long Press, and Push + Turn are all decided **when you release** the dial button, from how long it was held (compared against the Long-press threshold) and whether you turned the dial while holding it. Nothing fires mid-hold, so the three gestures never conflict with one another. On a Mirabox knob there is no release to wait for: every push, however long, and every tap on the screen above it runs the Push action once, the moment you press (see [Mirabox knobs](#mirabox-knobs)).

## Seeing the outcome before you let go

On a Stream Deck+, hold the dial button past the Long-press threshold and, where the plugin can tell what will happen, the touch strip shows you — the outcome appears in place of the value, with a small bar under it. So you can hold until you see the change and then release, instead of holding "long enough" and hoping. Turning the dial while still holding it cancels the press as usual, and the strip goes straight back to normal.

Nothing about *when* the action runs has changed: it still runs when you release, and only then. The preview is a display.

It appears on the dials where iRaceDeck can work the result out before you let go:

- **Fuel Service** — the fueling toggle, fill-to-max, the autofuel toggle, and the mode switch
- **Setup Brakes** — ABS on/off
- **Setup Traction** — TC on/off
- **Setup Chassis** — which spring side the dial switches to
- **Camera Controls** — the car number a Focus My Car press will jump to
- **Replay Markers** — the marker a Delete Marker press will remove, or the marker an Add Marker press will place

Every other dial gesture leaves the strip unchanged while you hold. That is deliberate rather than an omission: iRacing reports nothing back for things like recentering VR, opening a black box or toggling the wipers, and for Focus on Leader or Focus on Incident the sim picks the car itself — so there is nothing iRaceDeck can work out in advance. Showing you a guess would be worse than showing you nothing, because the whole point is that you can trust the change you see.

## The touch strip is Stream Deck+ only

**Tap Display** and **Long Touch** act on the Stream Deck+ touchscreen.

Both touch gestures **default to None** for safety: in VR you can't see the strip and a stray brush could fire an action you didn't intend. Turn them on only if you can see the strip (pancake or triple-screen). The action's live readout still shows on the strip regardless — the setting only controls what a _tap_ does.

## Key bindings vs the iRacing API

A gesture talks to iRacing in one of two ways, depending on what you map it to:

- via the **iRacing API** — no setup needed; or
- via a **key binding** — the gesture sends a keyboard shortcut (or a [SimHub Control Mapper](/docs/features/key-bindings/) role) that must be configured.

When a gesture needs a key binding, the Property Inspector shows a small status line under that dropdown indicating whether the binding is set, and the action has a **Related Key Bindings** section where you configure it. See [Key Bindings](/docs/features/key-bindings/) and [Communication Methods](/docs/features/communication-methods/).

## The Long-press threshold

How long you must hold the dial button for a press to count as a **Long Press** is set by the plugin-wide **Long-press threshold** (in the [Settings window](/docs/getting-started/settings/#general) on the **General** tab, default 500 ms, range 200–2000 ms). The same threshold is shared with other long-press features, so one setting tunes them all.
