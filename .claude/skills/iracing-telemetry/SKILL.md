---
name: iracing-telemetry
description: Use when looking up iRacing telemetry variable names, types, units, or descriptions, or when implementing actions that consume live telemetry data
---

# iRacing Telemetry Variable Reference

## Data File

Complete variable definitions (429 variables): `docs/reference/telemetry-vars.json`

Source: https://github.com/bengsfort/irsdk-node/blob/main/packages/irsdk-node-types/cache.telemetry-vars.json

Each variable entry:
```json
"Speed": {
  "description": "GPS vehicle speed",
  "length": 1,
  "countAsTime": false,
  "unit": "m/s",
  "type": "number"
}
```

## How to Use

When asked about telemetry variables:
1. Read `docs/reference/telemetry-vars.json` and search by variable name or description keyword
2. Report: name, type, unit, length, description
3. Check if the variable is already typed in `packages/iracing-native/src/defines.ts` (`TelemetryData` interface)
4. If not typed yet, show how to add it to `TelemetryData` with the correct TypeScript type

## Template Variables (User-Facing)

The canonical user-facing list of template variables (for Telemetry Display and Chat > Send Message) is at:
`packages/website/src/content/docs/docs/features/template-variables.md`

This is the **source of truth** for which variables are available in Mustache templates. When adding or modifying template variable support, update this file in the same change.

## Length Values

| Length | Meaning | TypeScript Type |
|--------|---------|-----------------|
| 1 | Scalar value | `number` or `boolean` |
| 64 | Per-car array (indexed by car index) | `number[]` or `boolean[]` |
| 6 | High-frequency 360Hz samples (`countAsTime: true`) | `number[]` |

## Variable Categories

| Category | Pattern | Count | Examples |
|----------|---------|-------|----------|
| Tire/Shock | `LF*`, `RF*`, `LR*`, `RR*`, `CF*`, `CR*` | 88 | `LFtempCM`, `RRwearL`, `LFshockDefl` |
| In-Car Adjustments | `dc*` | 42 | `dcBrakeBias`, `dcTractionControl`, `dcDRSToggle`. The `setup-*` actions' "View …" sub-modes (issue #541) consume these directly — see `packages/iracing-actions/src/shared/setup-view.ts` for the registry mapping each `view-*` setting to its `dc*` field. |
| Lap/Timing | `Lap*`, `Race*` | 28 | `Lap`, `LapBestLapTime`, `LapDistPct` |
| Per-Car Arrays | `CarIdx*` | 27 | `CarIdxPosition`, `CarIdxLapDistPct`, `CarIdxGear` |
| Pit Adjustments | `dp*` | 24 | `dpFuelAddKg`, `dpRFTireChange`, `dpWingFront` |
| Player Car | `Player*` | 22 | `PlayerCarPosition`, `PlayerCarMyIncidentCount` |
| High-Freq 360Hz | `*_ST` | 17 | `LatAccel_ST`, `LFshockDefl_ST` |
| Pit Service | `Pit*`, `FastRepair*` | 16 | `PitSvFlags`, `PitSvFuel`, `PitRepairLeft` |
| Steering/FFB | `Steering*` | 14 | `SteeringWheelAngle`, `SteeringWheelTorque` |
| Session | `Session*` | 14 | `SessionFlags`, `SessionTimeRemain`, `SessionState` |
| Environment | `Air*`, `Wind*`, `Track*`, `Solar*`, `Fog*` | 14 | `AirTemp`, `TrackWetness`, `WindVel` |
| Camera/Replay | `Cam*`, `Replay*` | 11 | `CamCarIdx`, `ReplayPlaySpeed` |
| Hybrid/ERS | `Energy*`, `Power*`, `DRS_*` | 10 | `EnergyERSBatteryPct`, `PowerMGU_K` |
| Other | Various | 102 | `Speed`, `RPM`, `FuelLevel`, `Gear`, `Brake`, `Throttle` |

## Bitfield & Enum Mapping

Variables with `irsdk_*` unit values map to TypeScript enums in `packages/iracing-native/src/defines.ts`:

| JSON Unit | TypeScript Enum | Used By Variables |
|-----------|----------------|-------------------|
| `irsdk_Flags` | `Flags` | `SessionFlags`, `CarIdxSessionFlags` |
| `irsdk_EngineWarnings` | `EngineWarnings` | `EngineWarnings` |
| `irsdk_PitSvFlags` | `PitSvFlags` | `PitSvFlags` |
| `irsdk_PitSvStatus` | `PitSvStatus` | `PitSvStatus` |
| `irsdk_SessionState` | `SessionState` | `SessionState` |
| `irsdk_TrkLoc` | `TrkLoc` | `PlayerTrackSurface`, `CarIdxTrackSurface` |
| `irsdk_TrkSurf` | `TrkSurf` | `PlayerTrackSurfaceMaterial`, `CarIdxTrackSurfaceMaterial` |
| `irsdk_PaceMode` | `PaceMode` | `PaceMode` |
| `irsdk_PaceFlags` | `PaceFlags` | `CarIdxPaceFlags` |
| `irsdk_TrackWetness` | `TrackWetness` | `TrackWetness` |
| `irsdk_CarLeftRight` | `CarLeftRight` | `CarLeftRight` |
| `irsdk_CameraState` | `CameraState` | `CamCameraState` |
| `irsdk_IncidentFlags` | `IncidentFlags` | (per-car incident data) |

Use `hasFlag()` from `@iracedeck/iracing-sdk` to check bitfield values.

## Session-YAML enums

Not every classified value is a telemetry bitfield. `WeekendInfo.TrackType` is a session-YAML **string** (e.g. `"road course"`, `"dirt oval"`) resolved to the local `TrackType` enum via `resolveTrackType` in `packages/sim-events-iracing/src/track-type.ts`; unrecognized values map to `Unknown`. This enum is local to `sim-events-iracing` (it rides in no event payload and has a single consumer), not on the event-bus.

## SessionFlags Breakdown

`SessionFlags` is a combined bitfield containing track flags, driver black flags, and start lights. Use the `Flags` enum from `@iracedeck/iracing-native`.

### Global flags (bits 0–15)

| Flag | Value | When it's set |
|------|-------|---------------|
| Checkered | `0x01` | Race finished — client shown the checkered flag |
| White | `0x02` | 1 lap to go — can be withdrawn if you pass the leader before the timing line |
| Green | `0x04` | Start or restart flag |
| Yellow | `0x08` | Local yellow — sector-specific, shown to your car only |
| Red | `0x10` | Session stopped (rarely seen in normal racing) |
| Blue | `0x20` | Lapping car behind — you're about to be lapped |
| Debris | `0x40` | Debris on track — often accompanies caution on ovals |
| Crossed | `0x80` | Crossed flags — likely indicates start of race or an invalid pass |
| YellowWaving | `0x100` | Flashing local yellow — more severe local danger |
| OneLapToGreen | `0x200` | One pace lap remaining before restart |
| GreenHeld | `0x400` | Green flag is being held (restart delayed) |
| TenToGo | `0x800` | 10 laps remaining |
| FiveToGo | `0x1000` | 5 laps remaining |
| RandomWaving | `0x2000` | Random flag waving (cosmetic / marshal activity) |
| Caution | `0x4000` | Full course caution — the field is under yellow |
| CautionWaving | `0x8000` | Full course caution being established — initial waving period |

### Driver black flags (bits 16–23)

| Flag | Value | When it's set |
|------|-------|---------------|
| Black | `0x10000` | Client has a black (penalty) flag — must pit to serve |
| Disqualify | `0x20000` | Client has been disqualified |
| Servicible | `0x40000` | Car is allowed pit service — not a visual flag |
| Furled | `0x80000` | Black flag furled (penalty acknowledged but not yet active) |
| Repair | `0x100000` | Meatball flag (black with orange circle) — mandatory damage repair |

### Start lights (bits 28–31)

| Flag | Value | When it's set |
|------|-------|---------------|
| StartHidden | `0x10000000` | Start lights not visible |
| StartReady | `0x20000000` | Lights on, not yet set |
| StartSet | `0x40000000` | Red lights on (set position) |
| StartGo | `0x80000000` | Green lights — go |

### Flag categories for overlay purposes

- **Warning flags** (should trigger overlay): Red, Black, Disqualify, Repair, Yellow, Caution, CautionWaving, Blue, YellowWaving
- **Informational flags** (may or may not trigger overlay): Checkered, White, TenToGo, FiveToGo
- **Normal racing** (should NOT trigger overlay): Green, GreenHeld, OneLapToGreen, Debris, Crossed, RandomWaving, Servicible, Furled, all Start lights

## EngineWarnings Breakdown

`telemetry.EngineWarnings` is a single 16-bit bitfield. Use the `EngineWarnings` enum from `@iracedeck/iracing-sdk` (re-exported from `@iracedeck/iracing-native`).

| Flag | Value | When it's set |
|------|-------|---------------|
| WaterTempWarning | `0x0001` | Coolant temperature above threshold |
| FuelPressureWarning | `0x0002` | Fuel pressure below threshold |
| OilPressureWarning | `0x0004` | Oil pressure below threshold |
| EngineStalled | `0x0008` | Engine has stalled |
| PitSpeedLimiter | `0x0010` | Pit speed limiter is engaged |
| RevLimiterActive | `0x0020` | Rev limiter is currently cutting |
| OilTempWarning | `0x0040` | Oil temperature above threshold |
| MandRepNeeded | `0x0080` | Mandatory damage repair required (driver must pit and repair to remain eligible) |
| OptRepNeeded | `0x0100` | Optional damage repair available (driver may pit to repair, but not required) |

Rising-edge of `(EngineWarnings & (MandRepNeeded \| OptRepNeeded))` is consumed by `sim-events-iracing/diff/damage.ts` to publish `damage.repairNeeded.raised` after a 3000 ms debounce (issue #489). Pair with `PitReadbackSnapshot.hasDamage` (built from the same mask) for damage-aware readback gating.

## Car-capability detection

iRacing only exposes a driver-control (`dc*`) field when the car actually has that control. So the **presence** of a `dc*` field — not its value — tells you whether the car has the feature; the value is just the current on/off state. This is the canonical way to ask "does this car have X?".

| Capability | Field(s) present ⇒ has feature | Notes |
|------------|-------------------------------|-------|
| Pit limiter | `dcPitSpeedLimiterToggle` | A car without a pit limiter omits this field entirely. |
| Tear-off visor | `dcTearOffVisor` | Open-cockpit / visor cars expose this. |
| Windshield wipers | `dcToggleWindshieldWipers` / `dcTriggerWindshieldWipers` | Presence of either signals wipers. |

Tear-off visor and windshield wipers are **mutually exclusive** per car — a car with a visor does not expose the wiper fields and vice-versa — so "has visor" and "has wipers" are complementary.

Don't re-check these fields ad-hoc. The canonical helpers live in `packages/iracing-sdk/src/telemetry-features.ts` and are exported from `@iracedeck/iracing-sdk`:

```typescript
import { hasPitLimiter, hasVisor, hasWipers } from "@iracedeck/iracing-sdk";
import { getLatestTelemetry } from "@iracedeck/sim-events-iracing";

if (!hasPitLimiter(getLatestTelemetry())) {
  // car has no limiter — skip limiter callouts / grey out the limiter button
}
```

Each helper takes `TelemetryData | null` and returns `false` for `null`. Add new capability checks here rather than scattering `dc*`-presence tests across consumers.

## Common Units

| Unit | Meaning | Count |
|------|---------|-------|
| *(empty)* | Dimensionless / enum / boolean | 172 |
| `%` | Percentage (0-1 or 0-100, check description) | 42 |
| `m` | Meters | 37 |
| `m/s` | Meters per second | 35 |
| `s` | Seconds | 25 |
| `C` | Celsius | 17 |
| `rad` | Radians | 10 |
| `revs/min` | RPM | 8 |
| `kPa` | Kilopascals | 8 |
| `bar` | Bar (pressure) | 7 |

## Key Project Files

| File | Role |
|------|------|
| `packages/iracing-native/src/defines.ts` | `TelemetryData` interface, enums, bitfield definitions |
| `packages/iracing-sdk/src/IRacingSDK.ts` | Parses telemetry from shared memory buffer |
| `packages/iracing-sdk/src/SDKController.ts` | 4Hz update loop, subscription management |
| `packages/iracing-sdk/src/telemetry-snapshot.ts` | CLI tool to capture live telemetry (`--vars=Speed,Gear`) |
