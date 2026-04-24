# Incident Alerts — design

**Status:** Phase 1 shipped on `feature/pit-engineer`.
**Feature flag:** `incidentAlert` (Pit Engineer action, default `false`).
**Date:** 2026-04-19.

Voice warnings for track-limit violations and off-track excursions, delivered through the Pit Engineer radio.

## Goals

- Respond to the same signals the stewards see (`PlayerCarMyIncidentCount`).
- Distinguish a quick curb-abuse from a full excursion in gravel so the tone matches the severity.
- Stay continuous while the driver is stuck off-track, but silent once they recover.
- Never double-fire on a single event.

## Signals used

| Variable | Role |
|---|---|
| `PlayerCarMyIncidentCount` | Authoritative incident counter. +1/+2 on track-limit, +4 on spin/contact. |
| `PlayerTrackSurface` (`TrkLoc`) | Current car-body location: `OnTrack`, `OffTrack`, `InPitStall`, `AproachingPits`, `NotInWorld`. |
| `PlayerTrackSurfaceMaterial` (`TrkSurf`) | Material under the car (Grass1..4, Sand, Gravel1..2, Grasscrete, Dirt1..4, RacingDirt1..2, Astroturf, Undefined). |
| `IsOnTrack` | Basic "is the driver in a session and out of garage" gate. |
| `OnPitRoad` | Excluded from all incident logic. |

## Dual-path detection

### 1. Sustained off-track

Fires when `PlayerTrackSurface === OffTrack` continuously for **≥ 2 seconds** (`SUSTAINED_OFF_TRACK_MS`).

- **Audio pool:** material-specific — grass (4 clips), gravel (4 clips), generic (6 clips).
- **Material classification:** a 2 s ring buffer of `PlayerTrackSurfaceMaterial` samples is scanned for the most severe category present (gravel > grass > generic).
- **Mix rule:** grass/gravel events play their own pool 60% of the time and a generic clip 40% of the time (`GENERIC_INCIDENT_MIX = 0.4`). Generic events are 100% generic. Each pool keeps its own rotating index so consecutive plays don't repeat.
- **Continuous cadence:** re-fires every 4 s while the driver is still off-track. The 4 s cooldown starts counting from the **end** of the previous clip, not the start — see the "Cooldown from clip end" section.

### 2. Brief incident (track limits)

Fires on a delta of 1 or 2 on `PlayerCarMyIncidentCount` when no sustained warning is covering the same moment.

- **Audio pool:** `OFF_TRACK_LIMITS_WARNINGS` — 6 clips (`IRD-incident-limits-01..06.mp3`).
- **Gated by 4 s global cooldown** shared with the sustained path.
- **Suppressed** if the current excursion already played a sustained warning (`globalOffTrackWarnedThisExcursion`). iRacing often ticks the counter a beat after the driver returns to track, which would otherwise stack a track-limits callout onto a sustained one.

### 3. Major events (Phase 2, not implemented)

`delta >= 4` is logged as a major event (spin / hard contact). No audio yet.

## State machine

```text
globalLastIncidentCount         : number  // -1 = seeded this tick
globalIncidentAlertedAt         : number  // advances while clip still playing
globalOffTrackStartedAt         : number  // 0 = currently on track
globalOffTrackWarnedThisExcursion : bool  // blocks trailing track-limits
globalIncidentFlowActive        : bool    // true while clip is playing
globalMaterialHistory           : { t, material }[]  // 2s ring buffer
```

On every tick while `incidentAlert` is on and driver is in session & not in pits:

1. Record `material` to ring buffer if off-track; filter entries older than 2 s.
2. Mark or clear excursion:
   - Transitioning to off-track → set `globalOffTrackStartedAt = now`; clear `globalOffTrackWarnedThisExcursion`.
   - Still off-track → keep `globalOffTrackStartedAt`.
   - Back on track → clear `globalOffTrackStartedAt`, **keep** `globalOffTrackWarnedThisExcursion` until the next excursion.
3. Defer cooldown if a clip is still playing (see next section).
4. Compute `delta` and advance `globalLastIncidentCount`.
5. Fire sustained warning if excursion duration ≥ 2 s and cooldown has elapsed.
6. Otherwise, fire track-limits warning if `delta > 0`, cooldown has elapsed, and no sustained warning already played this excursion.

## Cooldown from clip end

The cooldown must count from the moment the clip **finishes**, not when it starts. Otherwise a 3 s clip with a 4 s cooldown leaves only ~1 s of silence between clips, which feels frantic.

Every tick, before the cooldown check:

```typescript
if (globalIncidentFlowActive) {
  if (radioFlowState !== "idle") {
    globalIncidentAlertedAt = now;            // keep pushing the clock forward
  } else {
    globalIncidentFlowActive = false;
    globalIncidentAlertedAt = now;            // start 4 s countdown from end-of-clip
  }
}
```

`radioFlowState` transitions `tick-open → messages → tick-close → idle`. While non-idle, pinning the timestamp to `now` each 4 Hz tick pauses the cooldown. The moment it goes idle, the cooldown starts fresh. Quantization = 250 ms max, negligible.

## Audio assets

All clips live under `packages/audio-assets/incidents/` and are copied to both plugins via each rollup's `copyAudioAssetsPlugin()`.

| Pool | Files |
|---|---|
| Grass | `IRD-incident-grass-01..04.mp3` |
| Gravel | `IRD-incident-gravel-01..04.mp3` |
| Generic | `IRD-incident-generic-01..06.mp3` |
| Track limits | `IRD-incident-limits-01..06.mp3` |

## Future phases

- **Phase 2** — 4× incidents: discriminate spin vs hard contact (YawRate / LatAccel spikes, contact flags). Dedicated 6-clip pool.
- **Phase 3** — milestone callouts for track-limit count (`#1 mild`, `#2 sterner`, `#3 next-one-penalty`).
- **Phase 4** — practice-session gating so brief incidents only warn during race / open qualify (practice produces far too many).
- **Phase 5** — derived light-contact detection (LatAccel + `CarLeftRight`) when no incident point registers.

## Related work

- **Spotter suppression in Lone Qualify** (same feature branch) — `isLoneQualifySession()` helper gates the directional spotter. Open Qualify is NOT included because it has real traffic.
