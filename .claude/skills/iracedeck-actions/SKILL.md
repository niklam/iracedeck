---
name: iracedeck-actions
description: Use when looking up Stream Deck actions, sub-actions, modes, categories, or control counts, or when updating documentation and website content about available features
---

# iRaceDeck Actions Reference

## Data File

Complete action definitions: `docs/reference/actions.json`

This skill file documents **32 actions with 298 modes** using a detailed per-mode count (the totals in the category table below). The user-facing website (`packages/website/src/content/docs/`) uses a coarser counting convention and shows a lower total (**266 modes**) — treat the website as the source of truth for user-facing copy and this skill file as the detailed inventory. `docs/reference/actions.json` has not yet been re-synced to the per-mode counting convention; treat it as a detailed inventory of individual mode values that is occasionally out of date.

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

## Communication method (per mode) — `action-comms.json` (#612)

Every action mode talks to iRacing through one of three methods, formalized per-`(action, mode)` in `packages/iracing-actions/src/actions/data/action-comms.json` (generated from `comms-catalog.ts`):

- **`api`** — iRacing API / SDK command (`getCommands().*`); most reliable, no binding needed.
- **`keybind`** — a configurable key binding (keyboard OR SimHub role); requires the binding to be set. The descriptor's `binding` carries a constant `key`, a `keyBy` a secondary setting, multiple `keys`, or is absent for a fixed key (no user binding).
- **`chat`** — an iRacing chat/text command, e.g. a `#…` pit macro.

This is the **authoritative source for a mode's communication method** when answering "how does action X mode Y talk to iRacing?" or labeling docs. An action can mix all three across its modes (e.g. Fuel Service). Display-only / internal actions (session-info, telemetry-display, pit-crew) and the PI-less camera-controls are absent from the catalog. The Telemetry Control **snapshot** mode is likewise absent (it writes telemetry to disk, issuing no iRacing command), so it shows no status line. The method surfaces in the PI (an `ird-binding-status` line under the Mode selector) and on the key icon (a centered ⚠️ when a required binding is unset).

## How to Use

When asked about actions or controls:
1. Read `docs/reference/actions.json` and search by action name, mode value, or category (and `data/action-comms.json` for each mode's communication method)
2. Report: action name, ID, file, modes with labels
3. For implementation details, check the source at `packages/iracing-actions/src/actions/{action-name}/{action-name}.ts`
4. For PI templates, check `packages/iracing-actions/src/actions/{action-name}/{action-name}.ejs`

## Category Overview

| Category | Actions | Modes | Description |
|----------|---------|-------|-------------|
| Display & Session | 2 | 9 | Live session data: incidents, laps, position, fuel, laps to empty, flags, track wetness |
| Driving Controls | 6 | 35 | AI spotter, audio (incl. Race Engineer & Radar volume), black boxes, look direction, car control, pit crew (Race Engineer toggle + radar) |
| Cockpit & Interface | 5 | 35 | Wipers, force feedback, splits & reference, telemetry, UI toggles |
| View & Camera | 5 | 88 | FOV, replay, camera controls, broadcast tools |
| Media | 1 | 7 | Video recording, screenshots, texture management |
| Pit Service | 3 | 15 | Fuel, tires, compounds, tearoff, fast repair |
| Car Setup | 7 | 73 | Brakes, chassis, aero, engine, fuel mix, hybrid/ERS, traction control — adjustment modes plus live-display "View …" sub-modes; each View sub-mode also supports dual-press (tap = configured direction, long-press = opposite) so one key both shows the value and adjusts it (#540) |
| Communication | 2 | 35 | Chat, macros (15), whisper, toggle, reply, race admin commands, car selector |
| Stream Deck | 1 | 1 | Switch Profile — switch to a bundled iRaceDeck profile or back to the previous one (Elgato-only, no iRacing command) |
| **Total** | **32** | **298** | |

Mode counts reflect the PI Mode/Setting dropdown choices documented in each action page. Directional variants (Increase/Decrease) are treated as a single mode with a Direction sub-setting, matching the per-mode website format. Legacy replay actions (Replay Transport, Replay Speed, Replay Navigation) and Camera Cycle (Legacy) still exist in the plugin manifest for backward compatibility but are not counted as documented actions.

## Actions by Category

### Display & Session

| Action | Modes | Mode values |
|--------|-------|-------------|
| Session Info | 8 | incidents, time-remaining, laps, position, fuel (Fuel Value sub-modes: current level / used last lap / average per lap over a configurable 1–20 lap window; #465), laps-to-empty (live tank level ÷ the same 1–20-lap average, two decimals, `--` until a clean lap exists; #748), flags, track-wetness |
| Telemetry Display | 1 | template (Mustache-driven display, no Mode dropdown; templates also support `{{= expr }}` expressions — arithmetic, comparisons, ternary, round/floor/ceil/abs/min/max — #192) |

### Driving Controls

| Action | Modes | Mode values |
|--------|-------|-------------|
| AI Spotter Controls | 7 | damage-report, weather-report, toggle-report-laps, announce-leader, louder, quieter, silence |
| Audio Controls | 5 | push-to-talk (hold), voice-chat (with volume-up/down/mute action), master (with volume-up/down action), race-engineer (with volume-up/down action; steps global raceEngineerVolume ±5, respects the master enable gate), radar (with volume-up/down action; steps global radarVolume ±5). The race-engineer/radar categories control iRaceDeck's own audio buses directly (no keyboard binding); dial control is out of scope for now (#590). |
| Black Box Selector | 3 | direct (with 11 Black Box options), next, previous |
| Look Direction | 4 | look-left, look-right, look-up, look-down (all hold pattern) |
| Car Control | 14 | pit-speed-limiter (telemetry-aware), push-to-pass (telemetry-aware), drs (telemetry-aware), headlight-flash (hold), tear-off-visor, ignition, starter (hold), enter-exit-tow (hold, telemetry-aware, session-context icon/color/label when out of car: Test/Practice/Qualify/Grid/Race, red background in-car, per-state auto-hold options for exit/reset/tow), escape (hardcoded ESC, auto-hold option), pause-sim, handbrake (hold), second-clutch (hold), second-up-shift, second-down-shift (backup driver inputs, #183 — no default iRacing bindings) |
| Pit Crew | 2 | race-engineer (Race Engineer Toggle — flips the engineer voice gate on/off), radar (toggles the directional proximity tick loop). The radar-volume mode moved to the Audio Controls action (#590) — hidden from the Pit Crew Mode dropdown but kept functional so existing buttons keep working. The Spotter is NOT a mode — it's a Race Engineer voice callout family (spoken side-awareness — "car left", "three wide", "clear"), gated by the Race Engineer master (`pitCrewRaceEngineerEnabled`) plus two PI opt-ins `calloutEnabledSpotterCars` + `calloutEnabledSpotterStillThere` (both default on); issue #651. |

### Cockpit & Interface

| Action | Modes | Mode values |
|--------|-------|-------------|
| Cockpit Misc | 7 | toggle-wipers, trigger-wipers, ffb-max-force (+/-), report-latency, dash-page-1 (+/-), dash-page-2 (+/-), in-lap-mode |
| Splits & Reference | 6 | cycle (+/- direction), toggle-ref-car, custom-sector-start, custom-sector-end, active-reset-set, active-reset-run |
| Telemetry Control | 6 | toggle-logging, mark-event, start/stop/restart recording (SDK), snapshot (developer tool — saves current telemetry + session info to disk as timestamped JSON + Markdown; configurable Output Folder; no iRacing command) |
| Force Feedback | 6 | auto-compute-ffb-force, ffb-force (+/-), wheel-lfe (+/-), bass-shaker-lfe (+/-), wheel-lfe-intensity (+/-), haptic-lfe-intensity (+/-) |
| Toggle UI Elements | 10 | dash-box, speed/gear/pedals, radio, FPS/network, weather, virtual mirror, UI edit, driving-line, display-ref-car (deprecated), replay-ui (SDK) |

### View & Camera

| Action | Modes | Mode values |
|--------|-------|-------------|
| View Adjustment | 5 | fov (+/-), horizon (+/-), driver-height (+/-), recenter-vr, ui-size (+/-) |
| Replay Control | 27 | play/pause, play-backward, stop, FF, rewind, slow-mo, slow-mo-rewind (FF/RW + slow-mo modes share a configurable Step Rate that walks the speed ladder per press), frame +/-, speed +/-, set-speed, speed-display, session next/prev, lap next/prev, incident next/prev, jump to beginning/live/my car, jump-to-fastest-lap (target: Viewed Car / Always my car; session-scoped; no clean-lap filter; no dial support), next/prev car, next/prev car number |
| Camera Controls | 12 | change-camera, cycle (camera / sub-camera / car / driving), focus (your car / leader / incident / most exciting), switch (by position / car number), set-camera-state |
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
| Setup Aero | 6 | view-{front-wing, rear-wing} (read-only, live dcFrontWing/dcRearWing), front-wing (+/-), rear-wing (+/-), qualifying-tape (+/-), rf-brake-attached |
| Setup Brakes | 13 | view-{brake-bias, brake-bias-fine, peak-brake-bias, brake-misc, engine-braking, abs-adjust} (read-only, live dcBrakeBias/dcBrakeBiasFine/dcPeakBrakeBias/dcBrakeMisc/dcEngineBraking/dcABS), abs-toggle, abs-adjust (+/-), brake-bias (+/-), brake-bias-fine (+/-), peak-brake-bias (+/-), brake-misc (+/-), engine-braking (+/-) |
| Setup Chassis | 22 | view-{diff-preload, diff-entry, diff-middle, diff-exit, anti-roll-front, anti-roll-rear, power-steering, weight-jacker-left, weight-jacker-right} (read-only, live dcDiffPreload/dcDiffEntry/dcDiffMiddle/dcDiffExit/dcAntiRollFront/dcAntiRollRear/dcPowerSteering/dcWeightJackerLeft/dcWeightJackerRight), differential-preload/entry/middle/exit, front/rear ARB, left/right spring, LF/RF/LR/RR shock, power-steering (all +/-) |
| Setup Engine | 7 | view-{engine-power, throttle-shape, launch-rpm} (read-only, live dcEnginePower/dcThrottleShape/dcLaunchRPM), engine-power (+/-), throttle-shaping (+/-), boost-level (+/-), launch-rpm (+/-) |
| Setup Fuel | 7 | view-{fuel-mixture, fuel-cut-position} (read-only, live dcFuelMixture/dcFuelCutPosition), fuel-mixture (+/-), fuel-cut-position (+/-), disable-fuel-cut, low-fuel-accept, fcy-mode-toggle |
| Setup Hybrid | 9 | view-{mguk-deploy-mode, mguk-regen-gain, mguk-deploy-fixed} (read-only, live dcMGUKDeployMode/dcMGUKRegenGain/dcMGUKDeployFixed), mguk-regen-gain (+/-), mguk-deploy-mode (+/-), mguk-fixed-deploy (+/-), hys-boost (hold), hys-regen (hold), hys-no-boost |
| Setup Traction | 9 | view-tc-slot-{1,2,3,4} = "TC1"…"TC4" (read-only, live dcTractionControl/dcTractionControl2/dcTractionControl3/dcTractionControl4), tc-toggle, tc-slot-1/2/3/4 (all +/-, labelled TC1–TC4 in the PI) |

### Communication

| Action | Modes | Mode values |
|--------|-------|-------------|
| Chat | 7 | send-message, macro (1-15), reply, whisper (keyboard), toggle (keyboard), open-chat, cancel (`respond-pm` is a hidden alias of `reply` retained for backward compatibility — not exposed in the PI dropdown) |
| Race Admin | 28 | yellow, black-flag, dq-driver, show-dqs-field, show-dqs-driver, clear-penalties, clear-all, wave-around, eol, pit-close, pit-open, pace-laps, single/double-file-restart, advance-session, grid-set, grid-start, track-state, grant/revoke-admin, remove-driver, enable/disable-chat (all/driver), message-all, rc-message, select-car (Elgato-only car selector: auto-fills a car per key, stores the shared admin target). Driver Target adds a `selected-car` option that acts on that shared target. |

### Stream Deck

| Action | Modes | Mode values |
|--------|-------|-------------|
| Switch Profile | 1 | single behavior, no Mode dropdown (#736) — the Profile setting picks a bundled profile to switch to (default iRaceDeck Default) or "Back to previous" (walks the per-device history of visited iRaceDeck profiles, ending at the device's Default); a "Placed in profile" marker setting (#762) keeps the back-history correct for keys inside bundled profiles. Elgato-only, keypad-only, no iRacing command; forward switches land on page 1. |

## Control Patterns

| Pattern | Description | Examples |
|---------|-------------|----------|
| Directional (+/-) | Setting key + direction enum | Setup actions, view adjustments |
| Enumerated | Single dropdown selects the control | Camera focus targets, UI elements |
| Composite | Multiple dropdowns combine | Audio (category + action), black box (mode + box) |
| Hold | Key held while button pressed | Look direction, HYS boost/regen |
| Telemetry-aware | Icon updates from live data | Session info, car control (pit limiter), tire service |
| Read-only View | Setting prefixed `view-…`; the action subscribes to telemetry and renders the live dc* value, with key presses suppressed | Setup actions' View sub-modes (issue #541) |

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
| `packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/manifest.json` | Action registration, UUIDs, dial config |
| `packages/iracing-actions/src/actions/<name>/` | Per-action folder: `<name>.ts`, `<name>.test.ts`, `<name>.ejs`, `icon.svg`, `key.svg` |
| `packages/iracing-actions/src/actions/data/key-bindings.json` | Global key binding definitions |
| `packages/iracing-actions/src/actions/data/icon-defaults.json` | Default icon colors by action/variant |
| `packages/iracing-actions/src/actions/data/docs-urls.json` | PI "Open documentation" links |
| `packages/iracing-actions/src/actions/settings/settings.ejs` | Plugin-global Property Inspector |
| `packages/iracing-actions/icons/` | Dynamic SVG Mustache templates used at runtime |
| `packages/icons/` | Standalone icon library (Mustache color placeholders + `<desc>`) |
| `packages/iracing-plugin-stream-deck/src/plugin.ts` | Action registration and initialization |
