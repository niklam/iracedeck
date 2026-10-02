# The Race Engineer releases the driver from a pit stop with nothing to do

> **Issue:** [#1180](https://github.com/niklam/iracedeck/issues/1180) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

A stop that ends with nothing done gets its own callout, `pit-crew.pit-status-nothing-to-do`, fed by a new sim-agnostic event `pitService.stopEmpty`. The bundled voices script it onto the existing `pool:pit-status/complete` clips, so the driver hears "Done. Go." today with no clip generation, and a pack may give it a line of its own later. "Pit stop in progress." is held for 250 ms before it is emitted, so an empty stop hears only the release, not a line that is untrue and then cut off.

Both choices are the maintainer's (2026-10-02). Rejected: emitting a synthetic `statusChanged { to: Complete }` — no new callout, but the event would stop mirroring iRacing's status; new clips ("Nothing to do, go.") now — a pack bump and generation run for a line the complete clips already cover; no hold — the go line preempts "Pit stop in progress." 20 ms in, which sounds like "Pit st— Done. Go."; queueing both lines — slower to release the driver, and the first line is false.

## What the sim exposes

One capture holds real stops: `master/local/telemetry-watch-20260919-193233-855.jsonl` (gitignored). By `sessionTime`:

| Stop | InProgress (1) | Then | Notes |
| --- | --- | --- | --- |
| 1 — four tyres and fuel | 448.27 → 467.42, **19 s** | Complete (2), latched until pit exit at 475.55 | "Done. Go." fires today |
| 2 — nothing queued | 597.75 → 597.77, **one tick** | None (0) | `PitstopActive` pulses 597.77–597.80 |

At stop 2's closing tick `PlayerTrackSurface` has read InPitStall since 597.55, but `PlayerCarInPitStall` is still **false** — it turns true at 598.00, after the status has already closed. Any gate on that tick must read the track surface.

Not captured: a stop the driver abandons mid-service. The model assumed here is that the status also drops to None, with the car moving. A capture of a driver pulling away from the box during a queued tyre change confirms or breaks the speed gate below.

## Translator (`sim-events-iracing/src/diff/pit-status.ts`)

**The InProgress hold.** A transition to InProgress emits nothing; it records `now + PIT_STATUS_IN_PROGRESS_HOLD_MS` (250) and the `from` it came from. On a later tick, if the status is still InProgress and the hold has run out, the diff emits the usual `pitService.statusChanged { from, to: InProgress }` and clears the hold. Any status change before then drops the held emit; the new transition's `from` is InProgress, the true baseline. A re-seed (first tick, off-track) clears the hold. 250 ms is two orders of magnitude off either measured duration, and a quarter-second late "Pit stop in progress." on a real stop is not noticeable.

**The empty-stop exit.** On the tick the status goes InProgress → None, the diff emits `pitService.stopEmpty` when both hold:

- `PlayerTrackSurface` is `TrkLoc.InPitStall` — not `PlayerCarInPitStall`, for the reason above.
- `Speed` is at or below the existing `PIT_STATUS_MOVEMENT_SPEED_MPS` (0.05 m/s) on that tick. Instantaneous, not the 500 ms settled-rest window the nags use: the empty stop had been at rest for under that.

Missing telemetry for either counts as qualifying — a callout is never suppressed by absent data (#574). The event fires whether or not "Pit stop in progress." was spoken: a driver who clears every service mid-stop while stationary is free to go too. Every other `* → None` stays silent, as before.

**The catalog.** `"pitService.stopEmpty": SimEvent<"pitService.stopEmpty", Record<string, never>>` in `event-bus`. The name says what happened, not how iRacing reports it, so a second sim's translator can emit it from whatever its own signal is.

## The callout (`audio-scenarios`)

`pit-crew.pit-status-nothing-to-do` fires on `pitService.stopEmpty`, `family: "pit-status"`, default weight, Voice channel and bus — the same shape as the eight status contracts, so a later status still preempts it. It is exported on its own, outside `PIT_STATUS_CONTRACTS`, because `PIT_STATUS_CLIP_SOURCES` derives one `pool:pit-status/<base>` per contract in that list and this one has no pool of its own. The default and shawn scripts carry `"sequence": ["pool:pit-status/complete"]`. A pack that does not script it stays silent for it (the interpreter's "not scripted" path), which is the right failure for a third-party pack.

Both bundled packs' `callouts.json` change, so each gets a version bump and a regenerated catalog entry, and `pack-reference.json` is regenerated.

The scenario harness gets an `event-names.ts` entry for the event and a shortcut driven by a `telemetrySequence` modelled on stop 2 (surface InPitStall, status 1, then 0 a tick later), so it auditions the translator's decision rather than just the clip.

## Out of scope

- Why auto-fuel cleared the fuel request on approach in the capture — #474.
- Clips of its own for the new callout.
- Saying anything when a driver abandons a stop mid-service.
- Any change to the positioning-error nags or the other seven status lines.

## Testing

Unit tests on the diff replay the capture's tick shapes:

- the empty stop: `stopEmpty` once, no `statusChanged` to InProgress;
- a real stop: `statusChanged` to InProgress 250 ms after the transition, then to Complete, and no `stopEmpty`;
- InProgress → None with the car moving, or off the InPitStall surface: silent;
- InProgress → a positioning error inside the hold: only the error is emitted;
- a re-seed inside the hold: nothing is emitted afterwards;
- missing `Speed` / `PlayerTrackSurface`: `stopEmpty` still fires.

Contract and coverage tests pick up the new scenario; the pack-reference freshness test covers the regenerated reference.

Manual: untick every pit service, pit, stop in the box, and hear "Done. Go." with no "Pit stop in progress."; then a normal stop still hears both lines.
