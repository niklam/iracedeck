# Pit Crew

Multi-mode action covering the iRaceDeck pit-side audio framework. The initial release exposes only the directional Radar proximity ticks. A Race Engineer voice feature is planned and will return to the Mode dropdown in a follow-up release alongside its voice scenarios.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.pit-crew` |
| Type | Multi-toggle / Incremental |
| SDK Support | No |
| Encoder Support | No |

## Behavior

### Button Press
- **Race Engineer Toggle mode**: Flips the plugin-global `raceEngineerEnabled` gate. When off, every voice scenario is suppressed at the audio layer (audio stops immediately).
- **Radar mode**: Flips the plugin-global `radarEnabled` and stops/starts the directional proximity tick loop synchronously. Used by Radar alongside the per-instance Radar Test button.
- **Radar Volume mode**: Steps the plugin-global `radarVolume` by ±5, clamped to 0–100. Takes effect immediately on `AudioBus.Alerts`. Direction is configured per button (Up or Down). Stepping to 0 mutes the radar without toggling the feature off.

### Race Engineer voice coverage

When the engineer is enabled, the Pit Crew catalog confirms every meaningful pit-service change made via the Tire Service / Pit Service actions:

- **Fuel** — separate on / off callouts.
- **Tire selection** — exhaustive across the 15 non-empty 4-corner combinations: the 5 standard preset patterns (all / fronts / rears / lefts / rights), all 4 single-corner picks, both diagonals (LF + RR, RF + LR), and all 4 three-corner combos (skip LF / RF / LR / RR). Clearing the selection plays a "skipping tires" callout.
- **Tire compound** — dry / wet switches play a dedicated compound line. iRacing forces all four tire bits on at the same instant the compound flips; the translator suppresses the cascading tire-set event so only the compound callout plays.

Flag transitions are also voiced — every flag the iRacing translator publishes gets a dedicated engineer callout:

- **Yellow** — scope-aware: full-course yellow ("pace car deployed") and local sector yellow ("mind the slow cars") play different lines.
- **Yellow cleared** — engineer announces when the yellow drops.
- **Green** — race-restart / race-on callout.
- **Blue** — alternates between two recorded variants ("faster car approaching" / "check your mirrors").
- **White** — final-lap alert.
- **Red / Black / Debris** — single dedicated callout each.
- **Checkered** — session-aware: practice, qualifying, and race finishes get distinct lines.
- **Meatball** — the only flag callout marked **urgent + preempt**: it cancels in-flight engineer chatter mid-message, since failing to pit on a meatball costs a black-flag penalty. All non-meatball flag callouts share a `flag` family so a newer flag preempts an older one (no "yellow's clear" + "green flag" double-talk on race restart).

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
- **Race Engineer Volume** (range 0–100, default 100) - slider that controls the Voice bus volume. Mirrored by a **Test** button that auditions a chained sequence (opener → driver name → "Nice to meet you" → "Let's win some races") in the picked voice at the picked volume, so the user can verify the mix without leaving the PI.
- **Radar Volume** (range 0–100, default 100) - slider that controls the Alerts bus volume. Mirrored by its own **Test** button that fires a one-shot directional ping. Stepping to 0 mutes the radar without toggling the feature off.
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
