---
title: Focus iRacing Window
description: iRaceDeck can bring iRacing to the foreground before sending keystrokes, to keep keyboard-driven actions from being lost to another window.
---

Focus iRacing Window brings the iRacing window to the foreground before iRaceDeck sends a command. Windows delivers keystrokes only to the window that has focus, so without it a button press can simply do nothing — with no error, and nothing on screen to explain why.

**This is on by default.** New installations of iRaceDeck focus iRacing automatically, so actions work out of the box.

## Why It Matters

It matters for any action that works by pressing keys — anything driven by a key binding, and anything that sends a chat message or pit macro. Those reach iRacing as keystrokes, and Windows hands keystrokes to whichever window is in front. Actions that talk to iRacing directly through its own command interface (most pit service, camera, and replay controls) are unaffected: those arrive whatever has focus.

It matters most if you run iRacing in **windowed mode**, where another application can easily hold focus when you reach for the deck. It also covers the moments you might not think about: you tabbed out to check a message, clicked something on a second monitor, or a notification popped up and took focus.

When iRacing is already the active window — which is most of the time while you're driving — focusing costs nothing and changes nothing. It only does something when focus was somewhere else.

One gap worth knowing: gestures on the Stream Deck+ **touch strip** are not covered yet, so a touch gesture bound to a key still needs iRacing in front on its own. Buttons and dial rotation and presses are all covered.

Focusing is best-effort, not a guarantee — it can't help if iRacing isn't running, and it can't take the foreground away from an application Windows won't let it. If your actions still don't reach iRacing with this on, the usual cause is iRaceDeck and iRacing running at different Windows privilege levels; iRaceDeck detects that and shows a warning at the top of the Property Inspector. See [Troubleshooting](/docs/getting-started/troubleshooting/).

## Turning It Off

Focus iRacing Window is a **global setting**: one switch that applies to all of iRaceDeck, not per button. You'll find it in the [Settings window](/docs/features/settings-window/), on the **General** tab, as **Focus iRacing window before sending keys**.

Turn it off if you'd rather iRaceDeck never changed which window has focus — for example if you regularly press deck buttons while working in another application on a second monitor and don't want iRacing pulled to the front each time.

## Upgrading From an Earlier Version

If you already had iRaceDeck installed, **your existing setting is kept as-is** — the new on-by-default behavior applies to fresh installations. Since the setting used to be off unless you switched it on, that most likely means it is still off for you. Check the box to be sure: if it is ticked, focusing is active.

To switch it on, open the [Settings window](/docs/features/settings-window/) and tick **Focus iRacing window before sending keys** on the **General** tab. The change takes effect immediately — no restart needed.
