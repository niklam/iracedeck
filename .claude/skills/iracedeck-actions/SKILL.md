---
name: iracedeck-actions
description: Use when looking up Stream Deck actions, sub-actions, modes, categories, or control counts, or when updating documentation and website content about available features
---

# iRaceDeck Actions Reference

## Data File

Complete action definitions (29 actions, 320 controls): `docs/reference/actions.json`

Each action entry:
```json
{
  "id": "com.iracedeck.sd.core.session-info",
  "name": "Session Info",
  "file": "session-info.ts",
  "encoder": true,
  "settingsKey": "mode",
  "modes": [
    { "value": "incidents", "label": "Incidents", "description": "..." }
  ]
}
```

## How to Use

When asked about actions or controls:
1. Read `docs/reference/actions.json` and search by action name, mode value, or category
2. Report: action name, ID, file, modes with labels
3. For implementation details, check the source at `packages/stream-deck-plugin/src/actions/{file}`
4. For PI templates, check `packages/stream-deck-plugin/src/pi/{action-name}.ejs`

## Category Overview

| Category | Actions | Controls | Description |
|----------|---------|----------|-------------|
| Display & Session | 1 | 6 | Live session data: incidents, laps, position, fuel, flags |
| Driving Controls | 5 | 35 | AI spotter, audio, black boxes, look direction, car control |
| Cockpit & Interface | 4 | 26 | Wipers, FFB, splits & reference, telemetry, UI toggles |
| View & Camera | 6 | 106 | FOV, replay, camera cycle/focus, broadcast tools |
| Media | 1 | 7 | Video recording, screenshots, texture management |
| Pit Service | 3 | 13 | Fuel, tires, compounds, tearoff, fast repair |
| Car Setup | 7 | 79 | Brakes, chassis, aero, engine, fuel mix, hybrid/ERS, traction control |
| Chat | 2 | 48 | Chat, macros (15), whisper, reply, race admin commands |
| **Total** | **29** | **320** | |

## Actions by Category

### Display & Session

| Action | Controls | Modes |
|--------|----------|-------|
| Session Info | 6 | incidents, time-remaining, laps, position, fuel, flags |

### Driving Controls

| Action | Controls | Modes |
|--------|----------|-------|
| AI Spotter Controls | 7 | damage-report, weather-report, toggle-report-laps, announce-leader, louder, quieter, silence |
| Audio Controls | 6 | 2 categories (voice-chat, master) x 3 actions (volume-up, volume-down, mute) |
| Black Box Selector | 13 | 11 direct selections + next/previous cycle |
| Look Direction | 4 | look-left, look-right, look-up, look-down (hold pattern) |
| Car Control | 5 | starter, ignition, pit-speed-limiter (telemetry-aware), enter-exit-tow, pause-sim |

### Cockpit & Interface

| Action | Controls | Modes |
|--------|----------|-------|
| Cockpit Misc | 10 | toggle/trigger wipers, FFB +/-, latency, dash pages +/-, in-lap mode |
| Splits & Reference | 3 | cycle (next/previous), toggle-ref-car |
| Telemetry Control | 5 | toggle-logging, mark-event, start/stop/restart recording |
| Toggle UI Elements | 9 | dash-box, speed/gear, radio, FPS, weather, mirror, edit mode, ref car (deprecated, moved to Splits & Reference), replay UI |

### View & Camera

| Action | Controls | Modes |
|--------|----------|-------|
| View Adjustment | 9 | FOV +/-, horizon +/-, driver height +/-, recenter VR, UI size +/- |
| Replay Control | 25 | play/pause, play-backward, stop, FF, rewind, slow-mo, frame +/-, speed +/-, set speed, speed display, session next/prev, lap next/prev, incident next/prev, jump to beginning, jump to live, jump to my car, next/prev car, next/prev-car-number |
| Camera Cycle | 8 | 4 types (camera, sub-camera, car, driving) x 2 directions |
| Camera Editor Adjustments | 29 | 14 parameters +/- plus auto-set mic gain |
| Camera Editor Controls | 28 | Camera tool, origins, locks, states, undo/redo, grid, bookmarks |
| Camera Focus | 7 | your car, leader, incident, exiting, by position, by car number, camera state |

### Media

| Action | Controls | Modes |
|--------|----------|-------|
| Media Capture | 7 | start/stop video, timer, toggle capture, screenshot, giant screenshot, reload textures |

### Pit Service

| Action | Controls | Modes |
|--------|----------|-------|
| Pit Quick Actions | 3 | clear all, tearoff, fast repair |
| Fuel Service | 7 | add/reduce/set/clear fuel, toggle autofuel, lap margin +/- |
| Tire Service | 4 | change all tires, clear, toggle tires (per-wheel), change compound (telemetry-aware) |

### Car Setup

| Action | Controls | Modes |
|--------|----------|-------|
| Setup Brakes | 13 | ABS toggle/adjust, brake bias +/-, fine +/-, peak +/-, misc +/-, engine braking +/- |
| Setup Chassis | 26 | Front/rear ARB, spring rate, ride height, bump, rebound, tire pressure +/-, power steering +/- |
| Setup Aero | 7 | Front/rear wing +/-, qualifying tape +/-, RF brake attached toggle |
| Setup Engine | 8 | Engine power, throttle shaping, boost, launch RPM +/- |
| Setup Fuel | 7 | Fuel mixture +/-, fuel cut position +/-, disable fuel cut, low fuel accept, FCY mode |
| Setup Hybrid | 9 | MGU-K regen/deploy/fixed +/-, HYS boost (hold), HYS regen (hold), HYS no boost |
| Setup Traction | 9 | TC toggle, TC slots 1-4 +/- |

### Chat

| Action | Controls | Modes |
|--------|----------|-------|
| Chat | 21 | open, reply, whisper, respond PM, cancel, send message, 15 macros |
| Race Admin | 27 | yellow, black-flag, dq-driver, show-dqs-field, show-dqs-driver, clear-penalties, clear-all, wave-around, eol, pit-close, pit-open, pace-laps, single/double-file-restart, advance-session, grid-set, grid-start, track-state, grant/revoke-admin, remove-driver, enable/disable-chat (all/driver), message-all, rc-message |

## Control Patterns

| Pattern | Description | Examples |
|---------|-------------|----------|
| Directional (+/-) | Setting key + direction enum | Setup actions, view adjustments |
| Enumerated | Single dropdown selects the control | Camera focus targets, UI elements |
| Composite | Multiple dropdowns combine | Audio (category + action), black box (mode + box) |
| Hold | Key held while button pressed | Look direction, HYS boost/regen |
| Telemetry-aware | Icon updates from live data | Session info, car control (pit limiter), tire service |

## Keeping in Sync

When actions are added, removed, or modified (new modes, renamed settings, changed categories), update these files in the same change:

1. **`docs/reference/actions.json`** — add/update the action entry with all modes
2. **This skill file** (`SKILL.md`) — update the category overview table (counts) and the per-category action tables
3. **`packages/website/src/content/docs/index.mdx`** — update category cards and stats if counts changed
4. **`packages/website/src/content/docs/docs/actions/`** — add/update the action's documentation page
5. **`packages/website/astro.config.mjs`** — add new action slugs to the sidebar if a new action was created

## Key Project Files

| File | Role |
|------|------|
| `packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/manifest.json` | Action registration, UUIDs, encoder config |
| `packages/stream-deck-plugin/src/actions/` | Action source files (32 .ts files) |
| `packages/stream-deck-plugin/src/pi/` | Property Inspector EJS templates |
| `packages/stream-deck-plugin/src/pi/data/key-bindings.json` | Global key binding definitions |
| `packages/stream-deck-plugin/icons/` | SVG icon Mustache templates |
| `packages/stream-deck-plugin/src/plugin.ts` | Action registration and initialization |
