# Automation

Automated car controls triggered by telemetry. Executes commands (tear off visor, pit limiter, headlight flash, trigger wipers) based on configurable triggers (lap position, pit boundary, interval).

## Overview

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.automation` |
| Type | Toggle |
| SDK Support | No (uses keyboard shortcuts) |
| Encoder Support | No |

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Command | Dropdown | Tear Off Visor | Car control to execute |
| Trigger | Dropdown | Lap-Based | When to execute the command |

### Command Options

- **Tear Off Visor** - Tear off the visor film
- **Pit Limiter** - Toggle pit road speed limiter
- **Headlight Flash** - Flash headlights (configurable count and duration)
- **Trigger Wipers** - Trigger a single wiper sweep

### Trigger Options

- **Lap-Based** - Fire at evenly-spaced track positions every X laps
- **Pit Boundary** - Fire on pit approach and/or pit exit
- **Interval** - Fire every X seconds

### Lap-Based Settings

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| Times Per Lap | Number | 1 | 1–20 | Number of evenly-spaced firings per lap |

### Pit Boundary Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Turn On When Approaching | Checkbox | On | Fire when approaching pit road |
| Turn Off When Leaving | Checkbox | On | Fire when leaving pit road |

### Interval Settings

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| Interval (seconds) | Number | 5 | 1–300 | Seconds between firings |

### Headlight Flash Settings

Shown only when Command is "Headlight Flash".

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| Flash Count | Number | 1 | 1–10 | Number of flashes per trigger |
| Flash Duration (ms) | Number | 200 | 100–1000 | Duration of each flash |

## Behavior

- **Press** the button to toggle the automation on/off
- Automations start **inactive** on plugin startup (manual activation only)
- Automations **persist across page switches** — the rule continues running even when the button is not visible
- The button shows a **status bar** (green "AUTO ON" / red "AUTO OFF") to indicate current state

## Keyboard Simulation

This action reuses existing global key bindings from the Car Control and Cockpit Misc actions:

| Command | Default Key | iRacing Setting |
|---------|-------------|-----------------|
| Tear Off Visor | *(none)* | Tear Off Visor |
| Pit Limiter | A | Toggle Pit Speed Limiter |
| Headlight Flash | *(none)* | Headlight Flash |
| Trigger Wipers | Ctrl+Alt+W | Trigger Windshield Wipers |

## Icon States

| State | Icon |
|-------|------|
| Active (AUTO ON) | Command icon with green "AUTO ON" status bar |
| Inactive (AUTO OFF) | Command icon with red "AUTO OFF" status bar |
| Paused (AUTO N/A) | Command icon with gray "AUTO N/A" status bar — rule is active but trigger evaluation is suppressed because iRacing is disconnected, the player is off track, or a replay is playing |
