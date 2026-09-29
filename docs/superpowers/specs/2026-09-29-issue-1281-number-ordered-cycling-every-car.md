# Number-ordered car cycling walks every car the session has had

> **Issue:** [#1281](https://github.com/niklam/iracedeck/issues/1281) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The sim facts this rests on

Measured by the maintainer on 2026-09-29, post-race, in a session where every car had left, including the player's own:

- **A camera switch to a departed car works.** A Camera Controls key on Switch by Car Number (`CamSwitchNum`, no presence filter) focused #6 while the replay was scrubbed back to #6 racing. It also worked at the live end, after #6 had left. So the premise #885's filter was built on, that iRacing silently ignores a switch to a car no longer in the world, is false. #885 itself marked that premise "likely mechanism (unverified)".
- **Per-car telemetry shows the live field during an in-session replay.** Two snapshots (`local/telemetry-snapshot-20260929-182921-601` with the replay at frame 13059, 66 s into the race; `-182927-480` at the live end) read `CarIdxLapDistPct = -1`, `CarIdxTrackSurface = -1` and `CarIdxLapCompleted = -1` for every departed car in both, although the first shows them racing. `CarIdxPosition` reads `0` for every car except the player mid-replay, and the final order at the live end. This settles the contradiction between the #492 note (live) and the #1203 comment in `replay-laps.ts` (replay cursor) in favour of live, for these arrays and this case.
- **Session info keeps every driver.** All 29 drivers stay in `DriverInfo.Drivers` after leaving.

The #885 symptom (the race-position dial stopped switching in a post-race replay) is therefore better explained by the position lookup than by ignored switches: mid-replay `CarIdxPosition` gives no usable rank. The canonical order (`getLiveRacePositions`) has since frozen departed cars at their last rank, so the order itself survives. Only the presence filter still removes them.

## The decision

**The number-ordered modes walk every car the session has had** (maintainer's ruling, 2026-09-29: "scroll through all cars that ever existed in the session"). They are:

- Camera Controls on a dial: **Cycle by Car #** and **Cycle by Race Position**, both the rotation dispatch and the touch-strip previews;
- Camera Controls on a key: **Cycle Car**;
- Replay Control: **Next / Previous Car (Number Order)**.

The candidate set is the existing competitor list (`getAllCarNumbers(sessionInfo, true, true)`, so no pace car and no spectators), with **no presence filter**. That holds live and in a replay, because the maintainer's test showed the switch works in both. It also includes a driver who has not left the garage yet. The rule is "every car in the session", and a presence test cannot tell a car absent now from a car present at the replay moment, since the arrays read live (above).

Race position walks the canonical order as it is, including frozen ranks. Nothing else changes about how either order is built or which side a turn goes.

The presence parameter threaded through `car-cycling.ts` (`isPresent`) is removed from these walks rather than passed an always-true closure, so no caller can reintroduce the filter by accident. `carInWorld` itself stays in `iracing-sdk`: its other callers are live-only (the track-order primitive, the spotter's gap confirmation, the caution lineup) and are out of scope.

## Docs and comments that change with it

- The claims that departed or garage cars are skipped because iRacing can't point a camera at them go: `camera-focus.md` (Cycle Car, the dial's Car # and Race Position modes), `replay-control.md` (Number Order), `.claude/rules/encoders-and-touchscreen.md`, `.claude/rules/race-positions.md` (its "camera walks filter via `carInWorld`" note), the `iracedeck-actions` skill, and the doc comments in `camera-dial-surface.ts`, `camera-controls.ts`, `replay-control.ts`, `car-cycling.ts` and `track-utils.ts` (`carInWorld`'s docstring cites the camera walks).
- `replay-laps.ts` (#1203) says the per-car arrays follow the replay cursor while a replay is on screen. Correct that comment to the measured fact. Its gate (`IsReplayPlaying !== true`) stays: skipping replay ticks is still right when the arrays are live.
- Changelog: one **Bug Fixes** line.

## Out of scope

- `carInWorld` and its live-only callers.
- Cycle by Track Order, which is iRacing's own `V` / `Shift+V` since #1277.
- Whether any other telemetry-driven feature misreads an in-session replay. The finding above may matter elsewhere; this change corrects only the one comment that states the opposite.
- The keypad Switch by Position mode, which targets a fixed position rather than walking.

## Testing

- **Unit:** each surface walks past a car whose arrays read not-in-world (the post-race snapshot shape: `-1` everywhere) instead of skipping it. That covers the dial's Car # and Race Position rotation and previews, the Cycle Car key, and Replay Control's Number Order keys. The pace car and spectators are still excluded. The formation-lap case #968 fixed still works. Build fixtures from the two 2026-09-29 snapshots' shape.
- **Manual (sim):** post-race, stay connected until cars leave. Scrub the replay back to them racing and turn a Car # dial and a Race Position dial through the whole field. Then press the Cycle Car key and Replay Control's Number Order keys. Every departed car is reached, and the strip previews name them. Repeat at the live end. Mid-race, cycling behaves as before.
