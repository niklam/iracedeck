---
title: Flags Overlay
description: See yellow and blue flags flash directly on your Stream Deck buttons during racing.
---

The Flags Overlay shows race flag colors directly on your Stream Deck buttons, flashing on top of the key icons when the corresponding flag is active during a session.

## Supported Flags

- **Yellow flag** — flashes yellow when a local yellow is waving
- **Blue flag** — flashes blue when you are being shown the blue flag

## Enabling the Overlay

The Flags Overlay is configured per action through **Common Settings**, which is available in the Property Inspector for every iRaceDeck action. Open the Common Settings section and enable the flags you want to see on that button.

You can enable it on as many or as few buttons as you like — for example, only on a central button you always glance at, or across your entire Stream Deck layout for maximum visibility.

## How It Works

When a flag becomes active during racing, the selected buttons flash the flag color on top of their normal icon. When the flag clears, the buttons return to their normal appearance. The overlay does not interfere with the button's action — you can still press it as usual while the flag is flashing.

## Flash Duration

By default the flash plays for **15 seconds** after a new flag transition, then stops automatically — even if the flag is still raised. The intent is to give a clear "new event happened" beat without the sustained distraction of a flag flashing for the entire duration of a long full-course yellow.

A new flag transition during the window starts a fresh timer, so the driver always gets the announcement when something changes.

You can change the duration in the [Settings window](/docs/features/settings-window/), on the **Appearance** tab under **Flag Flash** (the slider ranges from 0 to 30 seconds in 1-second steps). Setting it to **0** disables the auto-stop and reverts to the original behaviour: the flash continues for as long as the flag is raised.
