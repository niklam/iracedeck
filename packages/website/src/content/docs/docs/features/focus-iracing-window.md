---
title: Focus iRacing Window
description: iRaceDeck brings iRacing to the foreground before sending commands, so button presses are never lost to another window.
---

Focus iRacing Window brings the iRacing window to the foreground before iRaceDeck sends anything to the sim. Windows discards keystrokes and sim commands aimed at a window that isn't in focus, so without it a button press can simply do nothing — with no error, and nothing on screen to explain why.

**This is on by default.** New installations of iRaceDeck focus iRacing automatically, so actions work out of the box.

## Why It Matters

It applies to every iRaceDeck action — both the ones that send keyboard shortcuts and the ones that talk to iRacing directly. Windows blocks background applications from sending either kind of input, so both are affected.

It matters most if you run iRacing in **windowed mode**, where another application can easily hold focus when you reach for the deck. It also covers the moments you might not think about: you tabbed out to check a message, clicked something on a second monitor, or a notification popped up and took focus.

When iRacing is already the active window — which is most of the time while you're driving — focusing costs nothing and changes nothing. It only does something when focus was somewhere else.

## Turning It Off

Focus iRacing Window is a **global setting**: one switch that applies to all of iRaceDeck, not per button. You'll find it in the Property Inspector of any action, under **Common Settings** in the Global Settings section, as **Focus iRacing window before sending keys**.

Turn it off if you'd rather iRaceDeck never changed which window has focus — for example if you regularly press deck buttons while working in another application on a second monitor and don't want iRacing pulled to the front each time.

## Upgrading From an Earlier Version

If you already had iRaceDeck installed, **your existing setting is kept as-is.** The new on-by-default behavior only applies to fresh installations, so an upgrade never changes how your deck behaves. Since the setting used to be off unless you switched it on, that most likely means it is still off for you.

To switch it on, open any action's Property Inspector, expand **Common Settings** under Global Settings, and tick **Focus iRacing window before sending keys**. The change takes effect immediately — no restart needed.
