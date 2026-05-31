# Per-mode communication-method audit (#612) — for maintainer verification

Code-verified classification of every action/mode's iRacing communication method, plus the binding key (or key-resolution rule) for keybind modes. This is the source the descriptor catalog will be built from. **Please verify before it's frozen.**

Method legend: **api** = iRacing SDK/broadcast (`getCommands().*`); **keybind** = simulated key binding (keyboard OR SimHub), requires a binding; **chat** = iRacing chat/text command (`#…` macros via `chat.sendMessage`).

## Pure API (no binding needed)

| Action | Modes |
|--------|-------|
| camera-controls | all 12 (change/cycle/focus/switch/set-camera-state) |
| media-capture | start-stop-video, show-timer, take-screenshot |
| pit-quick-actions | clear-all-checkboxes, windshield-tearoff, request-fast-repair |
| replay-control / replay-navigation / replay-speed / replay-transport | all modes |
| telemetry-control | toggle/start/stop/restart-logging |

## Pure CHAT (no binding needed)

| Action | Modes |
|--------|-------|
| race-admin | all 27 modes (yellow, black-flag, dq-driver, …) — `#…` admin commands |

## Pure KEYBIND (binding required)

| Action | Mode setting | Key model |
|--------|--------------|-----------|
| ai-spotter-controls | mode | constant per mode (`spotter*`) |
| black-box-selector | mode | `direct` → keyBy **blackBox** (11 keys); `next`/`previous` → constant cycle keys |
| camera-editor-adjustments | adjustment | keyBy **direction** (`CAMERA_EDITOR_GLOBAL_KEYS[adjustment][direction]`) |
| camera-editor-controls | control | constant per control (`CAMERA_EDITOR_CONTROLS_GLOBAL_KEYS`) |
| car-control | control | constant per mode; **`escape` = hardcoded ESC, no user binding** |
| cockpit-misc | control | mix: constant + keyBy **direction** (ffb-max-force, dash-page-1/2) |
| force-feedback | mode | constant (auto-compute) + keyBy **direction** (rest) |
| look-direction | (no mode selector) | keyBy **direction** (look-left/right/up/down), hold-based |
| setup-aero / brakes / chassis / engine / fuel / hybrid / traction | setting | adjust modes → keyBy **direction**; toggles → constant; **view-* modes → dual-press (see decision 2)** |
| splits-delta-cycle | mode | `cycle` → keyBy **direction**; rest constant |
| toggle-ui-elements | element | 9 keybind constant + `replay-ui` → **api** |
| view-adjustment | adjustment | keyBy **direction**; `recenter-vr` constant |

## Mixed-method actions

| Action | Breakdown |
|--------|-----------|
| fuel-service | api: toggle-fuel-fill, clear-fuel · chat: add/reduce/set-fuel · keybind: toggle-autofuel, lap-margin-inc/dec |
| tire-service | chat: change-all-tires (`#t`), toggle-tires · api: clear-tires, change-compound |
| chat | api: open-chat, reply, cancel, send-message, macro · keybind: whisper, toggle |
| audio-controls | keybind: push-to-talk, voice-chat (keyBy **action**), master (keyBy **action**) · internal (decision 4): race-engineer, radar |

## Display-only / internal (no iRacing communication)

session-info, telemetry-display (display only) · pit-crew (race-engineer / radar / radar-volume — plugin state, not iRacing) · camera-cycle, camera-focus (icon/template only, no action code).

---

## Decisions needed (maintainer)

1. **Display-only / internal actions** — proposed: **no** status line and **no** icon overlay for session-info, telemetry-display, pit-crew, camera-cycle, camera-focus (they don't command iRacing via any of the three methods).

2. **setup `view-*` modes (dual-press)** — these keybind modes nudge+read a value; the actual key is the adjustment's increase/decrease pair, selected at press time by the global `dualPressDirections` + press length. Proposed model: descriptor uses the **increase key** as the representative binding (status line shows that key; icon warns if it's unset). Simpler than reading the two global dual-press settings in the PI.

3. **car-control `escape`** — hardcoded ESC, not user-configurable. Proposed: descriptor `{ method: "keybind" }` with **no binding** → status line shows "Key binding — no binding needed", icon never warns. (Adds a "keybind-without-binding = fixed key" case to the component.)

4. **audio-controls `race-engineer` / `radar`** — adjust plugin audio, not iRacing. Proposed: **omit from the comms map** → status line renders nothing for those two modes.

5. ~~camera-editor~~ — **resolved**: both are keybind (controls = constant per `control`; adjustments = keyBy `direction`).
