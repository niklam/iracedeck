# Gap and status calls stay quiet under a caution

> **Issue:** [#1171](https://github.com/niklam/iracedeck/issues/1171) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

Three contracts fall silent while a full-course caution is out: `pit-crew.gap-trend`, `pit-crew.gap-threshold` and `pit-crew.race-status`. Each checks the caution twice, once in its `where:` when the event arrives and once in its `speakGate` just before the line takes the bus. The race status also refuses a lap that `lap.completed` marks `wasCaution`, which covers the one caution lap that completes under green. The gap translator stops treating a caution as racing, as the overtake diff already does, so nothing measured behind the pace car can drive a call once the green is out. No setting is added.

This builds on #1127, cited at its branch HEAD `7a1c6e53c` (`ir-1127`, unmerged when this was written). Every #1127 name below is its spelling there: `getUnderFullCourseCaution`, `getCautionPhase`, `state.cautionPhase`, `diffCaution` and `lap.completed.wasCaution`. The work starts once #1127 merges.

## Rulings confirmed

Niklas confirmed these on 2026-09-19:

- **The race status is gated here.**
- **The gap diff stops emitting under a caution**, as the overtake diff does.
- **The first green lap after a restart gets the opening-lap treatment** for gap calls.
- **The lap that ends a caution is fixed inside #1127, not here.** #1127 now adds `lap.completed.wasCaution` and makes lap-time and position-change refuse it. This change only consumes the field for the race status.

## What the design rests on

- **Both gap contracts are queueable, and neither has a trigger delay.** The trend call is `WEIGHT.CHATTER` and the threshold call is `WEIGHT.NORMAL`. Each already has a `speakGate`: the claim on the shared gap cooldown (#1137). `pit-crew.race-status` is queueable at `WEIGHT.CHATTER` with no `triggerDelay`, and its `speakGate` is the shared `positionReadoutSpeakGate`. None of the three reads the caution today. So "held by a trigger delay" has no case to cover here. If a delay is added later, the speak-time gate below covers it, since a delayed fire meets that gate when it expands.
- **A pending fire is never re-judged by its `where:`.** The single pending slot has no TTL, and `setPending` replaces the waiting fire whenever `weight >= pending.weight`. So a fire queued behind a busy bus before the throw can drain into the caution. That is the case #1127's own caution gates exist for.
- **The trend state lives in the translator, not in the callout.** `gaps.ts` in `audio-scenarios` holds only the shared cooldown timestamp. Everything that remembers the story lives in `sim-events-iracing`'s `diff/gaps.ts`. For each side that is:
  - the gap extremes since the last announcement (`gapMin/MaxSinceAnnounce*`)
  - the closing-projection latch (`gapContactAnnouncedLaps*`)
  - the breakaway latch
  - the threshold arming
  - the stability streak
  - the smoothed rate chain (the EMA and its checkpoint)

  A callout gate alone therefore cannot stop a call measured across the pickup. For example, a 10 s gap before the throw is still that side's recorded peak when the double-file restart has closed it to 0.4 s. Any closing rate on the first green lap then passes the consistency gate and says "We're gaining on the car ahead."
- **The overtake diff already handles this case** (#574). Under `Caution | CautionWaving | Yellow | YellowWaving` it suppresses events and silently rolls every baseline, "so the first racing tick after green seeds cleanly from the settled green-flag order". The gap diff has the equivalent for pit road and off-track (it excludes those readings and disarms the threshold) but nothing for a caution.
- **The lap that ends a caution completes under green.** This spec's research found it, and #1127 added `wasCaution` because of it. In both committed captures, every car's `CarIdxLapCompleted` increments after the restart's `Green` tick, not on it:
  - Homestead (`caution-restart-20260917.json`): 2.2–5.0 s after the green (492.82 → 494.97–497.83), and 2.3–5.1 s after the second (872.45 → 874.70–877.55).
  - The road course (`caution-road-20260918.json`): 2.8–11.6 s after the green (466.95 → 469.70–478.50).

  So the `lap.completed` for the one-to-go lap arrives with the caution already over, although the car ran that lap entirely behind the pace car. A gate on "is a caution out now" lets exactly that one lap through, once per caution.

## Which contracts

The change covers `pit-crew.gap-trend`, `pit-crew.gap-threshold` and `pit-crew.race-status`. The race status belongs in the same change because it is the same kind of call. It is a racing-status cue with nothing to say under a caution: the order is frozen, and its every-three-laps cadence counts laps behind the pace car. The caution's own position call on the last lap already gives the race position. It takes the same dependency and gets the same tests.

#1127 deliberately left the race status to this change, even for the `wasCaution` lap. Gating only its last caution lap would have made it speak on every caution lap except the last one.

Considered and left out:

- **The overtake family** is already silent in the translator (see above).
- **Lap-time and position-change** are fully gated by #1127, both on "caution out now" and on `wasCaution`. This change does not touch them.
- **Pit open/closed, opponent pits, the flag family and fuel** are still useful under a caution. For pit calls, #1127 ruled that explicitly.
- **Local yellows** are not what the issue is about. Nothing reports the gap calls misbehaving under one, and nothing here changes their handling.

## Two checks: the `where:` and the `speakGate`

**The dependency is `getUnderFullCourseCaution`, not `getCautionPhase`.** Each of the three contracts takes it as a new builder parameter, defaulting to `() => false` as #1127's lap-time and position builders do. Both dependencies are `PitCrewDeps` entries, wired in all three plugins and the harness `main.ts`, so no plugin changes. The boolean is the right one because these gates ask whether a caution is out, never which stage it is at. The translator defines it as `getCautionPhase() !== "none"`, so the two cannot disagree. It is also the question lap-time and position-change already ask, and the race status sits beside them in `registerPitCrew`. `getCautionPhase` is for the caution family's own calls, which need to know the stage.

- **In `where:`, the contract refuses while a caution is out.** For the gap calls the check goes in `gapWhereGates`, after the race-finished latch and before the overtake gate and the pure cooldown read. For the race status it goes beside the race-finished latch, together with `data.wasCaution === true`, written the way #1127's lap-time and position-change gates write it. The `where:` check does work the speak-time gate cannot: it keeps a caution-time fire out of the single pending slot. Without it, a threshold call at `NORMAL` weight could take the slot and silently evict an equal- or lower-weight call already waiting there.
- **In `speakGate`, the contract refuses while a caution is out.** This is the inverse of the caution family's own gate. The caution check must run before the existing claim, never after it. The gate is the one place a cooldown is claimed (#1137), and a claim followed by a refusal would burn the window for a call nobody heard.
  - The gap gate becomes `admit: (ctx) => !underCaution() && tryClaimGapCallout(ctx.now, cooldownMs())`. `gapSpeakGate` gains the resolver as a second parameter.
  - The race status gets its own gate: `!underCaution() && positionReadoutSpeakGate.admit(ctx)`. The shared gate itself is untouched, because the two overtake readouts use it too. When the caution check refuses, the shared gate's intro-decision stash is not taken. That is harmless: the stash is keyed to the fire that wrote it and read back only through the matching `ScenarioContext`, so a later fire cannot inherit it.
  - `wasCaution` is not asked at speak time. It is a fact about the completed lap, fixed when the event is emitted, so the `where:` has already answered it.
- **Both checks are needed, as #1127 found for its own calls.** A `where:` alone lets a pre-throw fire drain into the caution. A `speakGate` alone lets a caution-time fire occupy the pending slot.

**One residual cannot be closed.** Suppose a fire already passed its gate and was playing when the caution came out. If an interrupting call then cuts it (a spotter proximity call, the meatball, fuel critical or a pit-box mark), it is stashed with `admitted: true`. It then replays whole without being asked again. Neither check reaches it. Only `queueable: false` would, and giving up queueing across the whole gap family would lose ordinary calls behind the spotter to cover a rare case. This is accepted, and the module headers say so as `caution.ts` does. The caution announcement itself does not interrupt, so a gap call already playing when the flag comes out finishes and the announcement follows. That is accepted too, since the call began under green.

## The translator: under a caution, the gap model is not racing

`diffGaps` reads `state.cautionPhase` directly, since it runs inside the translator and needs no injected reader. It is the value `getCautionPhase()` and `getUnderFullCourseCaution` return to the callouts, so both halves of this change answer from one phase. Deriving it again from the flag bits would break #1127's rule of one derivation. The overtake diff's older bit test is left as it is.

The tick order at #1127's HEAD puts `diffCaution` (`translator.ts:1952`) before `diffGaps` (`:2055`), so the phase `diffGaps` reads is the one the same tick settled. `diffGaps` only reads it, so it adds no new ordering constraint. `translator.test.ts` pins that order, and `state.ts`'s list of the phase's readers gains `diffGaps`.

While the phase is not `"none"`:

- **The traces and the live gaps keep updating.** So Session Info's Gaps display and `getLiveGapBetween` behave exactly as they do today. The display rate chain is left alone too.
- **Each side's callout bookkeeping is held at its reset value.** That covers the extremes, the contact latch, the breakaway latch, the threshold arming and the stability streak. Step 4 (`maybeEmitCalloutEvents`) does not run, so no `gap.*` event is emitted. `resetSideState` splits into its two halves for this, the rate chain and the callout bookkeeping. It keeps calling both where it does today: a neighbour change and a backwards jump.
- **The opening-lap grid assumption extends to the restart.** On every caution tick the diff records the player's progress plus one lap, and `firstLap` holds while the player's progress is below that mark. After the green the mark stops moving, so the assumption covers exactly one lap of running from the restart. #933's reasoning carries over unchanged. A double-file restart puts the field nose-to-tail by construction. A neighbour that opens past the re-arm point and closes back is the field sorting itself out, not a catch. Without this, a restart lap could say "We've caught the car ahead" where a start lap never would.

The bookkeeping is held for the whole caution, rather than reset once at the green, because holding needs no edge detection. The bookkeeping is empty at the green however the phase reached `"none"`: the green edge, the both-bits-clear expiry, or a withdrawn one-to-go. A replay glance that preserves the phase cannot desynchronise it either. The rate chain is not held because it forgets on its own. With α = 0.15 per 0.02-lap checkpoint, a sample's weight falls to about 9% within 0.3 lap. The one-to-go lap is a whole lap of steady formation before the green. What survives a caution is the bookkeeping, not the rate.

**This changes when two published events fire.** `gap.trendChanged` and `gap.thresholdCrossed` are no longer emitted while a full-course caution is out. Both catalog doc comments say so, next to "suppressed while either car is on pit road / off track". The catalog already calls these events RELEVANT developments, and the diff decides relevance. No consumer outside the gap callouts subscribes to either event (checked on 2026-09-19). #1168's caution catch-up call measures the lineup, not these events.

## The lap that ends a caution

`lap.completed.wasCaution` exists in #1127:

- It is optional and only ever `true`, meaning the translator's caution phase was live on some tick of the lap.
- It is latched per lap in `diffLaps` (`lapCautionLatchLap`, `lapCautionSeen`, `lapCompletedWasCaution`).
- It is kept apart from `fuel-laps.ts`' bit-based flag of the same name.

#1127 added it because of the measured finding above, and its lap-time and position-change gates already refuse such a lap.

This change adds nothing to the translator for that lap. The race status refuses a `wasCaution` lap in its `where:`, next to its new "caution out now" check. The two checks cover different laps. "Out now" silences every lap that completes while the caution is live. `wasCaution` silences the one lap that completes after the green, and every lap it covers is one "out now" also covers, bar that last one.

The race-status cadence itself is untouched. Laps under a caution still count toward its every-three. A cadence hit that falls on a caution lap is simply not spoken, and the next one comes three laps later.

## No setting

No setting is added. #1127 silenced lap-time and position-change unconditionally, with no switch. The standing rule that each new call gets its own `calloutEnabled…` key is about adding a call, not about taking an existing call out of a moment where it has nothing to say. `calloutEnabledGapTrend`, `calloutEnabledGapThreshold` and `calloutEnabledRaceStatus` keep their meaning, and their labels stay true.

## Tests

**`audio-scenarios`.** These follow the shape of #1127's lap-time and position tests:

- `gaps.test.ts`, for each gap contract:
  - It is silent through `where:` while a caution is out, and it claims nothing: the next call after the caution speaks.
  - It fires normally when no caution is out.
  - A fire deferred behind a busy bus before the caution and replayed while it is out is refused by the gate, and the cooldown stays unclaimed.
  - A fire replayed after the green speaks.
- `race-status.test.ts`: the same four cases.
  - A cadence lap carrying `wasCaution: true` that arrives after the green, with the resolver already false, is silent. That is #1127's lap-time and position test shape, pinning the exact hole the field closes.
  - The next cadence lap without the field speaks.
- The changed contract `description`s and the new gate `description`s still pass `bundled-scripts.test.ts`: non-empty, ending in a full stop, at most 200 characters.

**`sim-events-iracing`:**

- `gaps.test.ts`:
  - No `gap.*` event while the phase is not `"none"`, while `getLiveGaps()` still updates.
  - The case the issue names: a peak recorded before the caution does not produce "gaining" on the first green lap.
  - A breakaway latch and a threshold arming from before the caution do not survive it.
  - The restart lap applies the grid assumption, and the lap after it does not.
  - The rate chain is untouched under a caution.
- `translator.test.ts`: pins `diffGaps` running after `diffCaution`, as #1127 pins its phase readers.

**Not tested here:** `wasCaution` itself. #1127 proves it through the oval fixture replayed through the real translator.

**Harness.** No new button, because no call is new. The manual check is to run *Flags → Caution → restart* with the race session and hot-lap presets, and press a Gaps shortcut partway through. It should be silent. Afterwards it should speak. The Gaps shortcuts publish their events directly, so they exercise the callout gates only. The translator half is covered by the unit tests. The race-status shortcuts cannot show the difference: the hot-lap preset gives the canonical order no per-car lap progress, so the status call has no live position and is mute either way. The unit tests carry it.

## Documentation and artifacts

- **Website Pit Crew page.** *What changes while a caution is out* gains the gap and status calls. The Gap callouts section's list of quiet moments and the race-status section each gain a clause. For the race status, the clause includes the lap the caution ends on.
- **Changelog.** If #1127's caution line is still in the unreleased section, extend its sentence about calls that "stay quiet" instead of adding a line (`changelog.md`: a refinement of a listed capability edits that line). Otherwise it gets a line of its own.
- **Code comments.** Update the event-catalog doc comments for `gap.trendChanged` and `gap.thresholdCrossed`. The `lap.completed.wasCaution` comment names the callouts that refuse the lap, so it gains the race status. Also update the reader list on `cautionPhase` in `state.ts` and the `diff/gaps.ts` module header.
- **`race-engineer-callout-examples.md`.** One entry with the reusable lesson: a caution voids a relevance model's bookkeeping, so the model is held at rest for the caution rather than gated only at the callout.
- **`race-positions.md`.** No change.

## Rejected alternatives

- **The `where:` alone:** a fire queued before the throw drains into the caution.
- **The `speakGate` alone:** a caution-time fire takes the pending slot and can evict a waiting call.
- **Callout gates with no translator change:** the pickup-measured story fires on the first green lap, because the peak recorded before the caution survives it.
- **Keep emitting under the caution and reset the bookkeeping once at the green:** this publishes as relevant developments what the diff knows are not, and every path by which a caution ends would need to hit the reset edge.
- **Hold the rate chain as well:** it would blank the display trend for a tenth of a lap after every restart, to prevent a carry-over the EMA already forgets.
- **Gate the race status on `wasCaution` alone:** it would silence only the lap that ends the caution and leave the status speaking on every caution lap before it. This is the reason #1127 left the race status for this change.
- **`getCautionPhase` in these gates:** see *Two checks*. These gates ask a yes/no question, and the boolean is the reader that asks it.
- **`queueable: false` for the gap family,** to close the admitted-then-cut residual: see above.

## Unverified, and what would settle it

- **Whether the lap-counter lag holds at a single-file restart.** Both captured restarts were double file. Nothing here depends on the answer: `wasCaution` marks the lap however long the lag is.

None of this blocks implementation.

## Order of work, and review

1. After #1127 merges, change the translator first: hold the gap bookkeeping under a caution, and extend the grid assumption.
2. Then the three contracts.
3. Then the documentation.

No catalog field is added, since `wasCaution` is #1127's. But the change still alters when two published catalog events fire: `gap.trendChanged` and `gap.thresholdCrossed` stop under a full-course caution. That is a change to the published event catalog's behaviour, so it takes an `xhigh` review (`code-review.md`).
