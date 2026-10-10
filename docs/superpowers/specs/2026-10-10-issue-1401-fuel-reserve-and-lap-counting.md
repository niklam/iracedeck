# Fuel calls: a reserve in liters, a smaller lap margin, plain lap counting and a logged estimate

> **Issue:** [#1401](https://github.com/niklam/iracedeck/issues/1401) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

Two drivers report the box call coming "a lap early". Their logs show the estimate is steady (one count per lap, in line with Lovely Dash at the first call), so the code works as designed. The design has three weak points:

1. **One lap margin does two jobs.** `fuelCalloutMarginLaps` (default 0.3) covers estimate error, which scales with a lap's worth of fuel, and the fuel the car cannot use before the engine starves, which is a fixed amount per car. The rounded-down count turns any margin into a whole lap whenever the true figure lands in the margin band: the box call comes a lap early in about `margin × 10` stints out of 10. At the Nordschleife 0.3 laps is about 4 L; at Tsukuba it is a fraction of a liter.
2. **The engineer and the dashes count differently.** The engineer counts full laps after the current one; Lovely Dash and iRacing's fuel black box count fuel from now, the current lap included. The count-1 line in the default voice ends in "Plan to box." and is remembered as the box call; the Terse box line says "You'll run out of fuel", which is not true inside the margin.
3. **Nothing records the estimate.** The log shows which line played, not the fuel, average or margin behind it, so a report like "the black box said 2.3 laps" cannot be checked.

The end-of-race false warnings are #1405, which is specced separately and lands independently.

## Decision

### 1. A fuel reserve, capped at one lap's fuel

A new global setting, **Fuel reserve**, is the fuel to keep in the tank when the car reaches the pits: "box this lap" fires when, after the next full lap, less than the reserve would be left.

- **Key and unit:** `fuelCalloutReserveLiters`, stored in liters, the unit `FuelLevel` is in. Range 0–10 L in 0.1 L steps. The settings window shows liters, and its help text gives the gallon equivalent.
- **Default:** 1.0 L, provisional. It is confirmed or changed by the in-car test below before the PR, and the spec is amended if it moves.
- **The cap for thrifty cars:** the reserve used is `min(setting, avg)`, where `avg` is the validated average fuel per lap. A car that burns under a liter a lap therefore never holds back more than one lap, while a GT3 keeps the full amount.
- **Where it applies:** `estimateFuelLapsLeft` takes the effective reserve and computes `rawLapsLeft = max(0, FuelLevel − reserve) / avg`, then the margin and the rest of the lap as before. Its result records `reserveLiters` (the setting) and `effectiveReserveLiters` (after the cap) so the Telemetry Snapshot shows them. #1405's coverage verdict subtracts the same effective reserve from the tank.
- **Plumbing:** the same shape as the margin. `SimEventsIracingOptions.getFuelReserveLiters` is a live-read closure that `plugin-runtime`'s `initSim` wraps in a `sanitizeFuelCalloutReserveLiters` exported from `fuel-laps-left.ts` (non-numeric or non-finite falls back to the default, then clamped to the range). The Zod field in `@iracedeck/settings` uses the margin's `preprocess` / `.catch` shape, and its default must match the constant.

Rejected for the cap: **a share of the tank** (`DriverCarFuelMaxLtr`), which rests on an unverified link between tank size and unusable fuel; **an uncapped setting**, which a driver of several cars would have to keep changing.

### 2. The lap margin shrinks to estimate error

With the reserve covering the unusable fuel, the margin only has to cover the average being off over the laps between the call and the stop. The default goes from **0.3 to 0.1** laps.

A schema default reaches new installs only (`global-settings.md`), and the defaults are written into every settings file, so an untouched 0.3 cannot be told from a chosen one. A one-shot migration in `global-settings-migrations.ts`, guarded by a passthrough marker, moves a stored margin of exactly 0.3 to 0.1 and leaves every other value alone. Without it, existing users would get the reserve on top of the old margin and hear the box call earlier than today. A driver who deliberately chose 0.3 loses that choice once; the changelog says so.

The setting keeps its name and range. Its label stays **Fuel margin (laps)**, and its help text says it covers estimate error while the reserve covers the unusable fuel.

### 3. Lines that say what the count means

Every count line from 10 to 2 in both first-party voices already says "after this lap" / "after this one". Three lines change:

| Voice | Line | Today | New intent |
| --- | --- | --- | --- |
| Default | `laps-left-1` | "…only 1 more lap of fuel after completing this one. Plan to box." | Name the lap: box at the end of the next lap. |
| Terse | `laps-left-1` | "Estimating 1 lap of fuel after this one. Might need more." | The same, tersely. |
| Terse | `laps-left-box` | "You'll run out of fuel, box now." | Box this lap, without claiming the tank runs dry. |

The exact wording is settled by listening before generating, per the voice-line checklist in `race-engineer-callouts.md`. The changes are clip text only: no contract, vocabulary or script change, so no `minPluginVersion` bump. Both packs get a version bump, regenerated clips, `pack:voice` and a regenerated pack reference.

Session Info's **Laps to Empty** stays `FuelLevel / avg`, from now and including the current lap, the way the dashes count, so a driver can compare it with theirs. The website explains how the engineer's call follows from it: the call is Laps to Empty, minus the reserve in laps, minus the rest of the current lap, minus the margin, rounded down.

### 4. A debug line at every sample

`diffFuelLapsLeft` takes an optional debug sink; the translator passes a scope of its logger. Once a validated average exists, every mid-lap sample writes one debug line with the fuel level, the average and the laps it covers, the reserve and the effective reserve, the margin, the count, the race distance from #1405's coverage, and the verdict: announced, already said, above 10, race covered, final lap or post-race. The line is gated by **Enable debug logging** like every debug line, and nothing new is logged at info: `Playing scenario "pit-crew.fuel-laps-left-…"` is already the info record.

The Telemetry Snapshot (#1387) records the same estimate at a key press. The debug line is still needed because it records the figures at the moment each call was decided, which a driver cannot time a press to.

## Alternatives rejected

- **The margin in liters instead of laps.** Estimate error scales with a lap's fuel, so one amount is too cautious for small cars and too thin at long tracks. iRacing's own autofuel margin is in laps.
- **A negative margin** (a driver's suggestion). It hides the counting difference (item 3) and fixes one car on one track.
- **A unit-following reserve control** (gallons when iRacing displays gallons). The settings window does not know the sim's display units while iRacing is not running, and a stored value in two units invites a conversion bug. Liters with the gallon equivalent in the help text is enough.
- **Laps to Empty minus the reserve.** It would match the engineer but no longer match the driver's dash, which is the comparison drivers make.

## Out of scope

- **The end-of-race false warnings and the coverage check:** #1405. This spec only adds the reserve to its verdict.
- **Per-car reserve values.** If testing shows the unusable fuel varies too much for one setting capped at a lap, that is a later feature.
- **Track-aware "box" / "pit" wording:** #934.
- **Measuring iRacing's black-box laps figure** against ours. The debug line makes the next report checkable; a dedicated comparison is not part of this change.

## Testing

- Unit tests on `estimateFuelLapsLeft`: the reserve subtracted; the cap at one lap's fuel (a 2 L reserve on a car using 0.6 L a lap holds back 0.6 L); a reserve larger than the tank gives 0, never negative; the result's two reserve fields.
- Unit tests on `sanitizeFuelCalloutReserveLiters` and the Zod field: string, empty, non-finite and out-of-range values, and that the schema default equals the constant.
- A migration test: a stored 0.3 becomes 0.1 once, the marker is written, and 0, 0.2, 0.31 and 1.5 are untouched; a second run changes nothing.
- A `diffFuelLapsLeft` test that the debug sink receives one line per mid-lap sample with each verdict, and none before an average exists.
- `bundled-scripts.test.ts`, `script-coverage.test.ts` and the pack-reference freshness test pass with the new clips.
- **Manual, in iRacing:** a GT3 race long enough for a stop, debug logging on, Session Info keys for Fuel (Now) and Laps to Empty, and iRacing's fuel black box open at each call. Note the three figures at the box call and where the car actually runs out on a deliberately skipped stop. That run sets the reserve default: the fuel left when the engine first stutters is the floor it must cover. Repeat once in a car that burns under a liter a lap to see the cap at work. Audition the three reworded lines before generating them.
