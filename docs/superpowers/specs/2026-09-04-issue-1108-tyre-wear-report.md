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

Rafter's ask, and the right moment. Pit exit is busy, and the exit readback (`pitService.readbackRequested { reason: "exit" }`, fired 4.5 s after `pitLane.exited`) already speaks there; two callouts contesting that moment would be worse than one arriving a few seconds late. So the report is `queueable: true` at `WEIGHT.NORMAL` in its own family, `tyre-wear`, and waits its turn.

Ordering is made deterministic rather than hoped for: the translator publishes `tyreWear.reported` **from the same exit-settle timer as the readback request, after it**. The readback takes the bus; the report defers and replays when the bus idles. Publishing at `pitLane.exited` itself was rejected because it would beat the readback by 4.5 s.

Speaking the report right after `pitStall.departed`, on the limiter, was the alternative. It is earlier, but it lands inside the readback family's territory and the driver is watching for the pit-exit line.

### 5. Every session type

Practice stops are where stint length is being judged, so the report is not race-gated. The usual liveness rules apply: live in the car, not replay-only.

### 6. Skip whole, never fragment

Per #835, a required step that resolves to nothing aborts the whole callout. The report aborts when there is no captured snapshot, when every value reads zero (no wear model, or a capture that never happened), and when a corner's number has no clip for the active voice. The closing clause is `{ optional: … }` so a voice that has the numbers but not the zone words still gets the four figures.

### 7. Clips

- Numbers come free: `session-start-temp-numbers` holds cardinal clips 0–150, and #836's value-pool rule lets the resolver reference `poolRef("session-start-temp-numbers", String(n))` for 0–100.
- New, in a `tyre-wear` group: four corner intros ("Left front", "Right front", "Left rear", "Right rear"), the unit "percent" (no percent clip exists anywhere yet), the closing intro "Wear is heaviest on the", and three zone words ("inside shoulder", "middle", "outside shoulder"). Generated with a scoped dry-run first.

### 8. What the event carries

`tyreWear.reported { corners: { lf, rf, lr, rr }: { tread: number; zone: "inside" | "middle" | "outside" }, heaviest: { corner, zone } }`. The translator does the zone mapping and the minimum, so the scenario only formats; a future consumer (a key showing the same report) reads the same shape.

### 9. Settings

`calloutEnabledTyreWearReport`, default on, the `callout<Polarity><Family><Subject>` shape. No margin, no style, no timing setting.

## Alternatives rejected

**Building on `pit-crew.pit-exit`.** The scenario exists in `pit-exit.ts` but is orphaned: never registered, no pool, no group. Reviving it would entangle a "you've left the pits" line with this report; the report gets its own family instead.

**Reading the values live during the lap.** Not what the sim does (see the model above), and if it were, a post-stop reading of fresh tyres would be meaningless.

**A per-tyre zone clause.** Rejected for length in decision 3.

**A "two most worn" style setting.** Rejected in decision 1.

## Open question

Whether a tyre that was **not** changed should be phrased differently — it is the same tyre, still on the car. Proposed: no. The numbers are the same kind of number either way, and the driver knows which tyres they took.

## Verification

The capture in task 1 (the `telemetry-snapshot` CLI across a tyre-change stop). Then the harness shortcut, then a real stop with and without tyres, listening for the order against the exit readback.
