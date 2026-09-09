---
title: Focus iRacing Window
description: iRaceDeck can bring iRacing to the foreground before sending keystrokes, to keep keyboard-driven actions from being lost to another window — always, only when a keystroke needs it, or never.
---

Focus iRacing Window brings the iRacing window to the foreground before iRaceDeck sends a command. Windows delivers keystrokes only to the window that has focus, so without it a button press can simply do nothing — with no error, and nothing on screen to explain why.

**This is on by default.** New installations of iRaceDeck focus iRacing automatically, so actions work out of the box.

## Why It Matters

It matters for any action that works by pressing keys — anything driven by a key binding, and anything that sends a chat message or pit macro. Those reach iRacing as keystrokes, and Windows hands keystrokes to whichever window is in front. Actions that talk to iRacing directly through its own command interface (most pit service, camera, and replay controls) are unaffected: those arrive whatever has focus. So do bindings routed through a SimHub role.

It matters most if you run iRacing in **windowed mode**, where another application can easily hold focus when you reach for the deck. It also covers the moments you might not think about: you tabbed out to check a message, clicked something on a second monitor, or a notification popped up and took focus.

When iRacing is already the active window — which is most of the time while you're driving — focusing costs nothing and changes nothing. It only does something when focus was somewhere else.

Focusing is best-effort, not a guarantee — it can't help if iRacing isn't running, and it can't take the foreground away from an application Windows won't let it. If your actions still don't reach iRacing with this on, the usual cause is iRaceDeck and iRacing running at different Windows privilege levels; iRaceDeck detects that and shows a warning at the top of the Property Inspector. See [Troubleshooting](/docs/getting-started/troubleshooting/).

## The Three Modes

Focus iRacing Window is a **global setting**: one choice that applies to all of iRaceDeck, not per button. You'll find it in the [Settings window](/docs/getting-started/settings/#general), on the **General** tab, as **Focus iRacing**.

- **Always** (the default) — iRacing is brought forward before every key press, dial press and dial turn, whatever the key does. Pressing a deck key means "I'm going to the sim".
- **When required** — iRacing is brought forward only before something that actually needs the foreground: a keyboard binding, a chat command (the Chat action, the tire-service `#t` macros), or a touch-strip gesture that taps a binding. Keys that talk to iRacing over its API, bindings routed through a SimHub role, and keys that never touch iRacing at all — Switch Profile, Audio Controls, the Race Engineer toggles, the display keys — leave your window alone. Choose this if you press deck keys while working in another application and only want iRacing pulled over it when a keystroke is about to go there.
- **Never** — iRaceDeck never changes which window has focus. Keyboard-driven actions then need iRacing in front on their own.

Gestures on the Stream Deck+ **touch strip** are covered in both **Always** and **When required**: a tap or long touch that fires a key binding focuses iRacing first.

One key ignores this setting on purpose: the View Adjustment action's **Mouse to Sim** mode focuses iRacing even under **Never**, because pressing that key is an explicit request to go to the sim.

## Upgrading From an Earlier Version

If you already had iRaceDeck installed, **your existing choice is kept**: the old switch becomes **Always** if it was on and **Never** if it was off. Nothing changes on its own. Since the setting was off by default before 3.0, a long-standing installation that never touched it is most likely on **Never** — open the [Settings window](/docs/getting-started/settings/#general) and check the **General** tab to be sure.

The change takes effect immediately — no restart needed.
