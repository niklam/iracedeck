# Telemetry Display Rework

Date: 2026-03-09
Branch: `feature/telemetry-display-action`

## Problem

The current Telemetry Display action has two issues:

1. **Performance**: Every action instance calls `buildTemplateContext()` on every telemetry tick (4Hz). With multiple buttons, this means redundant driver sorting, object flattening, and context assembly N times per tick.
2. **Overlap with Session Info**: The preset modes (speed, oil temp, water temp, brake bias, gear) duplicate what the custom template system already provides. Session Info handles curated race-critical data with rich UX (flash, pulse). Telemetry Display should be the generic "show me anything" tool.

## Design Decisions

- Template context built once per tick, shared across all actions (not per-button)
- Context caching lives in `SDKController` (SDK level) so all plugins can use it
- Remove all preset modes from Telemetry Display — custom template only
- Raw telemetry values with clear unit documentation, no pre-converted convenience fields
- New standalone website page for template variable reference (designed for Stream Deck's small browser window)

## Changes

### 1. Shared Template Context in SDKController

Add lazy-rebuild caching to `SDKController`:

- `templateContextDirty: boolean` — set `true` each tick after telemetry updates
- `lastTemplateContext: TemplateContext | null` — cached context
- `getCurrentTemplateContext(): TemplateContext | null` — public accessor:
  - If dirty or cache is null: rebuild from current telemetry + session info, cache, clear flag
  - If clean: return cached object
  - Return `null` when not connected / no telemetry

Zero cost when no action reads it. One build per tick when at least one action calls it.

### 2. Telemetry Display Action — Custom Template Only

Strip all preset modes. Settings become:

| Setting | Type | Default |
|---------|------|---------|
| `template` | string | `{{telemetry.Speed}}` |
| `title` | string | `TELEMETRY` |
| `backgroundColor` | string | `#2a3444` |
| `textColor` | string | `#ffffff` |
| `fontSize` | number | `18` |

No `mode` dropdown. No `PRESET_MODES`. No `extractPresetValue`.

PI: template input, title input, color pickers, font size dropdown. One-line help text with link to template variables reference page.

### 3. Display Value Formatting

`flattenForDisplay` already handles:
- Floats rounded to 2 decimal places
- Booleans to "Yes"/"No"
- Integers as-is
- Arrays skipped
- `CarIdx*` prefix excluded from telemetry namespace

Add: Known 0/1 boolean telemetry fields converted to "Yes"/"No" instead of "0"/"1". Fields: `IsOnTrack`, `IsReplayPlaying`, `IsInGarage`, `IsOnTrackCar`, `IsDiskLoggingEnabled`, `IsDiskLoggingActive`, `PlayerCarDryTireSetAvailable`, and similar `Is*`/boolean-semantic fields.

### 4. Website — Template Variables Reference Page

Standalone page designed for Stream Deck's small fixed-size browser window.

**URL**: `/docs/template-variables` (or similar)

**Layout**:
- Jump links at top: Driver Info | Session | Track | Telemetry | Session Info
- **Driver Info**: List fields once, note available prefixes (`self`, `track_ahead`, `track_behind`, `race_ahead`, `race_behind`). `self.incidents` documented as the one extra field.
- **Session**: `session.type`, `session.laps_remaining`, `session.time_remaining`
- **Track**: `track.name`, `track.short_name`
- **Telemetry**: Every iRacing telemetry variable. Format:
  ```
  {{telemetry.Speed}}
  Vehicle speed in meters per second
  ```
  Generated from `docs/reference/telemetry-vars.json`.
- **Session Info**: Flattened session info dot-notation paths

**Styling**: No navigation chrome, no sidebar. Minimal CSS. Lists, not tables.

### 5. Removals

- `PRESET_MODES` record and all preset formatter functions
- `extractPresetValue()` function
- `mode` setting and PI mode dropdown
- `customTemplate`/`customTitle` settings renamed to `template`/`title`
- Preset-related test cases
- Conditional visibility JS in PI (no mode toggle needed)

## Progress

- [x] Add lazy template context caching to `SDKController`
- [x] Update `SDKController` tests for template context caching
- [x] Add 0/1 boolean field conversion to `flattenForDisplay`
- [x] Update `flattenForDisplay` tests
- [x] Simplify Telemetry Display action (remove presets, rename settings)
- [x] Simplify Telemetry Display PI (remove mode dropdown, add help link)
- [x] Update Telemetry Display tests
- [x] Update manifest if needed
- [x] Create website template variables reference page
- [x] Update `docs/reference/actions.json`
- [x] Build verification and lint/format pass
