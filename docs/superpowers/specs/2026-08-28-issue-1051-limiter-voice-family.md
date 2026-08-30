> **Issue:** [#1051](https://github.com/niklam/iracedeck/issues/1051) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Race Engineer: two pit-speed callout families, split by limiter equipment

## The decision in one sentence

**The two families differ by remedy, not merely by wording.** A limiter car speeding on pit road is almost always speeding because the limiter is not engaged, and the fix is to press the button; a car without one has to modulate the throttle, and the fix is to lift. No single sentence carries both instructions honestly, and that is what makes two families worth their cost rather than duplication. Every car gets #912's tick plus a spoken line worded for its own equipment; nobody is warned about hardware they do not have, and nobody is left with only a beep.

## The problem

`packages/audio-scenarios/src/catalog/pit-crew/pit-limiter.ts` defines four scenarios — `limiter-on-track`, `limiter-missing`, `limiter-dropped`, `limiter-speeding` — and nothing registers any of them. The only references anywhere are the module itself and its own unit test. `diff/limiter.ts` has been emitting `limiter.missing`, `limiter.dropped` and `limiter.speeding` into a bus with no subscriber, and `carControl.limiterToggled`, which drives the fourth, is unconsumed too: four dormant scenarios across four dormant trigger paths.

**The pools do not exist either.** None of the four pool names the scenarios reference is defined in `pools.ts`; they appear only inside `pit-limiter.ts`. So this was never a registration line — the pools have to be authored and mapped to clips.

One piece of evidence that looks decisive and is not: the header comment in `index.ts` lists limiter callouts among families deferred "as their `voice/{voice}/…` content is generated". It is **stale** — incident alerts, named in the same sentence, is registered now. It should not be read as proof the omission was deliberate, and this change corrects it. It is the second piece of prose in that directory found asserting something untrue; treat comments there as unverified.

## Why two families, and not the fix two workers proposed

Both workers independently recommended dropping the `hasPitLimiter` gate from `limiter-speeding`. The premise was right and is preserved here: **#639's gate is a statement about wording.** "The pit limiter is off. Please, turn it on." is nonsense on a car with no limiter; "You are speeding. Slow down." is true for every car in the sim. Gating the speeding line silences the engineer for the driver who most needs it — no dashboard cue, no hardware holding the car under the limit, judging pit-lane speed by eye.

The fix was rejected because an ungated `limiter-speeding` would still be a **limiter-family** callout reaching cars that have none. The argument that the gate is about wording is precisely the argument against sending that family's content across it. Ungating removed the symptom and kept the cause.

The generalisation worth carrying: **when a gate guards wording rather than applicability, the answer is a second sentence, not a wider gate.** Widening only moves content to an audience it was not written for.

## Family A — cars with a limiter

The four existing scenarios, keeping their `hasPitLimiter` gate exactly as #639 intended. Their eligibility does not change; they need pools, registration, opt-ins and two missing clip sets.

| Scenario | Trigger | Clips |
|---|---|---|
| `limiter-on-track` | `carControl.limiterToggled` | 2 to generate |
| `limiter-missing` | `limiter.missing` | `pit-limiter-001` / `-002` |
| `limiter-dropped` | `limiter.dropped` | 2 to generate |
| `limiter-speeding` | `limiter.speeding` | `pit-limiter-warn-001` only — see the move below |

## Family B — cars without a limiter

Two scenarios, in a new module `catalog/pit-crew/pit-speed.ts`. It is deliberately **not** in `pit-limiter.ts`: putting a limiter-free scenario inside the limiter module would erase the distinction on first contact, and the next person adding a scenario would have no signal about which side of the gate they are on.

**B speeding**, on `limiter.speeding`. Reuses `pit-limiter-warn-002` — "Over the limit. `<break time="0.3s" />` Lift." — which is the non-limiter remedy and has been sitting in the limiter family since it was recorded. The move fixes that rather than duplicating it.

**B pit entry**, on pit-road entry, reusing `pit-entry-001` / `-002` and folding the speed limit into the same callout: *"Pit entry. Mind the limit. The pit speed limit is 60 kilometres per hour."*

### Why the limit rides inside pit-entry rather than standing alone

iRaceDeck **already speaks the pit speed limit**. `session-start.ts` ships a registered conditional clause (#835/#836) — `pit-speed-intro` ("The pit speed limit is") plus a number from `session-start-speed-numbers` plus a unit clip. A standalone limit-value scenario would therefore duplicate a live clause, and it would fire on the same trigger as B's pit-entry line, so the driver would hear two things at once.

What justifies saying it again at all is *when*: at pit entry, when the number is about to matter, rather than at session start, which may be forty minutes earlier. Folding it into the existing callout keeps that value, removes the collision, and needs no new clip.

**`pit-limiter-reminder-001` stays unused — and the reason matters.** It reads "The pit lane speed limit is ", one word from the shipping `pit-speed-intro`. It is set aside because *what it says is already said by a wired-up clip*, not because it is an orphan. Recording the reason is the point: "we left it because nothing used it" invites someone to wire it up later.

### The optional-clause shape, and the sparse number set

The limit clause follows session-start's proven pattern exactly — `{ optional: [...] }` wrapping the intro clip and the number and unit vars, where a var resolving to `null` skips the **whole** clause rather than speaking "The pit speed limit is" into silence.

That matters because `session-start-speed-numbers` is deliberately sparse: 38 values across 24–81, because iRacing pit limits are a small known set and the group covers observed values rather than a range. **Family B inherits that constraint**, so a limit outside the set must skip the clause and still play "Pit entry. Mind the limit." — a complete sentence either way. Do not add clamping; speaking a wrong nearby number is worse than speaking none.

Accepted, and on the manual-test list because it can only be judged by ear: "Mind the limit" followed by "The pit speed limit is 60" is mildly redundant. It reads like a real radio call, and the alternative costs new clips to remove a repetition that may not even register at speed.

### The negated gate is not symmetric — the trap

`hasPitLimiter(t)` is `t?.dcPitSpeedLimiterToggle !== undefined`, so it returns **false for null telemetry**. Family A's gate therefore fails safe: unknown means silent.

A naive family B gate of `!hasPitLimiter(t)` inverts that into failing *loud* — it returns **true** on null, so B would fire on unknown telemetry, including for cars that do have a limiter: the exact audience the split exists to protect, told to lift by an engineer that cannot see their car. B's predicate must be:

```ts
where: (e) => {
  const t = e.telemetry as TelemetryData | null;

  return t !== null && !hasPitLimiter(t);
}
```

The null test is **load-bearing, not defensive**, and simplifying it to a bare negation reintroduces the bug.

The generalisation, which is the reusable part: **a negation is not the mirror image of its predicate whenever that predicate folds "unknown" into "false"** — which is most safe-by-default predicates in this codebase. Negating one silently converts fail-safe into fail-loud. Read the helper before inverting it.

The residual it does not cover: telemetry present but `dc*` fields not yet populated during early connection would read as "no limiter". Accepted — B's triggers only fire on pit road, by which point the snapshot is fully populated.

## The pairing with #912

#912's tick is the layer common to every car: instant, direct playback on `AudioChannel.Radar` outside the interpreter, no margin, not limiter-gated. Each family adds the spoken half for its own audience, so the arrangement is symmetric — which is the point of the split.

**The escalation shape.** The tick is the reflex signal — instant, any overage, no explanation. The voice line is the escalation, firing past `+1.0 m/s` to say what the beep means. The margin, which #912 rejected for the tick and was right to, earns its place here for the opposite reason: it separates "just over — beep only" from "clearly over — beep and a sentence". Without it both fire on identical conditions and the voice adds nothing but latency. They ride different buses, so per #912's decision 1 there is no weight or focus contest to arbitrate.

**The invisible threshold is a documentation problem, not a mechanism one.** Between the limit and `+1.0 m/s` a driver hears a tick and no explanation; past it, a tick and a sentence. Nothing tells them a second threshold exists, so "sometimes it explains and sometimes it doesn't" reads as an unreliable engineer rather than a crossed line. One sentence on the website — the spoken warning comes when you are *clearly* over — fixes it. Cheap in documentation, expensive in mechanism.

**The 5 s cooldown stays, as a decision rather than an inheritance.** It was tuned for a callout with no tick beside it. A driver still speeding five seconds later has ignored both signals, which is exactly when a repeat earns its place; and the cadence difference — a tick about every second against a sentence every five — is what makes them read as two signals rather than one stuttering one.

**The volume sliders are independent, and that is left alone.** The tick rides Radar on the Alerts bus, the voice lines ride Voice. Someone who has turned Radar down for proximity ticks gets the sentence without the beep: the escalation with its first stage missing. Strictly better than the alternative, and the honest fix if it ever bites is a dedicated slider, not a second warning kept as insurance.

## Settings

One opt-in per scenario, following `callout<Polarity><Family><Subject>`:

- Family A: `calloutEnabledLimiterOnTrack`, `calloutEnabledLimiterMissing`, `calloutEnabledLimiterDropped`, `calloutEnabledLimiterSpeeding`
- Family B: `calloutEnabledPitSpeedNoLimiter`, `calloutEnabledPitSpeedEntry`

B's keys name the audience rather than the condition, because that is what a user is choosing — "the pit-speed callouts for cars without a limiter".

Each uses the union-plus-transform chain and `.default(true)` — new Race Engineer functionality ships on — and, like all 73 existing `calloutEnabled*` fields, carries **no `.catch`**. That chain has no throw path, which is the exemption `global-settings.md` names; the `.catch` requirement still binds any plain-value field and this change adds none. Both families are additionally gated by the existing `pitCrewRaceEngineerEnabled` master, with no family master of their own, per the #651 precedent that a callout family is not a mode.

## Clips

**Four new lines**, all family A, sent as one batch and generated only after approval: `limiter-on-track` ×2 and `limiter-dropped` ×2. Both may use limiter framing freely — they only ever play on cars that have one.

**Family B needs no new clips.** `pit-limiter-warn-002` moves to it, and the pit-entry clips and the limit-number clips already exist.

Generation follows the audio-assets workflow: `.env.local` copied from the master checkout, a scoped dry-run showing the proposed wordings, approval, then clips and both manifests committed together. This is the only step in this issue that costs real money.

## Testing

Unit tests extend `pit-limiter.test.ts` and add `pit-speed.test.ts`. The assertion that matters most: **A and B are mutually exclusive and jointly exhaustive over known telemetry, and both silent on unknown.** That last case is the negated-gate trap and deserves its own test — null telemetry must produce neither callout.

Also covered: the limit clause skipping cleanly for a limit with no number clip, leaving a complete pit-entry sentence.

Manual testing is where the pairing is actually judged, because an escalation is heard rather than asserted: on pit road over the limit in a limiter car, confirm tick then A's sentence; marginally over, confirm tick only; the same in a car with no limiter, confirming B's line and never A's; and pit entry in a limiter-less car, confirming the limit is spoken and that the redundancy above sounds acceptable.

## Alternatives rejected

**Deleting `limiter-speeding` and `limiter-on-track`.** Recommended independently by two workers. Overruled: the maintainer wants the engineer to announce speeding, and "no clips exist yet" is not a reason to cut a scenario when clips can be generated.

**Ungating `limiter-speeding` instead of adding family B.** The proposal both workers reached; rejected above.

**Mirroring all four scenarios into family B.** `limiter-on-track` and `limiter-dropped` are impossible without a limiter and `limiter-missing` is meaningless — you cannot be missing what the car does not have. Only speeding has a condition that survives the negation. B's second scenario comes from the reused pit-entry clips, not from A's shapes.

**A standalone spoken-limit scenario.** Would duplicate the live session-start clause and collide with B's pit-entry callout on the same trigger.

**Putting family B in `pit-limiter.ts`.** Convenient, and it would erase the distinction on first contact.

**Dropping the `+1.0 m/s` margin to match the tick.** Both warnings would fire on identical conditions and the voice line would add latency and nothing else.

**Firing the voice line once per episode rather than on a cooldown.** The tick already carries persistence, but a driver still speeding five seconds later has ignored both signals, and a one-shot would need new episode state where the cooldown already exists and works.

**Removing the translator-side speeding machinery.** `limiter.speeding` keeps its subscriber, so `SPEEDING_MARGIN_MPS`, `SPEEDING_COOLDOWN_MS`, `state.speedingWarnedAt`, the emit block, the catalog entry and the harness line all stay. This was correct under the delete recommendation and is a bug under the ruling — called out because it is exactly the tidy-looking cleanup a later reader would attempt after finding that recommendation in the history.

## Follow-ups

**Family A's speeding pool drops to one clip.** Moving `pit-limiter-warn-002` to family B leaves A's speeding line with only `pit-limiter-warn-001` — "You are speeding. Slow down." — so the engineer says exactly the same sentence every time it fires. Correct for the split and worth one or two limiter-framed replacements later ("Limiter's off, you're speeding") if the repetition grates. Not in this batch; flagged so the reduction is a known consequence rather than a discovery.

The muddled-wording flag raised earlier — A's clips carrying the non-limiter remedy — is **resolved** by the move, not deferred.

## Sequencing with #912

Agreed directly between the two workers: **#912's PR merges first and this branch rebases onto it.** #912 already touches `event-catalog.ts`, `state.ts` and `translator.ts`, all adjacent to this work. If #1051 becomes ready first the order is renegotiated before either pushes, rather than discovered in a conflict.

Two documentation consequences follow. The changelog entry **edits #912's existing Features bullet** rather than adding a second — one capability arriving in one release is one line per `changelog.md`, and separate bullets would invite the question of why there are several warnings. The website section extends the **Pit road speeding** section #912 adds to `pit-crew.md` rather than starting a sibling, and is the natural place to make both the `+1.0 m/s` threshold and the two-family split legible: a driver should be able to find out why their car says one thing and their team-mate's says another.
