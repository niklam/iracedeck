---
title: Pit Crew
description: Directional proximity radar driven by the iRaceDeck audio framework.
sidebar:
  badge:
    text: "2 modes"
    variant: tip
---

Pit Crew bundles iRaceDeck's pit-side audio into one Stream Deck action. It exposes **Race Engineer Toggle** (the default — flips the engineer voice on/off), **Radar** (directional proximity ticks when a car pulls alongside), and **Radar Volume** (Up/Down stepping for the radar volume).

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector. For the Radar Volume mode, also pick **Up** or **Down** from the **Direction** dropdown.

### Race Engineer Toggle

The default mode. Pressing the button flips `raceEngineerEnabled` in plugin-global settings. When off, both the engineer voice (Voice bus — messages, acknowledgments, toggle confirmations) and the pit ambience (Background bus — pit ambient loop and walkie-talkie SFX) are silenced synchronously, so any in-flight clip cuts off on the same key press. Radar ticks are unaffected — they have their own toggle. Re-enabling restores Voice to the configured Race Engineer Volume and Background to its default mix.

#### Details

- **Dial:** Not supported
- **Default binding:** None — button-driven feature, no keyboard binding
- **Telemetry-aware icon:** Yes — the status bar reflects the current global flag

### Radar

Toggles the directional proximity tick loop on/off. Pressing the button flips `radarEnabled` in plugin-global settings and synchronously stops or starts the tick loop on `AudioChannel.Radar` (so a tick can't fire after the user already muted it). The status bar flips green ↔ red.

#### Details

- **Dial:** Not supported
- **Default binding:** None — button-driven feature, no keyboard binding
- **Telemetry-aware icon:** Yes — the status bar reflects the current global flag

### Radar Volume

Steps the global Radar volume up or down. Takes effect immediately on `AudioBus.Alerts` so the next tick plays at the new level. Clamps at 0 (minimum, fully muted) and 100 (maximum). The key shows the current percentage in its title.

#### Setting: Direction

- **Up** — Bumps `radarVolume` by 5 (max 100)
- **Down** — Reduces `radarVolume` by 5 (min 0)

#### Details

- **Dial:** Not supported
- **Default binding:** None
- **Telemetry-aware icon:** Yes — the title shows the current percentage

## Global Audio Settings (shared across every Pit Crew button)

The Pit Crew accordion in the Property Inspector exposes these plugin-global settings alongside the Mode selector (not under the generic Global Settings section):

- **Radar Volume** (0–100, default 100) — slider + Test button. Shared across every Pit Crew instance; the button lets you preview the left → right → both sequence without waiting for a live proximity event. Sliding to 0 mutes the radar without toggling the feature off.
- **Race Engineer Voice** — dropdown of voices available under `voice/<voice>/` in `@iracedeck/audio-assets`. Substituted into scenario `base: "voice/{voice}"` at clip-resolution time so a swap takes effect on the next scenario fire. Falls back to the first available voice if the persisted choice is gone.
- **Output Device** — the audio device used for the iRaceDeck audio engine; shared globally across the plugin. The selection is persisted by the platform-stable device id (WASAPI endpoint ID on Windows), so it survives replug and Windows audio-preference changes — no need to re-pick after rebooting or moving the headset to a different USB port.

## Race Engineer voice coverage

When the engineer is enabled, the Pit Crew catalog calls out every flag transition the iRacing translator publishes:

- **Yellow** — scope-aware: full-course yellow ("pace car deployed") and local sector yellow ("mind the slow cars") play different lines.
- **Yellow cleared** — engineer announces when the yellow drops.
- **Green** — race-restart / race-on callout.
- **Blue** — alternates between two recorded variants ("faster car approaching" / "check your mirrors").
- **White** — final-lap alert.
- **Red / Black / Debris** — single dedicated callout each.
- **Checkered** — session-aware: practice, qualifying, and race finishes get distinct lines.
- **Meatball** — the only flag callout marked **urgent + preempt**: it cancels in-flight engineer chatter mid-message, since failing to pit on a meatball costs a black-flag penalty. All non-meatball flag callouts share a `flag` family so a newer flag preempts an older one (no "yellow's clear" + "green flag" double-talk on race restart).

Pit-service confirmations (fuel on/off, every tire-set selection, dry/wet compound switch) continue to fire on the relevant Tire Service / Pit Service action presses.

## Notes

- "AI Spotter Controls" is a separate action that wraps iRacing's own built-in AI Spotter voice. It uses iRacing SDK commands and a different audio source. Pit Crew's Radar is an iRaceDeck-owned non-vocal proximity tick and does not overlap with iRacing's spotter voice.
