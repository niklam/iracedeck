> **Issue:** [#1108](https://github.com/niklam/iracedeck/issues/1108) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Race Engineer: tyre wear report after a pit stop

## The problem

A pit stop is the one moment iRacing tells you how your tyres actually held up, and it tells you on a screen you are not looking at: the F-key black box, while you are on the limiter watching for your box and then merging into traffic. owwidius asked on Discord for what Crew Chief does here — after the stop, the engineer reads the tread percentages — and Rafter asked for all four corners, spoken after leaving pit road. The number is strategic: it decides whether the next stop needs tyres at all, or only two, and a driver who never hears it pits on habit.

Nothing in the repo reads the wear fields today. `LFwearL/M/R` … `RRwearL/M/R` are typed in `iracing-native` and exposed as template variables, and that is the whole extent of their use.

## The sim model, stated first because everything rests on it

iRacing refreshes the twelve wear values **only while the car is in the pit stall**, and the values describe the tyres that were on the car at that moment. This is the maintainer's ruling and it decides the feature's meaning: after a tyre change the report is a summary of the set that came **off** — the stint just completed — and without a change it describes the tyres still on the car. In both cases the number is the one the driver wants; in neither is it "the state of the fresh rubber", which would read ~100 and be pointless.

Two consequences follow. The values are **captured at `pitStall.departed`**, the last tick in the stall, when they are settled; and a capture across a real tyre-change stop is the **first implementation task**, because the repo holds no empirical record of the refresh timing and a design assuming it must confirm it before wiring anything. The same capture checks the zone mapping below.

## What ships

After a pit stop, once the exit readback has finished, the Race Engineer speaks the four tyres front to rear and then names where the wear is heaviest:

> "Left front eighty-nine percent. Right front ninety-one. Left rear eighty-seven. Right rear eighty-five. Wear is heaviest on the right rear, inside shoulder."

Gated by the Race Engineer master and one new per-callout opt-in, default on.

## Decisions

### 1. All four corners, front to rear, no style setting

owwidius' example named the two worst; Rafter asked for all four. All four ships, as one fixed shape. The rears are where the number usually matters, but a report that names only the two worst hides whether the _other_ two are fine or merely less bad, and the line is long enough to read as a report rather than an alarm either way. A "two most worn" style option was weighed and rejected: it costs a schema field and a settings row to save four seconds of radio, and a user who finds the line too long has the opt-in.

### 2. Per tyre, the lowest of the three zones

Each tyre reports three zones. The spoken figure is the **lowest** of the three, rounded to the nearest whole percent, because the most-worn zone is what ends the tyre's life and is the number a driver acts on. An average was rejected: it smooths over a shoulder that is nearly gone, which is precisely the case the driver needs to hear.

### 3. One closing clause, naming the tyre and its zone

The four numbers are followed by a single sentence: _"Wear is heaviest on the `<corner>`, `<inside|middle|outside>` shoulder."_ It resolves to the tyre with the lowest number and, within it, the lowest zone. This carries the worst-spot information in one place rather than after every corner (a per-tyre zone clause roughly doubles the line and was rejected), and it is where camber and pressure advice starts.

**Zone mapping.** iRacing's L/M/R are the car's left, middle and right. On a left-side tyre L is therefore the **outside** shoulder and R the **inside**; on a right-side tyre it is mirrored. The mapping is stated as the working assumption and is checked by the capture in task 1 — inside-shoulder wear on both fronts (LF `R` low, RF `L` low) is the expected signature.

### 4. Timing: after leaving pit road, queued behind the exit readback

Rafter's ask, and the right moment. Pit exit is busy, and the exit readback (`pitService.readbackRequested { reason: "exit" }`, fired 4.5 s after `pitLane.exited`) already speaks there; two callouts contesting that moment would be worse than one arriving a few seconds late. So the report is `queueable: true` at `WEIGHT.NORMAL` in its own family, `tire-wear`, and waits its turn.

Ordering is made deterministic rather than hoped for: the translator publishes `tireWear.reported` **from the same exit-settle timer as the readback request, after it**. The readback takes the bus; the report defers and replays when the bus idles. Publishing at `pitLane.exited` itself was rejected because it would beat the readback by 4.5 s.

Speaking the report right after `pitStall.departed`, on the limiter, was the alternative. It is earlier, but it lands inside the readback family's territory and the driver is watching for the pit-exit line.

### 5. Every session type

Practice stops are where stint length is being judged, so the report is not race-gated. The usual liveness rules apply: live in the car, not replay-only.

### 6. Skip whole, never fragment

Per #835, a required step that resolves to nothing aborts the whole callout. The report aborts when there is no captured snapshot, when every value reads zero (no wear model, or a capture that never happened), and when a corner's number has no clip for the active voice. The closing clause is `{ optional: … }` so a voice that has the numbers but not the zone words still gets the four figures.

### 7. Clips

- Numbers come free: `session-start-temp-numbers` holds cardinal clips 0–150, and #836's value-pool rule lets the resolver reference `poolRef("session-start-temp-numbers", String(n))` for 0–100.
- New, in a `tire-wear` group: four corner intros ("Left front", "Right front", "Left rear", "Right rear"), the unit "percent" (no percent clip exists anywhere yet), and one whole closing sentence per tire and zone, twelve in all ("Wear is heaviest on the right rear, inside shoulder.", "Wear is heaviest in the middle of the right rear."). Twelve whole sentences replace the spliced intro-plus-zone-word design (see the amendment). Generated with a scoped dry-run first.

### 8. What the event carries

`tireWear.reported { corners: { lf, rf, lr, rr }: { inside, middle, outside, tread: number; zone: "inside" | "middle" | "outside" }, heaviest: { corner, zone } }`, in percent, unrounded. The translator does the zone mapping and the minimum, so the scenario only formats; a future consumer (a key showing the same report) reads the same shape, and gets all three zones rather than only the lowest.

### 9. Settings

`calloutEnabledTireWearReport`, default on, the `callout<Polarity><Family><Subject>` shape. No margin, no style, no timing setting.

## Alternatives rejected

**Building on `pit-crew.pit-exit`.** The scenario exists in `pit-exit.ts` but is orphaned: never registered, no pool, no group. Reviving it would entangle a "you've left the pits" line with this report; the report gets its own family instead.

**Reading the values live during the lap.** Not what the sim does (see the model above), and if it were, a post-stop reading of fresh tyres would be meaningless.

**A per-tyre zone clause.** Rejected for length in decision 3.

**A "two most worn" style setting.** Rejected in decision 1.

## Open question

Whether a tyre that was **not** changed should be phrased differently — it is the same tyre, still on the car. Proposed: no. The numbers are the same kind of number either way, and the driver knows which tyres they took.

## Verification

The capture in task 1 (the `telemetry-snapshot` CLI across a tyre-change stop). Then the harness shortcut, then a real stop with and without tyres, listening for the order against the exit readback.

## Amendment, 2026-09-19: the capture, and two rulings

**The capture** is `master/local/telemetry-watch-20260919-193233-855.jsonl` (gitignored; a `telemetry-watch` recording rather than the snapshot CLI, so the refresh could be timed). It was driven in one session together with #474's auto-fuel questions: a four-tyre stop, then a stop with nothing queued.

- **The values refresh once per stop, as the car arrives in the box**, and never on track. On stop 1, `PlayerTrackSurface` reads InPitStall at 446.77 s, the twelve values change at 447.25 s, and `PlayerCarInPitStall` turns true at 447.47 s. Stop 2 shows the same order (597.55, 597.75, 598.00 s). So the refresh comes a fraction of a second *before* `PlayerCarInPitStall`. Reading at `pitStall.departed` is therefore safe.
- **After a tyre change the values still describe the set that came off**, through departure and pit exit (stop 1: LF 0.991/0.984/0.983, RF 0.986/0.988/0.996, LR 0.990/0.986/0.986, RR 0.989/0.989/0.997, unchanged until the next stop). Without a change they describe the tyres on the car (stop 2). The ruling in *The sim model* holds as stated.
- **The zone mapping holds.** Both fronts wear lowest on the inside (LF `R`, RF `L`), which is the negative-camber signature decision 3 predicted.
- The `…TiresUsed` counters did not move across the four-tyre change, so nothing here depends on them.

**Ruling: "tire", not "tyre", in every identifier** (maintainer, 2026-09-19). The code spells it "tire" throughout (`tireService.changed`, `readback.tirePattern`, `PitSvFlags.LFTireChange`) and had no "tyre" anywhere, and the setting key is persisted user data that cannot be renamed after it ships. The identifiers above are updated in place: `tireWear.reported`, family and clip group `tire-wear`, `calloutEnabledTireWearReport`, scenario `pit-crew.tire-wear-report`. The prose of this record and the filename keep "tyre": the filename is linked from the issue.

**Ruling: a report only after a stop the driver drove into** (maintainer, 2026-09-19). The original decisions did not cover leaving the garage. When the car is placed in its stall and then drives out, the stall departure and the exit readback would have produced a report of fresh tyres ("Left front one hundred percent…") at every session start. A tow into the stall is the same case. The translator therefore reports a stall visit only when the car arrived on pit road from the circuit, with `IsOnTrack` true and the surface not NotInWorld. A visit that begins with the car appearing in the stall (garage "Drive", tow, reset) says nothing.

**Clips: twelve whole closing sentences instead of an intro plus a zone word.** Splicing "Wear is heaviest on the" + a corner + a zone word breaks a sentence in two places, where a TTS voice sounds least natural. One sentence per tire and zone costs twelve short clips and never splices. The middle zone is phrased "Wear is heaviest in the middle of the `<corner>`", since "middle shoulder" is not a thing. The script selects the sentence with a declared-key `case` over `<corner>-<zone>`, so a pack may still collapse it to fewer lines.

**The event carries all three zones per tyre**, not only the lowest (decision 8, updated above), because a future consumer that shows the report on a key wants the whole tyre.

**Found along the way, filed separately:** on the empty stop iRacing went InProgress → None in one tick without ever reporting Complete, so "Done. Go." never played (#1180).

## Amendment, 2026-09-19: decision 4 needed an engine seam

Implementation proved decision 4 incomplete. Publishing the report right after the readback request fixes the order on an idle bus, and only there. The engine keeps **one** pending fire per bus, where the newest fire of at least equal weight wins and the other is dropped. So when the exit readback had to wait, because the spotter shares the Voice bus and rejoining traffic makes that common, the report (`WEIGHT.NORMAL`), arriving right behind it, took the waiting readback's (`WEIGHT.CHATTER`) place, and the pit-exit confirmation was silently lost. The same loss had a mirror route: the readback takes an idle bus, the report parks in the slot, and an interrupt then cuts and stashes the readback.

Three options went to the maintainer: let the report win the slot, let the readback win it (and lose the report exactly when a race needs it), or teach the engine a narrow relation. He chose the relation. It is a new optional `ScenarioContract` field, `queueBehind: readonly string[]`, set on the report as `["pit-crew.pit-readback-exit"]`. A contract field is code-owned scheduling, so no pack can set it.

- While a named contract is the bus's waiting fire, the arriving fire **attaches behind it** instead of competing for the slot, and the two play in order once the bus idles. A named contract that arrives to wait while the follower holds the slot is put back ahead of it. A follower never overtakes its waiting leader, even on an idle bus held by a `pendingHoldMs` hold or a focus floor between the two.
- **Each member keeps the fate it would have had alone.** A later fire at least as heavy as both takes the slot and drops the pair. A fire heavier than the leader but lighter than the follower replaces the leader, as it would have alone, and the follower stays behind it. A lighter fire is dropped.
- **Never stranded:** a leader that fails to take the bus at replay leaves the follower to play next. Everything that clears the slot clears the pair; disabling the follower's own opt-in drops only it. It is a pair, not a queue: a second follower replaces the first.

One limit remains, and it belongs to the engine rather than to this feature (#1185). While the readback is *playing*, the report waits alone in the single slot, and a fire of at least its weight arriving then replaces it, as it would any queueable callout. Removing that means a bounded queue behind the slot, which is a separate decision.

## Amendment, 2026-09-20: the audition rewrote the line, and decision 7's free numbers were not free

The maintainer auditioned the generated report and changed its shape. Decisions 1–6 and 8–9 are untouched; decision 7 is superseded in part.

**The line.** It opens with an intro — "Tire wear at the pit stop:" — and names each corner in the colon form, so the four figures read as a list under a heading rather than as four sentences:

> "Tire wear at the pit stop: Left front: ninety-eight percent. Right front: ninety-nine percent. Left rear: ninety-nine percent. Right rear: ninety-nine percent. Wear is heaviest on the left front, inside shoulder."

**Every corner now carries the unit**, where the first draft said "percent" once after the left front and left the other three bare. That follows from the clip decision below rather than from taste: with the figure and its unit recorded as one clip, saying it once is no longer the cheaper option.

**Decision 7's "numbers come free" was wrong, and the audition is what found it.** `session-start-temp-numbers` covers 0–150 and cost nothing to reuse, but its clips were cut with `next_text: " degrees Celsius,"`. Each therefore ends on the trailing consonant of a phrase that continues, and a sentence that stops on one reads as unfinished — four times a report. The report gets its own group, `numbers-percent`: 101 clips, 0–100, each recording the figure and the unit as one line ("ninety eight percent."). The separate "percent." clip is gone with it, and the script has no percent step. **A number set cut for one unit carries that unit's prosody into every sentence that borrows it**, so reusing a value group is only safe where the words that follow match what it was recorded against.

The maintainer also re-cut `session-start-temp-numbers` in the same pass, adding the "degrees" hint to every entry that lacked it, which commits that group to temperatures rather than leaving it a general-purpose 0–150 set.
