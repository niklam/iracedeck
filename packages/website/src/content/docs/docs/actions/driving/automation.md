---
title: Automation
description: Background automation that fires car-control commands on telemetry triggers (lap position, pit boundary, interval).
sidebar:
  badge:
    text: "4 modes"
    variant: tip
---

Automation is a background service that fires car-control commands automatically based on telemetry triggers — without you pressing the button. Useful for things like tearing off the visor several times per lap on a dirty windshield, ensuring the pit limiter is always armed at pit entry/exit, or flashing headlights on a configurable interval.

Each Automation button represents one rule. Press the button to toggle the rule **on** (status bar turns green) or **off** (status bar turns red). Rules persist across page switches: once activated, the rule keeps running even when the button is not visible.

## Modes

Select the command from the **Command** dropdown in the Property Inspector. The available triggers depend on which command is selected.

### Tear Off Visor

Automatically tears off the visor at evenly-spaced track positions or on a fixed interval. Useful in dirty races where iRacing's built-in once-per-lap auto-tearoff isn't enough.

#### Details

- **Dial:** No rotation support
- **Default binding:** No default key binding (configure under Car Control)
- **Telemetry-aware icon:** No

#### Setting: Trigger

- **Lap-Based** (default) — Fire at evenly-spaced track positions every lap. Configure **Times Per Lap** (1–20).
- **Interval** — Fire every N seconds while on track. Configure **Interval (seconds)** (1–300).

---

### Pit Limiter

Automatically toggles the pit speed limiter when crossing the pit boundary. More reliable than iRacing's built-in auto-limiter, which sometimes disables itself.

#### Details

- **Dial:** No rotation support
- **Default binding:** `A` (configure under Car Control)
- **Telemetry-aware icon:** No

#### Setting: Operation

The trigger is locked to **Pit Boundary** for this command.

- **Turn on when approaching pits** (default: on) — Fire when telemetry transitions to pit approach.
- **Turn off when leaving pits** (default: on) — Fire when telemetry leaves pit road.

Both checkboxes default to enabled — that's the typical use (limiter on entry, off on exit). If you only want one side, uncheck the other.

---

### Headlight Flash

Flashes the headlights at intervals or evenly-spaced track positions. Use cases include manual safety car for league racing, marshalling drivers ahead, or just for fun.

#### Details

- **Dial:** No rotation support
- **Default binding:** No default key binding (configure under Car Control)
- **Telemetry-aware icon:** No

#### Setting: Trigger

- **Lap-Based** (default) — Fire at evenly-spaced track positions every lap. Configure **Times Per Lap** (1–20).
- **Interval** — Fire every N seconds while on track. Configure **Interval (seconds)** (1–300).

#### Setting: Flash Count

How many flashes to perform per trigger fire. Default 1, range 1–10.

#### Setting: Flash Duration (ms)

How long each flash lasts. Default 200 ms, range 100–1000. The same duration is used for the gap between flashes.

---

### Trigger Wipers

Triggers a single wiper sweep at evenly-spaced track positions or on an interval.

#### Details

- **Dial:** No rotation support
- **Default binding:** `Ctrl+Alt+W` (configure under Cockpit Misc)
- **Telemetry-aware icon:** No

#### Setting: Trigger

- **Lap-Based** (default) — Fire at evenly-spaced track positions every lap. Configure **Times Per Lap** (1–20).
- **Interval** — Fire every N seconds while on track. Configure **Interval (seconds)** (1–300).

## Behavior

Automations are paused automatically when the sim is disconnected, you are off track, or a replay is playing — they never fire while you are watching a replay or sitting in the garage. While paused, the button shows a gray **AUTO N/A** bar so you can see at a glance that an active rule is currently not running. The internal trigger state resets on each pause/resume so you don't see a burst of catch-up fires when you return to the track.

Bindings are reused from the existing **Car Control** and **Cockpit Misc** actions (`carControlTearOffVisor`, `carControlPitSpeedLimiter`, `carControlHeadlightFlash`, `cockpitMiscTriggerWipers`). Configure the global key binding for the command you want to automate before activating the rule, or the rule will run with no observable effect (a warning is logged).
