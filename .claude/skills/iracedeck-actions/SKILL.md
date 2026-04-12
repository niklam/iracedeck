---
name: iracedeck-actions
description: Use when looking up Stream Deck actions, sub-actions, modes, categories, or control counts, or when updating documentation and website content about available features
---

# iRaceDeck Actions Reference

## Data File

Complete action definitions: `docs/reference/actions.json`

The website currently documents **30 actions with 254 modes** (the totals used in this file and in user-facing docs). `docs/reference/actions.json` has not yet been re-synced to the new per-mode counting convention; use this skill file or the website as the source of truth for action and mode counts, and treat `actions.json` as a detailed inventory of individual mode values that is occasionally out of date.

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

| Category | Actions | Modes | Description |
|----------|---------|-------|-------------|
| Display & Session | 2 | 7 | Live session data: incidents, laps, position, fuel, flags |
| Driving Controls | 5 | 27 | AI spotter, audio, black boxes, look direction, car control |
| Cockpit & Interface | 5 | 33 | Wipers, force feedback, splits & reference, telemetry, UI toggles |
| View & Camera | 5 | 87 | FOV, replay, camera controls, broadcast tools |
| Media | 1 | 7 | Video recording, screenshots, texture management |
| Pit Service | 3 | 15 | Fuel, tires, compounds, tearoff, fast repair |
| Car Setup | 7 | 44 | Brakes, chassis, aero, engine, fuel mix, hybrid/ERS, traction control |
| Communication | 2 | 34 | Chat, macros (15), whisper, reply, race admin commands |
| **Total** | **30** | **254** | |

Mode counts reflect the PI Mode/Setting dropdown choices documented in each action page. Directional variants (Increase/Decrease) are treated as a single mode with a Direction sub-setting, matching the per-mode website format. Legacy replay actions (Replay Transport, Replay Speed, Replay Navigation) and Camera Cycle (Legacy) still exist in the plugin manifest for backward compatibility but are not counted as documented actions.

## Actions by Category

### Display & Session

| Action | Modes | Mode values |
|--------|-------|-------------|
| Session Info | 6 | incidents, time-remaining, laps, position, fuel, flags |
| Telemetry Display | 1 | template (Mustache-driven display, no Mode dropdown) |

### Driving Controls

| Action | Modes | Mode values |
|--------|-------|-------------|
| AI Spotter Controls | 7 | damage-report, weather-report, toggle-report-laps, announce-leader, louder, quieter, silence |
| Audio Controls | 3 | push-to-talk (hold), voice-chat (with volume-up/down/mute action), master (with volume-up/down action) |
| Black Box Selector | 3 | direct (with 11 Black Box options), next, previous |
| Look Direction | 4 | look-left, look-right, look-up, look-down (all hold pattern) |
| Car Control | 10 | pit-speed-limiter (telemetry-aware), push-to-pass (telemetry-aware), drs (telemetry-aware), headlight-flash (hold), tear-off-visor, ignition, starter (hold), enter-exit-tow (hold, telemetry-aware), escape (hardcoded ESC, auto-hold option), pause-sim |

### Cockpit & Interface

| Action | Modes | Mode values |
|--------|-------|-------------|
| Cockpit Misc | 7 | toggle-wipers, trigger-wipers, ffb-max-force (+/-), report-latency, dash-page-1 (+/-), dash-page-2 (+/-), in-lap-mode |
| Splits & Reference | 6 | cycle (+/- direction), toggle-ref-car, custom-sector-start, custom-sector-end, active-reset-set, active-reset-run |
| Telemetry Control | 5 | toggle-logging, mark-event, start/stop/restart recording (SDK) |
| Force Feedback | 6 | auto-compute-ffb-force, ffb-force (+/-), wheel-lfe (+/-), bass-shaker-lfe (+/-), wheel-lfe-intensity (+/-), haptic-lfe-intensity (+/-) |
| Toggle UI Elements | 9 | dash-box, speed/gear/pedals, radio, FPS/network, weather, virtual mirror, UI edit, display-ref-car (deprecated), replay-ui (SDK) |

### View & Camera

| Action | Modes | Mode values |
|--------|-------|-------------|
| View Adjustment | 5 | fov (+/-), horizon (+/-), driver-height (+/-), recenter-vr, ui-size (+/-) |
| Replay Control | 25 | play/pause, play-backward, stop, FF, rewind, slow-mo, frame +/-, speed +/-, set-speed, speed-display, session next/prev, lap next/prev, incident next/prev, jump to beginning/live/my car, next/prev car, next/prev car number |
| Camera Controls | 12 | change-camera, cycle (camera / sub-camera / car / driving), focus (your car / leader / incident / exiting), switch (by position / car number), set-camera-state |
| Camera Editor Adjustments | 15 | latitude, longitude, altitude, yaw, pitch, fov-zoom, key-step, vanish-x, vanish-y, blimp-radius, blimp-velocity, mic-gain (all +/-), auto-set-mic-gain, f-number (+/-), focus-depth (+/-) |
| Camera Editor Controls | 30 | Open Camera Tool, 14 toggles (key accel/10x, parabolic mic, temp edits, dampening, zoom, beyond fence, in cockpit, mouse nav, pitch/roll gyro, limit shot range, show camera, shot selection, manual focus), cycle position/aim type, acquire start/end, camera CRUD (insert/remove/copy/paste), group CRUD (copy/paste), track/car save/load |

### Media

| Action | Modes | Mode values |
|--------|-------|-------------|
| Media Capture | 7 | start-stop-video, video-timer, toggle-video-capture, take-screenshot, take-giant-screenshot (keyboard), reload-all-textures, reload-car-textures |

### Pit Service

| Action | Modes | Mode values |
|--------|-------|-------------|
| Pit Quick Actions | 3 | clear-all-checkboxes, windshield-tearoff (telemetry-aware), request-fast-repair (telemetry-aware) |
| Fuel Service | 8 | toggle-fuel-fill (telemetry-aware), add-fuel, reduce-fuel, set-fuel-amount, clear-fuel, toggle-autofuel (telemetry-aware), lap-margin-increase, lap-margin-decrease |
| Tire Service | 4 | change-all-tires, clear-tires, toggle-tires (telemetry-aware per-wheel), change-compound (telemetry-aware) |

### Car Setup

| Action | Modes | Mode values |
|--------|-------|-------------|
| Setup Aero | 4 | front-wing (+/-), rear-wing (+/-), qualifying-tape (+/-), rf-brake-attached |
| Setup Brakes | 7 | abs-toggle, abs-adjust (+/-), brake-bias (+/-), brake-bias-fine (+/-), peak-brake-bias (+/-), brake-misc (+/-), engine-braking (+/-) |
| Setup Chassis | 13 | differential-preload/entry/middle/exit, front/rear ARB, left/right spring, LF/RF/LR/RR shock, power-steering (all +/-) |
| Setup Engine | 4 | engine-power (+/-), throttle-shaping (+/-), boost-level (+/-), launch-rpm (+/-) |
| Setup Fuel | 5 | fuel-mixture (+/-), fuel-cut-position (+/-), disable-fuel-cut, low-fuel-accept, fcy-mode-toggle |
| Setup Hybrid | 6 | mguk-regen-gain (+/-), mguk-deploy-mode (+/-), mguk-fixed-deploy (+/-), hys-boost (hold), hys-regen (hold), hys-no-boost |
| Setup Traction | 5 | tc-toggle, tc-slot-1/2/3/4 (all +/-) |

### Communication

| Action | Modes | Mode values |
|--------|-------|-------------|
| Chat | 7 | send-message, macro (1-15), reply, respond-pm, whisper (keyboard), open-chat, cancel |
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
