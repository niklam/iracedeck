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
- **Radar mode**: Flips the plugin-global `radarEnabled` and stops/starts the directional proximity tick loop synchronously. Used by Radar alongside the per-instance Radar Test button.
- **Radar Volume mode**: Steps the plugin-global `radarVolume` by ±5, clamped to 5–100. Takes effect immediately on `AudioBus.Alerts`. Direction is configured per button (Up or Down).

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Mode | Dropdown | Radar | Selects what the key press does |
| Direction | Dropdown | Up | Up / Down step, visible only when Mode = Radar Volume |

### Mode Options
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
