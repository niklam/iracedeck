# Pit Crew

Multi-mode action covering the iRaceDeck pit-side audio framework. Modes available today: **Race Engineer Toggle** (gates the voice scenario engine), **Radar** (toggles the directional proximity tick loop), and **Radar Volume** (steps the radar volume up or down). The Race Engineer voice catalog covers pit-service confirmations, pit-lane callouts, and the full set of flag transitions described below.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.pit-crew` |
| Type | Multi-toggle / Incremental |
| SDK Support | No |
| Encoder Support | No |

## Default state

Both `raceEngineerEnabled` and `radarEnabled` ship **off** (issue #378). A fresh install — and any user who has never pressed either toggle — stays quiet until they explicitly enable the feature with a Race Engineer Toggle or Radar key press. The status bar on each toggle's icon paints red on first launch, flipping green only after the first press.

## Behavior

### Button Press
- **Race Engineer Toggle mode**: Flips the plugin-global `raceEngineerEnabled` gate. When off (the default), both `AudioBus.Voice` (engineer messages, acks, toggle confirmations) and `AudioBus.Background` (pit ambient loop and walkie-talkie SFX) are zeroed synchronously, so any in-flight clip silences on the same key press. `AudioBus.Alerts` (radar) is intentionally untouched — radar has its own toggle. Re-enabling restores Voice to the configured `Race Engineer Volume` and Background to unity. The engineer plays a short voice acknowledgment on every press ("Okay, going silent." on disable, "Roger, resuming communication." on enable) — disable from **Race Engineer Callouts → Race Engineer Toggle** to keep the toggle silent.

### Telemetry-connect radio check

When iRacing telemetry first starts flowing into the plugin (false → true SDK connection transition), the Race Engineer announces "<name>, radio check. Standing by." so the driver has audible confirmation that the plugin is talking to iRacing. Gated on both the Race Engineer master gate AND a dedicated per-callout opt-in (**Race Engineer Callouts → Telemetry Connect**) so the user can keep the master ack but suppress the connect line, or vice versa. Module-level dedup across every visible Pit Crew instance ensures the line fires at most once per real connect; reconnecting (iRacing close + relaunch, transient SDK drop) replays it.
- **Radar mode**: Flips the plugin-global `radarEnabled` and stops/starts the directional proximity tick loop synchronously. Off by default — pressing the key once starts the loop. Used by Radar alongside the per-instance Radar Test button.
- **Radar Volume mode**: Steps the plugin-global `radarVolume` by ±5, clamped to 0–100. Takes effect immediately on `AudioBus.Alerts`. Direction is configured per button (Up or Down). Stepping to 0 mutes the radar without toggling the feature off.

### Race Engineer voice coverage

When the engineer is enabled, the Pit Crew catalog confirms every meaningful pit-service change made via the Tire Service / Pit Service actions:

- **Fuel** — separate on / off callouts.
- **Tire selection** — exhaustive across the 15 non-empty 4-corner combinations: the 5 standard preset patterns (all / fronts / rears / lefts / rights), all 4 single-corner picks, both diagonals (LF + RR, RF + LR), and all 4 three-corner combos (skip LF / RF / LR / RR). Clearing the selection plays a "skipping tires" callout.
- **Tire compound** — dry / wet switches play a dedicated compound line. iRacing forces all four tire bits on at the same instant the compound flips; the translator suppresses the cascading tire-set event so only the compound callout plays.
- **Windshield tearoff** — separate on / off callouts on each toggle.
- **Fast repair** — separate on / off callouts on each toggle.

Flag transitions are also voiced — every flag the iRacing translator publishes gets a dedicated engineer callout:

- **Yellow** — scope-aware: full-course yellow ("pace car deployed") and local sector yellow ("mind the slow cars") play different lines.
- **Yellow cleared** — engineer announces when the yellow drops.
- **Green** — race-restart / race-on callout.
- **Blue** — alternates between two recorded variants ("faster car approaching" / "check your mirrors").
- **White** — final-lap alert.
- **Red / Black / Debris** — single dedicated callout each.
- **Checkered** — session-aware: practice, qualifying, and race finishes get distinct lines.
- **Meatball** — the only flag callout marked **urgent + preempt**: it cancels in-flight engineer chatter mid-message, since failing to pit on a meatball costs a black-flag penalty. All non-meatball flag callouts share a `flag` family so a newer flag preempts an older one (no "yellow's clear" + "green flag" double-talk on race restart).

The engineer also reads a **session-start brief** the first time you go on track in **practice or qualifying** sessions: a greeting by name, the session type, the pit speed limit, track and air temperature, and track wetness. Units follow iRacing's display setting; the pit speed limit is spoken exactly, and is skipped when the live limit isn't a value the engineer has a clip for. It can be toggled off independently in the **Race Engineer Callouts → Session Start** Property Inspector section.

In **race** sessions the brief is replaced by a dedicated **race-start callout** fired ~3 s after the session changes to a race (you can still be in the pit/garage). It greets the driver by name, reports the qualifying-finish (grid) position — "Starting from pole. Well done." for P1, "Qualifying put us to P*n*." for P2..P64, or skips the position clause entirely if the position isn't yet populated or is out of range — and reads the same track + air temperature + wetness brief as the session-start callout (no pit speed limit; you heard it during practice / qualifying). It's toggleable independently from the session-start brief in **Race Engineer Callouts → Race → Race start**.

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Mode | Dropdown | Race Engineer Toggle | Selects what the key press does |
| Direction | Dropdown | Up | Up / Down step, visible only when Mode = Radar Volume |

### Mode Options
- **Race Engineer Toggle** - Toggles the engineer voice on/off
- **Radar** - Toggles the directional proximity ticks on/off
- **Radar Volume** - Steps the global Radar volume up or down

### Direction Options
- **Up** - Bumps Radar volume by 5 (max 100)
- **Down** - Reduces Radar volume by 5 (min 0)

### Plugin-global Audio Settings (in the Pit Crew accordion, not under Global Settings)

The Pit Crew Audio accordion in the action's Property Inspector hosts every plugin-wide audio control. Race Engineer settings appear first, Radar second, and the shared Output Device last.

- **Race Engineer Voice** - dropdown of voices available under `voice/<voice>/` in `@iracedeck/audio-assets`. Substituted into scenario `base: "voice/{voice}"` at clip-resolution time so a swap takes effect on the next scenario fire. Falls back to the first available voice if the persisted choice is gone.
- **Driver Name** - dropdown populated from clips under `voice/<voice>/names/` for the active voice. Picked into the welcome / test playback flows via the engine's variable resolver. Falls back to the first available name when the persisted choice is gone.
- **Race Engineer Volume** (range 0–100, default 50) - slider that controls the Voice bus volume. Mirrored by a **Test** button that auditions a chained sequence (opener → driver name → "Nice to meet you" → "Let's win some races") in the picked voice at the picked volume, so the user can verify the mix without leaving the PI.
- **Background Volume** (range 0–100, default 25) - slider that controls the Background bus volume (pit ambient loop + walkie-talkie open/close SFX). Mirrored by a **Test** button that previews a representative tick-open + ambient + tick-close sequence. Only takes effect while Race Engineer is enabled — when the engineer is off, Background is muted regardless of this value (issue #471).
- **Radar Volume** (range 0–100, default 50) - slider that controls the Alerts bus volume. Mirrored by its own **Test** button that fires a one-shot directional ping. Stepping to 0 mutes the radar without toggling the feature off.
- **Output Device** - audio device used for the iRaceDeck audio engine; shared globally across the plugin. Persisted by the platform-stable device id (WASAPI endpoint ID on Windows), so the selection survives device-list reordering, replug, and OS audio-preference changes.

## Keyboard Simulation

None. Pit Crew drives its own audio framework; it does not emit keyboard events.

## Icon States

Radar mode paints a status bar on the lower third of the key (green when the feature is on, red when off). Radar Volume modes paint no status bar — the current volume shows as a percentage in the title.

| Mode / State | Icon |
|--------------|------|
| Radar — on | Radar-sweep glyph, status bar green |
| Radar — off | Radar-sweep glyph, status bar red |
| Radar Volume Up | Radar glyph + up arrow, title shows `VOL +` and current % |
| Radar Volume Down | Radar glyph + down arrow, title shows `VOL −` and current % |

## See also

- Audio architecture design: `docs/plans/2026-04-19-audio-architecture-design.md`.
- AI Spotter Controls (separate action wrapping iRacing's built-in AI spotter — different system, different audio source): `docs/plugins/core/actions/ai-spotter-controls.md` (if present).
