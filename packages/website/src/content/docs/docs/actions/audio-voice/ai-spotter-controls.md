---
title: AI Spotter Controls
description: Control iRacing's AI spotter — damage and weather reports, lap announcements, and volume.
sidebar:
  badge:
    text: "7 modes"
    variant: tip
---

Manage iRacing's AI spotter directly from your Stream Deck. Trigger reports, toggle announcements, or adjust spotter volume without leaving the track. This action is keypad-only, but the spotter volume is also available on a Stream Deck+ dial: the [Audio Controls dial](/docs/actions/audio-voice/audio-controls/#on-a-dial)'s **Spotter** mode turns through these same Spotter Louder / Spotter Quieter bindings, and its press can be set to **Skip Spotter Call**.

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector. Spotter Louder and Spotter Quieter also have a **Key Style** — see [Key Styles](#key-styles--paired--buttons).

### Damage Report

Ask the spotter to read the current damage status.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Weather Report

Ask the spotter to read the current weather conditions.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Toggle Report Laps

Toggle whether the spotter reports lap information.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Announce Leader at S/F Line

Toggle the announcement of the leader crossing the start/finish line.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Spotter Louder

Raise the spotter volume. Each press plays a short, high [tick](#a-tick-on-every-step), so you can count steps by ear.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Setting: Key Style

How the key draws as one half of a +/− pair. Default: **Split** for a newly placed key, **Legacy (arrows)** for an existing one. See [Key Styles](#key-styles--paired--buttons).

---

### Spotter Quieter

Lower the spotter volume. Each press plays a short, low [tick](#a-tick-on-every-step), so you can count steps by ear.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Setting: Key Style

How the key draws as one half of a +/− pair. Default: **Split** for a newly placed key, **Legacy (arrows)** for an existing one. See [Key Styles](#key-styles--paired--buttons).

---

### Skip Spotter Call

Stop the spotter call that is playing right now. It is a one-shot: the spotter keeps talking on its next call. iRacing has no control that mutes the spotter permanently — to hear less of it, lower the volume with Spotter Quieter.

The key reads **SKIP CALL / SPOTTER**. It taps iRacing's *Spotter Silence* key binding, which keeps that name in iRacing's controls screen and in this action's Related Key Bindings section.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

## A tick on every step

iRacing plays no sound when its spotter volume changes and doesn't report the level, so Spotter Louder and Spotter Quieter play one short tick per step: three presses, three ticks. Louder ticks at a higher pitch than Quieter, so a press on the wrong key is heard at once, and a key held in a paired style ticks once for every step it repeats.

- **How loud.** The tick plays at your iRaceDeck **Radar** volume, the level every iRaceDeck sound follows. Below 20 it plays at 20, so it stays audible, and a Radar volume of 0 does not silence it.
- **When it ticks.** Only for a key press that was sent to iRacing: a key with no binding, or a press while iRacing isn't running, makes no tick. iRacing doesn't report when the spotter is already at its loudest or quietest, so at that limit a press still ticks even though nothing changed.
- **No setting.** The tick always plays, whatever the Race Engineer, Radar and callout switches say. The report keys and Skip Spotter Call are not volume steps and make no tick.

The same tick plays when you turn the [Audio Controls dial](/docs/actions/audio-voice/audio-controls/#a-tick-on-every-step) in its **Spotter** mode.

## Key Styles — paired +/− buttons

Spotter Louder and Spotter Quieter can render as one **paired control**: place the two keys next to each other and they read as one spotter volume control with a + half and a − half. Choose the look under **Key Style**:

- **Legacy (arrows)** — the classic speaker icon with its two lines of text (default for existing keys).
- **Big +/−** — a big + or − with the **SPOTTER** label (newly placed keys start on **Split**, which draws this way).
- **Big chevrons**, **Pill end** — alternative pair looks. With **Pill end** the two keys share one frame.
- **Split**, **Edge chevrons**, **Joined pill** — also in the list, and drawn as **Big +/−**, **Big chevrons** and **Pill end** (below).

iRacing doesn't report the spotter volume, so the styles that would show a level are drawn without it: **Split** as **Big +/−**, **Edge chevrons** as **Big chevrons**, **Joined pill** as **Pill end**. The label follows the normal title settings, so you can change or hide it under the title overrides.

**Hold to repeat.** In any style except Legacy, holding the key keeps pressing the Spotter Louder or Spotter Quieter key binding until you let go. A Legacy key steps once per press.

**Big chevrons** and **Pill end** take a **Position in Pair** setting (*Auto* follows the direction: louder on the right, quieter on the left; pick *Top* or *Bottom* for a vertical stack). Colors follow the normal color overrides (the +/− accent is the *Graphic 1* slot); **Pill end** turns the normal border off, because the pill is the frame. The report keys and Skip Spotter Call keep their icons and offer no Key Style.
