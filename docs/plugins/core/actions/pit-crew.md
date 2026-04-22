# Pit Crew

Multi-mode action covering the iRaceDeck pit-side audio framework: Race Engineer voice scenarios and the directional Radar proximity ticks. Race Engineer and Radar have independent on/off globals so silencing one does not affect the other.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.pit-crew` |
| Type | Multi-toggle / Incremental |
| SDK Support | No |
| Encoder Support | No |

## Behavior

### Button Press
- **Race Engineer mode**: Flips the plugin-global `raceEngineerEnabled`. Voice scenarios (welcome, pit-lane callouts, flag alerts, fuel warnings, etc.) ship disabled until their follow-up PRs re-register them; this toggle flips the gate they will read. Today the only observable effect is the status-bar icon state.
- **Radar mode**: Flips the plugin-global `radarEnabled` and stops/starts the directional proximity tick loop synchronously. Used by Radar alongside the per-instance Radar Test button.
- **Radar Volume mode**: Steps the plugin-global `radarVolume` by ±5, clamped to 5–100. Takes effect immediately on `AudioBus.Alerts`. Direction is configured per button (Up or Down).

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Mode | Dropdown | Race Engineer | Selects what the key press does |
| Direction | Dropdown | Up | Up / Down step, visible only when Mode = Radar Volume |

### Mode Options
- **Race Engineer** - Toggles the Race Engineer voice on/off
- **Radar** - Toggles the directional proximity ticks on/off
- **Radar Volume** - Steps the global Radar volume up or down

### Direction Options
- **Up** - Bumps Radar volume by 5 (max 100)
- **Down** - Reduces Radar volume by 5 (min 5)

### Plugin-global Audio Settings (in the Pit Crew accordion, not under Global Settings)
- **Radar Volume** (range 5–100, default 100) - slider + Test button. Shared across every Pit Crew instance.
- **Output Device** - audio device used for the iRaceDeck audio engine; shared globally across the plugin.

## Keyboard Simulation

None. Pit Crew drives its own audio framework; it does not emit keyboard events.

## Icon States

Race Engineer and Radar modes paint a status bar on the lower third of the key (green when the feature is on, red when off). Radar Volume modes paint no status bar — the current volume shows as a percentage in the title.

| Mode / State | Icon |
|--------------|------|
| Race Engineer — on | Headset / mic glyph, status bar green |
| Race Engineer — off | Headset / mic glyph, status bar red |
| Radar — on | Radar-sweep glyph, status bar green |
| Radar — off | Radar-sweep glyph, status bar red |
| Radar Volume Up | Radar glyph + up arrow, title shows `VOL +` and current % |
| Radar Volume Down | Radar glyph + down arrow, title shows `VOL −` and current % |

## See also

- Audio architecture design: `docs/plans/2026-04-19-audio-architecture-design.md`.
- AI Spotter Controls (separate action wrapping iRacing's built-in AI spotter — different system, different audio source): `docs/plugins/core/actions/ai-spotter-controls.md` (if present).
