# Action-Type Color Overrides

**Date:** 2026-04-07
**Status:** Planned (not started)

## Problem

Currently, color overrides are either global (all actions) or per-action-instance. There's no way to set colors for an entire action type (e.g., all tire service buttons share one color scheme).

## Current Resolution Chain

```text
per-action override → global default → icon <desc> default
```

## Proposed Resolution Chain

```text
per-action override → action-type default → global default → icon <desc> default
```

## Option A: Full Action-Type Color Tier

Adds a new resolution level in `resolveIconColors()` between per-action and global defaults.

### How it works

- Each action type (tire-service, fuel-service, black-box-selector, etc.) gets its own color section in global settings
- `resolveIconColors()` gains a new parameter for action-type colors
- PI gets a new partial for action-type color defaults

### Scope

- Refactor `resolveIconColors()` signature to accept action-type colors
- Update ~30+ action files to pass action-type colors
- New PI partial for action-type color section
- New global settings keys per action type (e.g., `colorDefaults.tireService.backgroundColor`)

### Pros

- True per-category control, clean architecture
- Automatic — applies to all instances without user touching each one

### Cons

- Large scope (~30+ files)
- Adds complexity to the resolution chain
- New action types require adding new global settings keys

## Option B: Named Color Presets (Recommended)

Store named presets in global settings. Users apply a preset to fill in per-action color overrides.

### How it works

- Global settings stores named presets (e.g., "Tire Service", "Fuel", "Camera")
- Each preset is a set of colors: `backgroundColor`, `textColor`, `graphic1Color`, `graphic2Color`
- The per-action Color Overrides PI section gets a "Load Preset" dropdown
- Selecting a preset populates the per-action override fields
- No changes to `resolveIconColors()` — presets just fill in the existing per-action override slots

### Scope

- New PI component or dropdown in color-overrides partial
- Preset storage in global settings (JSON object with named entries)
- No changes to `resolveIconColors()` or action files

### Pros

- Much less code, same user experience
- More flexible — user defines their own preset names
- No core resolution chain changes
- Works with existing architecture

### Cons

- Not fully automatic — user must select preset on each action instance
- Preset changes don't propagate to already-applied actions (one-time fill)

## Decision

TBD — waiting for user decision on which approach to implement.
