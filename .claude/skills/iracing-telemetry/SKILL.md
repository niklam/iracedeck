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
| In-Car Adjustments | `dc*` | 42 | `dcBrakeBias`, `dcTractionControl`, `dcDRSToggle` |
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
