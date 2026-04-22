---
title: Pit Crew
description: Voice engineer + directional proximity radar, driven by the iRaceDeck audio framework.
sidebar:
  badge:
    text: "3 modes"
    variant: tip
---

Pit Crew bundles iRaceDeck's pit-side audio into one Stream Deck action. A **Race Engineer** voice (welcome / pit-lane callouts / flag alerts / incidents / fuel warnings — all coming back in follow-up releases) and a **Radar** (directional proximity ticks on the audio bus when a car pulls alongside) share the action's Mode dropdown. The two features have independent on/off globals, so muting the voice engineer to talk to teammates on Discord doesn't kill the proximity alerts.

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector. For the Radar Volume mode, also pick **Up** or **Down** from the **Direction** dropdown.

### Race Engineer

Toggles the Race Engineer voice on/off for every Pit Crew instance across the plugin. Pressing the button flips `raceEngineerEnabled` in plugin-global settings; the status bar at the bottom of the key flips green ↔ red. Voice scenarios (welcome, pit-lane, flag alerts, fuel warnings, etc.) are deferred to follow-up releases — the toggle today only flips the global flag that those scenarios will read once they return.

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

Steps the global Radar volume up or down. Takes effect immediately on `AudioBus.Alerts` so the next tick plays at the new level. Clamps at 5 (minimum) and 100 (maximum). The key shows the current percentage in its title.

#### Setting: Direction

- **Up** — Bumps `radarVolume` by 5 (max 100)
- **Down** — Reduces `radarVolume` by 5 (min 5)

#### Details

- **Dial:** Not supported
- **Default binding:** None
- **Telemetry-aware icon:** Yes — the title shows the current percentage

## Global Audio Settings (shared across every Pit Crew button)

The Pit Crew accordion in the Property Inspector exposes these plugin-global settings alongside the Mode selector (not under the generic Global Settings section):

- **Radar Volume** (5–100, default 100) — slider + Test button. Shared across every Pit Crew instance; the button lets you preview the left → right → both sequence without waiting for a live proximity event.
- **Output Device** — the audio device used for the iRaceDeck audio engine; shared globally across the plugin.

## Notes

- "AI Spotter Controls" is a separate action that wraps iRacing's own built-in AI Spotter voice. It uses iRacing SDK commands and a different audio source. Pit Crew's Radar is an iRaceDeck-owned non-vocal proximity tick and does not overlap with iRacing's spotter voice.
- Race Engineer Volume Up / Down modes return alongside the first voice-scenario PR; adding them today would be dead UI because no voice audio is registered yet.
