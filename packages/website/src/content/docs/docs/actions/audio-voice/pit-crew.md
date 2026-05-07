---
title: Pit Crew
description: Directional proximity radar driven by the iRaceDeck audio framework.
sidebar:
  badge:
    text: "2 modes"
    variant: tip
---

Pit Crew bundles iRaceDeck's pit-side audio into one Stream Deck action. It exposes **Race Engineer Toggle** (the default — flips the engineer voice on/off), **Radar** (directional proximity ticks when a car pulls alongside), and **Radar Volume** (Up/Down stepping for the radar volume).

Both the Race Engineer and Radar gates ship **off by default** so a fresh install stays quiet until you opt in. The first press of each toggle is what enables it; the on/off state is plugin-wide, so two Pit Crew buttons (e.g. one on a Stream Deck, one on a Mirabox) always agree.

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector. For the Radar Volume mode, also pick **Up** or **Down** from the **Direction** dropdown.

### Race Engineer Toggle

The default mode. Pressing the button flips `raceEngineerEnabled` in plugin-global settings (off by default). When off, both the engineer voice (Voice bus — messages, acknowledgments, toggle confirmations) and the pit ambience (Background bus — pit ambient loop and walkie-talkie SFX) are silenced synchronously, so any in-flight clip cuts off on the same key press. Radar ticks are unaffected — they have their own toggle. Re-enabling restores Voice to the configured Race Engineer Volume and Background to the configured Background Volume.

#### Details

- **Dial:** Not supported
- **Default binding:** None — button-driven feature, no keyboard binding
- **Telemetry-aware icon:** Yes — the status bar reflects the current global flag

### Radar

Toggles the directional proximity tick loop on/off. Pressing the button flips `radarEnabled` in plugin-global settings (off by default) and synchronously stops or starts the tick loop on `AudioChannel.Radar` (so a tick can't fire after the user already muted it). The status bar flips green ↔ red.

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

- **Race Engineer Voice** — dropdown of voices available under `voice/<voice>/` in `@iracedeck/audio-assets`. Substituted into scenario `base: "voice/{voice}"` at clip-resolution time so a swap takes effect on the next scenario fire. Falls back to the first available voice if the persisted choice is gone.
- **Your Name** — name the engineer addresses you by; resolves a clip from `voice/<voice>/names/`.
- **Race Engineer Volume** (0–100, default 50) — slider + Test button for the engineer voice (`AudioBus.Voice`). Sliding to 0 silences voice scenarios without disabling the Race Engineer feature.
- **Background Volume** (0–100, default 25) — slider + Test button for the pit ambience and walkie-talkie SFX (`AudioBus.Background`, which carries both the ambient loop and the radio open/close SFX). The Test button plays a representative tick-open + ambient + tick-close preview. Defaults to 25 so it sits under the engineer voice cleanly out of the box; turn it up if you want a louder pit-lane atmosphere. Only takes effect while Race Engineer is enabled — when the engineer is off, Background is muted regardless of this value.
- **Radar Volume** (0–100, default 50) — slider + Test button. Shared across every Pit Crew instance; the button lets you preview the left → right → both sequence without waiting for a live proximity event. Sliding to 0 mutes the radar without toggling the feature off.
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

Pit-service confirmations (fuel on/off, every tire-set selection, dry/wet compound switch, windshield-tearoff on/off, fast-repair on/off) continue to fire on the relevant Tire Service / Pit Service action presses.

The engineer also calls out every iRacing-reported pit-service status transition during the stop itself — "crew working", "all done", positioning corrections ("too far left, line it up", etc.), and "crew can't fix that this stop" — so you can keep your eyes on the windscreen and react by ear.

## Pit Service Readback

Per-toggle confirmations alone fall short when several services are queued back-to-back — only the most recent one is heard in full and you lose the holistic picture of what's queued. The pit-service readback fixes that with a coherent recap at two key moments:

- **Pit entry** — as you roll onto pit road the engineer reads the queued plan: *"Don't forget your limiter. We're taking fuel, four tires, and cleaning the windshield."* The limiter pre-opener only plays when the limiter isn't already engaged.
- **Pit exit** — a few seconds after you leave pit road the engineer plays a short *"To confirm: …"* recap of what was serviced. The settle delay keeps the line from colliding with the limiter / pit-exit chatter.

The readback is composed from per-slot clips (opener, fuel, tires-or-compound, fast repair, windshield, closer) so the catalog stays bounded. While you're still on pit road, toggling a service refires the readback so the recap reflects the latest plan — the running readback is preempted and replaced wholesale, distinct from the per-toggle confirmations which merge live.

When nothing is queued, the engineer plays a dedicated *"Not changing tires, not refueling."* line instead of stitching a series of negatives.

The fast-repair line in both readbacks is **damage-aware**: the engineer stays silent about repairs on a clean car (regardless of whether you happened to queue fast-repair). When iRacing reports damage on the car, the readback speaks the appropriate line — *"We're doing fast repairs to any damage you might have."* if fast-repair is queued, or *"We're not doing fast repair."* as a heads-up if it isn't. This stops the engineer blurting fast-repair status during routine green-flag stops while still flagging when you've forgotten to queue a repair on a damaged car.

## Damage Heads-Up

Drivers focused on the racing line can miss small impacts — a tap on the wall, an inside-line bump. The Race Engineer fires a spoken heads-up the first time iRacing reports damage that requires repair, so you know to consider a pit stop without having to look away from the track. The callout fires once on each clean → damaged transition (after a short debounce window that filters frame-rate flicker), and re-fires after a repair if you pick up new damage later.

## Pit Service Status

Once the car is in the box, iRacing's status display tells you whether the crew is working, whether you're parked correctly, and whether the queued damage repair is actually feasible. The Race Engineer reads each of those state transitions out loud so you don't have to glance at the status box mid-stop:

- **In progress** — the crew is working on the car ("Crew working.").
- **Complete** — service finished, ready to leave the box ("All done, ready to roll.").
- **Too far left / right / forward / back** — positioning correction; line the car up so the crew can reach the wheels.
- **Bad angle** — the car is parked at an angle the crew can't reach properly.
- **Can't fix that** — iRacing has decided the queued damage repair won't actually be performed this stop. This is the only iRacing-exposed signal that fast-repair / damage repair will fail, and it has no other audio surface.

The eight callouts share a single family so a positioning correction (e.g. *"too far left"* → *"too far right"* while you wiggle into the box) cleanly preempts the previous one without queueing. Closing transitions back to the idle state are silent.

## Race Engineer Callouts (per-subject opt-in/out)

Some sessions throw the same flag over and over — debris that goes on/off every lap, rolling local yellows in a busy multi-class race. The **Race Engineer Callouts** accordion in the Property Inspector lets you switch off any individual callout while keeping the rest. The choice is plugin-global (every Pit Crew button agrees) and takes effect **live**: unchecking a callout stops new ones of that subject on the next event, but does **not** cut a callout already playing.

Under **Flags**, all 11 flag callouts are toggleable, all enabled by default:

- **Yellow (local)**, **Yellow (full course)**, **Yellow cleared**
- **Green**, **Blue**, **White**, **Red**, **Black**
- **Checkered**, **Debris**, **Meatball**

Disabling a flag also disables its preemption — a disabled callout can't interrupt one already playing. When **Meatball** is disabled, no meatball callout fires; the flag itself is still active in iRacing and you'll still see the on-screen indicator.

Under **Pit Service**, three callouts are toggleable independently:

- **Pit entry readback** — the "Don't forget your limiter. We're taking fuel, …" recap that fires as you roll onto pit road (and refires on any toggle while you're still on pit road).
- **Pit exit readback** — the "To confirm: …" recap that plays after a short delay once you've left pit road.
- **Pit service requests** — every per-toggle confirmation (fuel on/off, tire-set selection, compound switch, windshield-tearoff on/off, fast-repair on/off). Switching this off silences the engineer on every Stream Deck pit-service press while leaving the readbacks intact.

Disabling any one of the three does not affect the others.

Under **Pit Service Status**, eight callouts are toggleable independently — one per non-idle `PlayerCarPitSvStatus` value, all enabled by default:

- **In progress**, **Complete**
- **Too far left**, **Too far right**, **Too far forward**, **Too far back**
- **Bad angle**, **Can't fix that**

Disabling a status only suppresses future events of that subject; an in-flight callout completes naturally. Disabling all eight silences the in-stop status family while leaving readbacks, flag callouts, and damage heads-ups intact.

Under **Damage**, one callout is toggleable, enabled by default:

- **Repair needed** — the spoken heads-up the engineer plays the first time iRacing reports damage that requires repair (rising edge of `EngineWarnings & (MandRepNeeded | OptRepNeeded)`). Disabling this only silences the live damage callout; the pit-service readback's damage-aware fast-repair line is unaffected.

## Notes

- "AI Spotter Controls" is a separate action that wraps iRacing's own built-in AI Spotter voice. It uses iRacing SDK commands and a different audio source. Pit Crew's Radar is an iRaceDeck-owned non-vocal proximity tick and does not overlap with iRacing's spotter voice.
