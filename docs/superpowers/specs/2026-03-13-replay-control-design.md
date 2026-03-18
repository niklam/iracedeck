# Replay Control — Unified Action Design

## Summary

Consolidate three existing replay actions (Transport, Speed, Navigation) into a single **Replay Control** action with 17 modes. Existing actions are hidden from the UI but remain functional for backward compatibility. The new action adds telemetry-driven Play/Pause toggling and reuses existing icon artwork.

This is a **breaking change** at the UI level: the old actions are hidden from the Stream Deck action picker, so new installs and new configurations will only see the unified action. Existing user configurations using the old actions continue to work unchanged. The change is "breaking" in the sense that the three old action UUIDs are no longer discoverable by default.

## Problem

Three separate replay actions (21 total sub-actions) create UI clutter and split related functionality across multiple action entries. Users must find the right action among three to configure a single replay button.

## Design

### Action Identity

| Field | Value |
|-------|-------|
| Action ID | `com.iracedeck.sd.core.replay-control` |
| Type | Multi-mode (single dropdown) |
| SDK Support | Yes (all modes use SDK commands) |
| Encoder Support | Yes |

### Modes (17 total)

Flat dropdown with `<optgroup>` labels for visual grouping:

**Transport (7)**

| Mode Value | Label | SDK Command | Icon SVG (reuse from) |
|------------|-------|-------------|-----------------------|
| `play-pause` | Play / Pause | `replay.play()` or `replay.pause()` (telemetry toggle) | `replay-transport/play.svg` |
| `stop` | Stop | `replay.pause()` (same SDK command as pause — kept as a separate option for users who want explicit stop semantics) |`replay-transport/stop.svg` |
| `fast-forward` | Fast Forward | `replay.fastForward()` (sets speed to 2x forward) | `replay-transport/fast-forward.svg` |
| `rewind` | Rewind | `replay.rewind()` (sets speed to 2x reverse) | `replay-transport/rewind.svg` |
| `slow-motion` | Slow Motion | `replay.slowMotion()` | `replay-transport/slow-motion.svg` |
| `frame-forward` | Frame Forward | `replay.nextFrame()` | `replay-transport/frame-forward.svg` |
| `frame-backward` | Frame Backward | `replay.prevFrame()` | `replay-transport/frame-backward.svg` |

**Speed (2)**

| Mode Value | Label | SDK Command | Icon SVG |
|------------|-------|-------------|----------|
| `speed-increase` | Increase Speed | `replay.fastForward()` (jumps to 2x forward — matches existing replay-speed behavior) | `replay-speed/increase.svg` |
| `speed-decrease` | Decrease Speed | `replay.rewind()` (jumps to 2x reverse — matches existing replay-speed behavior) | `replay-speed/decrease.svg` |

**Navigation (8)**

| Mode Value | Label | SDK Command | Icon SVG |
|------------|-------|-------------|----------|
| `next-session` | Next Session | `replay.nextSession()` | `replay-navigation/next-session.svg` |
| `prev-session` | Previous Session | `replay.prevSession()` | `replay-navigation/prev-session.svg` |
| `next-lap` | Next Lap | `replay.nextLap()` | `replay-navigation/next-lap.svg` |
| `prev-lap` | Previous Lap | `replay.prevLap()` | `replay-navigation/prev-lap.svg` |
| `next-incident` | Next Incident | `replay.nextIncident()` | `replay-navigation/next-incident.svg` |
| `prev-incident` | Previous Incident | `replay.prevIncident()` | `replay-navigation/prev-incident.svg` |
| `jump-to-beginning` | Jump to Beginning | `replay.goToStart()` | `replay-navigation/jump-to-start.svg` |
| `jump-to-live` | Jump to Live | `replay.goToEnd()` | `replay-navigation/jump-to-end.svg` |

### Dropped Modes (3)

These remain accessible via the hidden legacy `replay-navigation` action:

- **Set Play Position** — requires frame number input, very niche
- **Search Session Time** — requires session number + time input, very niche
- **Erase Tape** — destructive, rarely used

### Settings Schema

```typescript
const REPLAY_CONTROL_MODES = [
  "play-pause", "stop", "fast-forward", "rewind", "slow-motion",
  "frame-forward", "frame-backward",
  "speed-increase", "speed-decrease",
  "next-session", "prev-session", "next-lap", "prev-lap",
  "next-incident", "prev-incident",
  "jump-to-beginning", "jump-to-live",
] as const;

const ReplayControlSettings = CommonSettings.extend({
  mode: z.enum(REPLAY_CONTROL_MODES).default("play-pause"),
});
```

### Play/Pause Toggle (Telemetry-Driven)

The `play-pause` mode subscribes to telemetry:
- `IsReplayPlaying` (boolean) — current playback state

Behavior:
- **Button press**: If playing → pause. If paused → play.
- **Icon**: Static play icon (no dynamic switching in this version). Telemetry is used only for toggle logic, not for icon updates.

Implementation: Subscribe to `IsReplayPlaying` in `onWillAppear` when mode is `play-pause`. Use the cached value to decide play vs pause on key press. Unsubscribe in `onWillDisappear`.

### Encoder Behavior

Contextual based on selected mode category:

| Mode Category | Rotate | Push |
|---------------|--------|------|
| Transport (all 7 modes) | Frame forward/backward | `replay.play()` (resume playback, matching existing behavior) |
| Speed | Speed increase/decrease | Reset to normal speed via `replay.play()` |
| Navigation (directional pairs: session, lap, incident) | Next/previous in same category | Execute the selected navigation |
| Navigation (jump-to-beginning, jump-to-live) | Next/prev incident (sensible default) | Execute the jump |

Note: Encoder push for transport modes calls `replay.play()` directly (not a telemetry-driven toggle). This matches the existing `replay-transport` encoder behavior.

### Icon Architecture

**Reuse existing icon SVGs** from `packages/icons/replay-transport/`, `replay-speed/`, `replay-navigation/`. Copy relevant ones into a new `packages/icons/replay-control/` directory with names matching the mode values.

Icon file mapping (17 files):

| Mode Value | Source SVG | Target file in `replay-control/` |
|------------|-----------|----------------------------------|
| `play-pause` | `replay-transport/play.svg` | `play-pause.svg` |
| `stop` | `replay-transport/stop.svg` | `stop.svg` |
| `fast-forward` | `replay-transport/fast-forward.svg` | `fast-forward.svg` |
| `rewind` | `replay-transport/rewind.svg` | `rewind.svg` |
| `slow-motion` | `replay-transport/slow-motion.svg` | `slow-motion.svg` |
| `frame-forward` | `replay-transport/frame-forward.svg` | `frame-forward.svg` |
| `frame-backward` | `replay-transport/frame-backward.svg` | `frame-backward.svg` |
| `speed-increase` | `replay-speed/increase.svg` | `speed-increase.svg` |
| `speed-decrease` | `replay-speed/decrease.svg` | `speed-decrease.svg` |
| `next-session` | `replay-navigation/next-session.svg` | `next-session.svg` |
| `prev-session` | `replay-navigation/prev-session.svg` | `prev-session.svg` |
| `next-lap` | `replay-navigation/next-lap.svg` | `next-lap.svg` |
| `prev-lap` | `replay-navigation/prev-lap.svg` | `prev-lap.svg` |
| `next-incident` | `replay-navigation/next-incident.svg` | `next-incident.svg` |
| `prev-incident` | `replay-navigation/prev-incident.svg` | `prev-incident.svg` |
| `jump-to-beginning` | `replay-navigation/jump-to-start.svg` | `jump-to-beginning.svg` |
| `jump-to-live` | `replay-navigation/jump-to-end.svg` | `jump-to-live.svg` |

### Icon Labels

Labels use ALL-CAPS convention to match existing replay actions:

| Mode | subLabel | mainLabel |
|------|----------|-----------|
| play-pause | REPLAY | PLAY |
| stop | REPLAY | STOP |
| fast-forward | REPLAY | FWD |
| rewind | REPLAY | REWIND |
| slow-motion | REPLAY | SLOW MO |
| frame-forward | REPLAY | FRAME FWD |
| frame-backward | REPLAY | FRAME BACK |
| speed-increase | REPLAY | SPEED UP |
| speed-decrease | REPLAY | SLOW DOWN |
| next-session | SESSION | NEXT |
| prev-session | SESSION | PREVIOUS |
| next-lap | LAP | NEXT |
| prev-lap | LAP | PREVIOUS |
| next-incident | INCIDENT | NEXT |
| prev-incident | INCIDENT | PREVIOUS |
| jump-to-beginning | REPLAY | BEGINNING |
| jump-to-live | REPLAY | LIVE |

### Category & Key Icons

- **Category icon** (`icon.svg`, 20x20): Reuse the existing `replay-transport` category icon (play triangle symbol).
- **Key icon** (`key.svg`, 72x72): Reuse the existing `replay-transport` key icon.

### Property Inspector

Full EJS template structure:

```ejs
<!doctype html>
<html lang="en">
  <head>
    <%- include('head-common') %>
  </head>
  <body>
    <sdpi-item label="Control">
      <sdpi-select setting="mode" default="play-pause">
        <optgroup label="Transport">
          <option value="play-pause">Play / Pause</option>
          <option value="stop">Stop</option>
          <option value="fast-forward">Fast Forward</option>
          <option value="rewind">Rewind</option>
          <option value="slow-motion">Slow Motion</option>
          <option value="frame-forward">Frame Forward</option>
          <option value="frame-backward">Frame Backward</option>
        </optgroup>
        <optgroup label="Speed">
          <option value="speed-increase">Increase Speed</option>
          <option value="speed-decrease">Decrease Speed</option>
        </optgroup>
        <optgroup label="Navigation">
          <option value="next-session">Next Session</option>
          <option value="prev-session">Previous Session</option>
          <option value="next-lap">Next Lap</option>
          <option value="prev-lap">Previous Lap</option>
          <option value="next-incident">Next Incident</option>
          <option value="prev-incident">Previous Incident</option>
          <option value="jump-to-beginning">Jump to Beginning</option>
          <option value="jump-to-live">Jump to Live</option>
        </optgroup>
      </sdpi-select>
    </sdpi-item>

    <%- include('common-settings') %>
  </body>
</html>
```

### Manifest Changes

1. Add `"VisibleInActionsList": false` to the three existing replay action entries.
2. Add new `replay-control` action entry with Keypad + Encoder controllers.

### Hidden Actions

The three existing actions (`replay-transport`, `replay-speed`, `replay-navigation`) are hidden but:
- Code, tests, and registrations remain unchanged
- Existing user configurations continue to work
- PI templates still function for editing existing instances
- No code is removed

## Files

### New Files

1. `packages/stream-deck-plugin/src/actions/replay-control.ts` — action class
2. `packages/stream-deck-plugin/src/actions/replay-control.test.ts` — unit tests
3. `packages/stream-deck-plugin/src/pi/replay-control.ejs` — Property Inspector
4. `packages/icons/replay-control/*.svg` — 17 icon SVGs (copied/renamed from existing sources)
5. `com.iracedeck.sd.core.sdPlugin/imgs/actions/replay-control/icon.svg` — category icon (20x20)
6. `com.iracedeck.sd.core.sdPlugin/imgs/actions/replay-control/key.svg` — key icon (72x72)

### Modified Files

1. `com.iracedeck.sd.core.sdPlugin/manifest.json` — hide old actions, add new action
2. `packages/stream-deck-plugin/src/plugin.ts` — import and register new action
3. `docs/reference/actions.json` — add new action, mark old actions as hidden

## Testing

- Unit tests for settings validation (all 17 modes)
- Unit tests for icon generation (all 17 modes produce valid SVG data URIs)
- Unit tests for mode-to-command mapping
- Build verification (no TypeScript warnings)

## Out of Scope

- Dynamic play/pause icon switching based on telemetry state (deferred — the icon is always the static mode icon; telemetry is used only for the play/pause toggle logic)
- Telemetry-driven speed display on icons (can be added later as enhancement)
- Documentation updates beyond `docs/reference/actions.json` (docs/plugins/core/actions/ pages) — separate commit
- iRaceDeck actions skill file update — separate commit
