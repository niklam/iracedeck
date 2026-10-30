---
title: Press Sounds
description: Hear a single bleep when a key or dial press acts and a double bleep when a hold reaches the long-press threshold, so you know a press landed without looking at the deck.
---

Press Sounds lets you hear your presses land. A short **single bleep** confirms a tap, and a **double bleep** — two of the same short notes — tells you a held key or dial has reached the long-press threshold. It is made for VR and for anyone who would rather keep their eyes on the track than check the deck.

**It is off by default.** Nothing plays until you choose a sound.

## Turning It On

Open the [Settings window](/docs/getting-started/settings/#general) and find the **Press Sounds** card on the **General** tab. The **Press sound** dropdown has four choices:

- **No sound** (the default) — presses make no sound.
- **Taps** — a single bleep when a press acts as a tap.
- **Long-press** — a double bleep when a hold reaches the long-press threshold.
- **Both** — the single and the double bleep.

The **Test tap** and **Test long press** buttons beside it play each sound at the level a press would use, whatever the dropdown says and whether or not iRacing is running, so you can hear both before you choose.

Press sounds play only while iRacing is connected. With iRacing closed, a press reaches nothing in the sim, so a sound would confirm something that did not happen.

## When a Press Bleeps Once

The single bleep plays at the moment the press acts. It tells you the deck took the press, not that the sim did what the key asks: a key whose binding is not set still bleeps.

- **Most keys act the moment you press them**, and bleep once then.
- **A key or dial that does one thing on a tap and another on a long press** acts when you let go, so it bleeps once when you release a short press. A long press never gets the single bleep. That covers the setup keys' View sub-modes with dual-press on, Car Control's **Wipers and Visor** on a car with wipers, and the Stream Deck+ dials.
- **A tap on the Stream Deck+ touch strip** bleeps once.

## When a Press Bleeps Twice

The double bleep plays once, at the long-press threshold, and never again however long you keep holding:

- **On a dual-press key or a Stream Deck+ dial**, the double bleep means "let go now and you get the long-press action". Hold until you hear it, then release.
- **On the keys you hold down to keep a control engaged** — Car Control's Starter, Headlight Flash, Handbrake, Second Clutch, and Enter/Exit/Tow and Escape without auto-hold; Setup Hybrid's Boost and Regen; Splits & Reference's Active Reset Run — the press bleeps once as the control engages and twice once you have held it past the threshold. Look Direction is the exception: it bleeps once as the look starts and never twice, since a look is held on nearly every glance.
- **A Long Touch on the touch strip** bleeps twice.

Keys whose hold just repeats, such as the setup **+ / −** keys, never bleep twice: letting go of a repeating key only stops it, so there is nothing for the double bleep to promise.

On a key or a dial button, the double bleep comes at the **Long-press threshold** set on the **Dual-Press** card of the same tab (default 500 ms), the same threshold those long presses use. See [The Long-press threshold](/docs/features/dials/#the-long-press-threshold). A Long Touch is different: it bleeps twice when the Stream Deck reports the long touch, on the Stream Deck's own timing rather than the Dual-Press threshold.

## What Stays Quiet

- **A gesture set to None.** A dial or touch slot that does nothing makes no sound, short or long — a bleep for a press that did nothing would be a false confirmation.
- **Push + Turn.** Turning a dial while its button is held makes its release silent. Turn before the threshold and there is no double bleep either; turn after it and the double bleep has already played, but the release still makes no sound.
- **Push to Talk**, on a key or a dial. A bleep as the microphone opens is the sound most likely to be transmitted.
- **Volume steps** on Audio Controls, AI Spotter Controls and the Pit Crew key's Radar Volume mode. Every step already plays its own [volume tick](/docs/actions/audio-voice/audio-controls/#a-tick-on-every-step), which is that press's sound.

## Devices

- **Stream Deck and Stream Deck+** — everything on this page: keys, dial presses with the double bleep, and the touch strip.
- **Mirabox** — keys behave exactly as on a Stream Deck. A knob bleeps once the moment you push it and never twice, because a knob push has no long press (see [Mirabox knobs](/docs/features/dials/#mirabox-knobs)).
- **Ulanzi** — keys only, the same as on a Stream Deck.

## How Loud

Press sounds play at your iRaceDeck **Radar** volume, set on the [Race Engineer](/docs/getting-started/settings/#race-engineer) tab — the level every iRaceDeck tone follows, the volume tick included. Below 20 they play at 20, so they stay audible at a low radar level and a Radar volume of 0 does not silence them; to turn them off, set **Press sound** to **No sound**.

They play apart from the Race Engineer and the radar, so a press sound never cuts off a call or a radar tick, and neither of those cuts off a press sound.
