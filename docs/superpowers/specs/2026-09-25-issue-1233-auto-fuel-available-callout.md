> **Issue:** [#1233](https://github.com/niklam/iracedeck/issues/1233) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Race Engineer: announce when auto-fuel has enough data to be used

## The sim signal

`dpFuelAutoFillEnabled` ("Pitstop auto fill fuel system enabled"). The #474 spec and deck-core's `isAutofuelEnabled` read it as the car or series *having* auto-fuel. The captures in the master checkout's `local/` say otherwise (surveyed 2026-09-25 for #1226: 76 `telemetry-snapshot-*.json` plus `telemetry-watch-20260919-193233-855.jsonl`):

- **It turns on during a session, for the same car.** ARCA Chevrolet SS on 2026-09-17: 0 at laps 0–5, then 1 at laps 9 and 11. Mustang GT3 on 2026-08-30: 0 through lap 1. Six cars reached 1 somewhere in the set: Legends, ARCA, Super Formula Lights, Mercedes-AMG GT3, Mustang GT3 and the #474 capture's car.
- **It drops to 0 off track and comes back.** Mustang GT3 on 2026-08-09: 0 sitting in the pits, 1 on lap 1 on track, 0 once off track again.
- **It can turn on seconds after leaving the pits.** The watch capture flipped at 226.7 s, 5 s before `Lap` reached 1, and the same car had run the same track that morning (snapshots from 09:33–09:43 read 1). iRacing appears to keep the estimate per car and track across sessions. That part is an inference and is not established.
- **Nothing tells a car that never gets it from one that has not got it yet.** Porsche 911 GT3 R on 2026-07-13 was still 0 at lap 9.

So the flag means *iRacing has a consumption estimate right now*, and that is the moment arming auto-fuel starts doing something.

## Decisions

### 1. The trigger is iRacing's flag, and the line names auto-fuel

The maintainer ruled that the line is about auto-fuel, along the lines of *"We now have enough data to use auto-fuel."* That ties it to the flag that makes it true.

**Rejected: the engineer's own estimate** (`FuelLapTracker`, `diff/fuel-laps.ts`, readable through `getFuelStats()`). It answers a different question — when *his* laps-left numbers become available — and it can be ready while iRacing's is not, or the other way round. A line naming auto-fuel must follow auto-fuel's flag.

### 2. One event, no payload: `pitService.autoFuelAvailable`

It sits in the `pitService.*` group beside `autoFuelSwitched` (#474). The event carries no payload, because the only fact is that the moment happened.

### 3. Once per car and track per connection, announced from the track

The translator publishes once the flag reads 1 **while the car is on track and not on pit road** (the #474 gate, for the same reason: pit road is the busiest moment of the lap). It then stays quiet for that **car and track** until the sim disconnects. That gives four behaviours:

- **Off-track dips don't repeat it.** The flag drops to 0 in the pits or the garage and returns within seconds of driving out (2026-08-09). The driver was told once, and that is enough.
- **A new session with the same car and track does not repeat it** (practice → qualifying → race).
- **A flag that turns on while the car is on pit road or off track is not lost.** The callout is published the first time the car is on track with the flag still at 1.
- **Connecting when the flag already reads 1 on track counts as already announced.** Nothing changed in front of the driver; he started the plugin into a known state.

The state is keyed by `WeekendInfo.TrackID` plus the player's `CarID` and cleared on disconnect, like the other per-connection translator state.

**Rejected: once per session.** The flag comes back at every session change, so the engineer would repeat the line at the start of qualifying and again at the start of the race.

**Rejected: persisting it across runs.** It would silence the line after a sim restart, but at the cost of stored state for a line that costs one sentence to hear again.

### 4. No early "we're gathering data" call

The maintainer dropped it (2026-09-25). The flag cannot say whether a car will ever get auto-fuel, so any gate would sometimes promise data for a car that never delivers. Remembering which car and track combinations have reached 1 before was weighed and dropped along with the call.

### 5. Wording, clips and pacing

- **Script:** one `scenarios` entry, a bare line with no acknowledgment prefix, because nothing was requested (#474 decision 4). Clips go in the `pit-actions` group as `auto-fuel-available`, one take per variant the pack wants.
- **Opt-in:** `calloutEnabledPitServiceAutoFuelAvailable`, default `true` per the callout baseline, labelled "Autofuel available".
- **Scheduling:** `family: "pit-service.fuel"`, `WEIGHT.LOW`, `interrupt: false`.
- **Queueing:** unlike #474's switch line, this one is `queueable: true`. It stays true for as long as the flag does, so a late line is still right. A `speakGate` re-checks at speak time that the flag is still 1 and the car is still on track, so a queued line never lands in the pits.

### 6. deck-core's doc comment is corrected

`isAutofuelEnabled` (`deck-core/src/fuel-telemetry.ts`) says the flag is "available for this car/series". That becomes "iRacing has a fuel estimate for the car right now" in the same change. The Fuel Service dial's `AUTOFUEL: N/A` state reads the same flag, and its wording on the website is checked against the new meaning. The #474 spec has shipped and is frozen, so its sentence stays as written; this spec records the correction.

## Out of scope

- The early call (decision 4).
- Any readiness line for the engineer's own `FuelLapTracker` estimate.
- Announcing the flag turning **off**. It turns off at every garage visit, so the announcement would be noise.
- Changing what the Fuel Service dial shows while the flag is 0. That surface is #1226's.

## Testing

1. **`sim-events-iracing`:**
   - The watch capture's flip at 226.7 s publishes exactly one `autoFuelAvailable`.
   - An off-track dip and return publishes nothing more; neither does a session change with the same car and track.
   - A different track or car publishes again.
   - A flip on pit road publishes on the first on-track tick instead.
   - A first tick that already reads 1 publishes nothing.
   - A disconnect clears the memory.
2. **`audio-scenarios`:**
   - The contract fires on the event.
   - The opt-in silences it.
   - The `speakGate` drops a queued line once the car is off track or the flag is 0.
   - `bundled-scripts.test.ts` and `script-coverage.test.ts` cover the entry and clips.
3. **Harness:** a Pit Service button, plus a telemetry sequence replaying the capture's 0 → 1 on track, which drives the real translator.
4. **In the sim:**
   - Take a car to a track iRacing has no data for and drive until the line plays. Record at which lap.
   - Pit and drive out; the line should not repeat.
   - Restart the sim and rejoin the same car and track; the line plays again within seconds of the out-lap.
