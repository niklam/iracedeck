# Starter

Engages the car's starter motor.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.starter` |
| Type | Button |
| SDK Support | No |
| Communication Method | Key binding |
| Dial Support | No |

## Behavior

### Button Press
- Engages starter motor while held (or single press depending on car)

## Settings

None.

## Keyboard Simulation

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Starter | S | Starter |

## Icon States

The icon is tri-state, matching the other tri-state buttons (Pit Speed Limiter, DRS, Push to Pass, Auto-Fuel, Windshield Tear-off, Fast Repair) — a colored status bar at the bottom conveys the state and also drives the key's border color. Because the border color is state-driven, the per-action border color picker is ignored for this key; the border width setting still applies. The tri-state reports whether the engine is running, not whether the starter motor is momentarily engaged.

No title is shown by default — the artwork already reads `START` — but a title can still be added through the per-action Title Overrides.

| State | Description |
|-------|-------------|
| Off | Engine not running, press to crank — red `OFF` status bar, red border, and the artwork is dimmed |
| On | Engine running — green `ON` status bar, green border, and the artwork is at full brightness |
| Not available | No live telemetry — grey `N/A` status bar, grey border, dimmed artwork. Does not mean the car has no starter; pressing still sends the configured binding. |
| Cranking | While the key is held with the engine not running — the artwork alternates between dimmed and full brightness over the real status bar and border, each frame shorter than the last (200 ms down to 120 ms, then 120 ms for as long as it is held). A full-brightness badge over a red `OFF` bar is a flash frame, not a running engine. It ends on release, or when the engine catches: stall bit clear **and** RPM at or above 500, since iRacing clears the stall bit from the first crank. No flash with the Starter binding unset. Display only: the hold-to-crank behaviour is unchanged. |
| Chuk | A press while the engine is already running — one 200 ms dimmed blink over the green `ON` bar, then the normal `ON` look, however long the key is held. |

## Telemetry Integration

Detects whether the engine is running primarily from the `EngineWarnings.EngineStalled` bit, falling back to an engine-RPM floor when that bitfield is unavailable.

## Notes

- Most cars require ignition to be on first
- Some cars have automatic starters that only need a tap
- Typically used after a stall or at race start
