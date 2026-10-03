# The Race Engineer releases the driver from a pit stop with nothing to do

> **Issue:** [#1180](https://github.com/niklam/iracedeck/issues/1180) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

A stop that ends with nothing done gets its own callout, `pit-crew.pit-status-nothing-to-do`, fed by a new sim-agnostic event `pitService.stopEmpty`. The bundled voices script it onto the existing `pool:pit-status/complete` clips, so the driver hears "Done. Go." today with no clip generation, and a pack may give it a line of its own later. "Pit stop in progress." waits 250 ms before it speaks and is dropped if the status has left InProgress by then, so an empty stop hears only the release, not a line that is untrue and then cut off.

Both choices are the maintainer's (2026-10-02). Rejected: emitting a synthetic `statusChanged { to: Complete }` — no new callout, but the event would stop mirroring iRacing's status; new clips ("Nothing to do, go.") now — a pack bump and generation run for a line the complete clips already cover; no hold — the go line preempts "Pit stop in progress." 20 ms in, which sounds like "Pit st— Done. Go."; queueing both lines — slower to release the driver, and the first line is false.

**Amended after the branch review (maintainer, 2026-10-03).** Three changes to the first version of this spec: the 250 ms hold moved from the translator to the in-progress contract, so `statusChanged` keeps mirroring the sim; the release fires only for the captured shape (InProgress closing within 250 ms), not for any close at rest in the stall; and the release queues behind a busy radio instead of being dropped.

## What the sim exposes

One capture holds real stops: `master/local/telemetry-watch-20260919-193233-855.jsonl` (gitignored). By `sessionTime`:

| Stop | InProgress (1) | Then | Notes |
| --- | --- | --- | --- |
| 1 — four tyres and fuel | 448.27 → 467.42, **19 s** | Complete (2), latched until pit exit at 475.55 | "Done. Go." fires today |
| 2 — nothing queued | 597.75 → 597.77, **one tick** | None (0) | `PitstopActive` pulses 597.77–597.80 |

At stop 2's closing tick `PlayerTrackSurface` has read InPitStall since 597.55, but `PlayerCarInPitStall` is still **false** — it turns true at 598.00, after the status has already closed. Any gate on that tick must read the track surface.

Not captured: a stop the driver abandons mid-service, a stop where every queued service is cleared mid-service, a penalty served in the box, a driver swap. Each could close InProgress → None in the stall; none is the captured shape, so none gets a release (see the duration bound below).

## Translator (`sim-events-iracing/src/diff/pit-status.ts`)

`pitService.statusChanged` keeps mirroring the sim: InProgress is emitted on the tick it appears, as before. The translator records when InProgress began.

**The empty-stop exit.** On the tick the status goes InProgress → None, the diff emits `pitService.stopEmpty` when all three hold:

- InProgress lasted less than `PIT_STATUS_EMPTY_STOP_MAX_MS` (250). The captured empty stop's InProgress lasted one tick; a real stop's lasts seconds. Any longer InProgress that closes to None is one of the uncaptured cases above, where a "go" could be false — a driver told to leave during a penalty hold takes a second penalty — so it stays silent, as every `* → None` did before.
- `PlayerTrackSurface` is `TrkLoc.InPitStall` — not `PlayerCarInPitStall`, for the reason above.
- `Speed` is at or below the existing `PIT_STATUS_MOVEMENT_SPEED_MPS` (0.05 m/s) on that tick. Instantaneous, not the 500 ms settled-rest window the nags use: the empty stop had been at rest for under that.

Missing telemetry for the surface or speed counts as qualifying — a callout is never suppressed by absent data (#574). Every other `* → None` stays silent, as before.

**Known limitation.** The release rests on seeing a one-frame InProgress. The SDK poll can miss a frame under load, and then the stop is silent as it was before this change. No second signal has been measured that would close it (`PitstopActive` pulses for three frames on the same tick and could be missed the same way); a capture under load would say whether it matters.

**The catalog.** `"pitService.stopEmpty": SimEvent<"pitService.stopEmpty", EmptySimEventPayload>` in `event-bus`. The name says what happened, not how iRaceDeck infers it, so a second sim's translator can emit it from whatever its own signal is.

## The callouts (`audio-scenarios`)

**The in-progress hold.** `pit-crew.pit-status-in-progress` gets `triggerDelay: 250` and a `speakGate` that the live `PlayerCarPitSvStatus` is still InProgress (unknown telemetry admits). On an empty stop the status is None by then, so the line is dropped; on a real stop it speaks a quarter-second late. The hold is a fact about how the line should be spoken, so it lives on the consumer, not in the event — the #1138 / #1284 precedent.

**The release.** `pit-crew.pit-status-nothing-to-do` fires on `pitService.stopEmpty`, `family: "pit-status"`, default weight, Voice channel and bus, so a later status still preempts it. It is `queueable: true` with a `speakGate` that the car is still stopped in its box (surface InPitStall, at rest, status None; unknown telemetry admits): it fires at the busiest radio moment of the stop, and a release dropped behind an opponent-pit or limiter line would be the original bug again. Behind the pit-box count-in's last mark it can wait out that contract's 2.5 s queue hold — late, never lost.

It is exported on its own, outside `PIT_STATUS_CONTRACTS`, because `PIT_STATUS_CLIP_SOURCES` derives one `pool:pit-status/<base>` per contract in that list and this one has no pool of its own. A pack that does not script it stays silent for it (the interpreter's "not scripted" path), which is the right failure for a third-party pack.

It rides the existing **Complete** opt-in (`calloutEnabledPitStatusComplete`) rather than a setting of its own: it is the same "you can go" call, so one checkbox silences both — the #951 precedent, where each repeat nag maps onto its transition sibling's opt-in. No new settings key, so no persisted-contract change. The default and shawn scripts carry `"sequence": ["pool:pit-status/complete"]`.

Both bundled packs' `callouts.json` change, so each gets a regenerated catalog entry (both versions are unpublished, so no bump), and `pack-reference.json` is regenerated.

The scenario harness gets an `event-names.ts` entry for the event and a shortcut driven by a `telemetrySequence` modelled on stop 2 (surface InPitStall, status 1, then 0 a tick later), so it auditions the translator's decision rather than just the clip.

## Out of scope

- Why auto-fuel cleared the fuel request on approach in the capture — #474.
- Clips of its own for the new callout.
- A release for any InProgress → None other than the captured shape (mid-stop clear, abandoned stop, penalty, swap).
- A second signal for a missed one-frame InProgress.
- Any change to the positioning-error nags or the other six status lines.

## Testing

Unit tests on the diff replay the capture's tick shapes:

- the empty stop: `stopEmpty` once;
- a real stop: InProgress, then Complete, and no `stopEmpty`;
- InProgress lasting the bound or longer, then None at rest in the stall: no `stopEmpty`;
- InProgress → None with the car moving, or off the InPitStall surface: silent;
- missing `Speed` / `PlayerTrackSurface`: `stopEmpty` still fires.

Contract tests: the in-progress line is dropped when the live status has left InProgress at speak time and plays when it has not; the release queues behind a busy bus and is dropped at speak time once the car has left the box. Coverage tests pick up the new scenario; the pack-reference freshness test covers the regenerated reference.

Manual: untick every pit service, pit, stop in the box, and hear "Done. Go." with no "Pit stop in progress."; then a normal stop still hears both lines.
