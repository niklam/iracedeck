---
title: Press Sounds
description: Hear a short click when a key or dial press acts and a bleep when a hold reaches the long-press threshold, so you know a press landed without looking at the deck.
---

Press Sounds lets you hear your presses land. A short, dry **click** confirms a tap, and a short two-note **bleep** tells you a held key or dial has reached the long-press threshold. It is made for VR and for anyone who would rather keep their eyes on the track than check the deck.

**It is off by default.** Nothing plays until you choose a sound.

## Turning It On

Open the [Settings window](/docs/getting-started/settings/#general) and find the **Press Sounds** card on the **General** tab. The **Press sound** dropdown has four choices:

- **No sound** (the default) — presses make no sound.
- **Taps** — a click when a press acts as a tap.
- **Long-press** — a bleep when a hold reaches the long-press threshold.
- **Both** — the click and the bleep.

The **Test click** and **Test bleep** buttons beside it play each sound at the level a press would use, whatever the dropdown says and whether or not iRacing is running, so you can hear both before you choose.

Press sounds play only while iRacing is connected. With iRacing closed, a press reaches nothing in the sim, so a sound would confirm something that did not happen.

## When a Press Clicks

The click plays at the moment the press does its job:

- **Most keys act the moment you press them**, and click then.
- **A key or dial that does one thing on a tap and another on a long press** acts when you let go, so it clicks when you release a short press. A long press never clicks. That covers the setup keys' View sub-modes with dual-press on, Car Control's **Wipers and Visor** on a car with wipers, and the Stream Deck+ dials.
- **A tap on the Stream Deck+ touch strip** clicks.

## When a Press Bleeps

The bleep plays once, at the long-press threshold, and never again however long you keep holding:

- **On a dual-press key or a Stream Deck+ dial**, the bleep means "let go now and you get the long-press action". Hold until you hear it, then release.
- **On Car Control's hold controls** — Starter, Headlight Flash, Handbrake, Second Clutch, and Enter/Exit/Tow and Escape without auto-hold — the press clicks as the control engages and bleeps once you have held it past the threshold.
- **A Long Touch on the touch strip** bleeps.

Keys whose hold just repeats, such as the setup **+ / −** keys, never bleep: letting go of a repeating key only stops it, so there is nothing for the bleep to promise.

The bleep comes at the **Long-press threshold** set on the **Dual-Press** card of the same tab (default 500 ms), the same threshold every long press uses. See [The Long-press threshold](/docs/features/dials/#the-long-press-threshold).

## What Stays Quiet

- **A gesture set to None.** A dial or touch slot that does nothing makes no sound, short or long — a click for a press that did nothing would be a false confirmation.
- **Push + Turn.** Turning a dial while its button is held is silent, also when the turn comes after the bleep would have been due.
- **Push to Talk**, on a key or a dial. A click as the microphone opens is the sound most likely to be transmitted.
- **Volume steps** on Audio Controls, AI Spotter Controls and the Pit Crew key's Radar Volume mode. Every step already plays its own [volume tick](/docs/actions/audio-voice/audio-controls/#a-tick-on-every-step), which is that press's sound.

## Devices

- **Stream Deck and Stream Deck+** — everything on this page: keys, dial presses with the bleep, and the touch strip.
- **Mirabox** — keys behave exactly as on a Stream Deck. A knob clicks the moment you push it and never bleeps, because a knob push has no long press (see [Mirabox knobs](/docs/features/dials/#mirabox-knobs)).
- **Ulanzi** — keys only, the same as on a Stream Deck.

## How Loud

Press sounds play at your iRaceDeck **Radar** volume, set on the [Race Engineer](/docs/getting-started/settings/#race-engineer) tab — the level every iRaceDeck tone follows, the volume tick included. Below 20 they play at 20, so they stay audible at a low radar level and a Radar volume of 0 does not silence them; to turn them off, set **Press sound** to **No sound**.

They play apart from the Race Engineer and the radar, so a click never cuts off a call or a radar tick, and neither of those cuts off a click.
