> **Issue:** [#1051](https://github.com/niklam/iracedeck/issues/1051) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Race Engineer: wake the pit limiter voice family, and give limiter-less cars their own

## The problem

`packages/audio-scenarios/src/catalog/pit-crew/pit-limiter.ts` defines four scenarios — `limiter-on-track`, `limiter-missing`, `limiter-dropped`, `limiter-speeding` — and nothing registers any of them. The only references to that module anywhere are the module itself and its own unit test. `diff/limiter.ts` has been emitting `limiter.missing`, `limiter.dropped` and `limiter.speeding` into a bus with no subscriber, and `carControl.limiterToggled`, which drives the fourth, is unconsumed too: four dormant scenarios across four dormant trigger paths.

Two things make this more than a registration line.

**The pools do not exist.** None of the four pool names the scenarios reference — `pit-limiter-on-track`, `pit-no-limiter`, `pit-limiter-dropped`, `pit-speeding` — is defined in `pools.ts`. They appear only inside `pit-limiter.ts`, so the pools have to be authored and mapped to clips as part of this.

**Half the clips are missing.** `voice/default/pit-limiter/` holds seven clips with authored lines. `pit-limiter-001`/`-002` ("The pit limiter is off. Please, turn it on.") fit `limiter-missing`; `pit-limiter-warn-001`/`-002` ("You are speeding. Slow down." / "Over the limit. Lift.") fit `limiter-speeding`. `limiter-on-track` and `limiter-dropped` have none. Two further clips are orphaned — `pit-entry-001`/`-002` and a `pit-limiter-reminder-001` composite prefix — and the maintainer has confirmed they stay unused, with no follow-up.

One piece of evidence that looks decisive and is not: the header comment in `index.ts` lists limiter callouts among families deferred "as their `voice/{voice}/…` content is generated". It is **stale** — incident alerts, named in the same sentence, is registered now. It should not be read as proof the omission was deliberate, and this change corrects it. It is the second piece of prose in that directory found asserting something untrue, so treat comments there as unverified.

## Decision: two callout families, split by equipment

The maintainer's ruling: *"There should be two separate callout families: 1 for cars with pit-limiter, 1 for ones without pit-limiter. Then it makes sense."*

- **Family A — cars WITH a limiter.** The four existing scenarios, keeping their `hasPitLimiter` gate exactly as #639 intended. Unchanged in eligibility; they only need pools, registration, opt-ins and the two missing clip sets.
- **Family B — cars WITHOUT a limiter.** New, gated on the negation, and it never mentions a limiter.

### Why this is the right shape, and not the one two workers proposed

Both workers independently recommended dropping the `hasPitLimiter` gate from `limiter-speeding`, reasoning that #639's gate is a statement about **wording** — "The pit limiter is off. Please, turn it on." is nonsense without a limiter, while "You are speeding. Slow down." is true for every car — and that gating it silences the engineer for exactly the driver who most needs telling, since a limiter-less car has no dashboard cue and no hardware holding it under the limit.

The premise was accepted and the fix rejected, and the reason is worth recording: an ungated `limiter-speeding` would still be a **limiter-family** callout reaching cars that have none. The argument that #639's gate is about wording is precisely the argument against sending that family's content across the gate. Two families keep the insight and fix the asymmetry, where ungating kept the asymmetry's cause and removed only its symptom.

**The families differ by remedy, not merely by wording, and that is what makes the cost worth paying.** A limiter car speeding on pit road is almost always speeding because the limiter is not engaged, and the fix is to press the button. A car without one must modulate the throttle, and the fix is to lift. The same sentence cannot carry both instructions honestly. Say this to anyone who reads the two families as duplication: every car gets #912's tick plus a spoken line worded for its own equipment, and neither line lies to its audience.

### Family B is speeding-only

Taking family A's four in turn for a car with no limiter: `limiter-on-track` is impossible (nothing to engage), `limiter-dropped` is impossible (nothing to drop), `limiter-missing` is meaningless (you cannot be missing what the car does not have). Only speeding transfers, because a pit-road penalty does not care what equipment the car has.

Family B therefore ships one scenario. It is not a stunted mirror of A; it is the only member of A's set whose *condition* exists for a limiter-less car at all.

### The negated gate is not symmetric — this is the trap

`hasPitLimiter(t)` is `t?.dcPitSpeedLimiterToggle !== undefined`, so it returns **false for null telemetry**. Family A's gate therefore fails safe: unknown telemetry means no callout.

A naive family B gate of `!hasPitLimiter(t)` inverts that into failing *loud* — it returns **true** for null telemetry, so B would fire on unknown data, including for cars that do have a limiter. B's predicate must be:

```ts
where: (e) => {
  const t = e.telemetry as TelemetryData | null;

  return t !== null && !hasPitLimiter(t);
}
```

The null test is load-bearing, not defensive, and a future reader simplifying it to a bare negation reintroduces the bug. The residual it does not cover: telemetry present but `dc*` fields not yet populated during early connection would read as "no limiter". Accepted, because B's trigger only fires while speeding on pit road, by which point the snapshot is fully populated.

## The pairing with #912

#912 ships a repeating tick while over the pit-road limit: instant, direct playback on `AudioChannel.Radar` outside the interpreter, no start-edge margin, and deliberately not limiter-gated. It is the layer common to every car. Each family adds the spoken half for its own audience, so the arrangement is now symmetric — which is the point of the two-family shape.

**The escalation shape.** The tick is the reflex signal: instant, any overage, no explanation. The voice line is the escalation, firing past `+1.0 m/s` to say what the beep means. The margin, which #912 rejected for the tick and was right to, earns its place here for the opposite reason: it separates "just over — beep only" from "clearly over — beep and a sentence". Without it both warnings fire on identical conditions and the voice line adds nothing but latency. The two ride different buses, so per #912's decision 1 there is no weight or focus contest to arbitrate.

**The invisible threshold is a documentation problem, not a mechanism one.** Between the limit and `+1.0 m/s` a driver hears a tick and no explanation; past it, a tick and a sentence. Nothing tells them a second threshold exists, so the natural reading of "sometimes it explains and sometimes it doesn't" is an unreliable engineer rather than a crossed line. The fix is one sentence on the website saying the spoken warning comes when you are **clearly** over rather than marginally over. Cheap in documentation, expensive in mechanism.

**The 5 s cooldown stays, as a decision rather than an inheritance.** It was tuned for a callout with no tick beside it, so it needed re-deciding. A driver still speeding five seconds later has ignored both signals, which is exactly when a repeat earns its place; and the cadence difference — a tick roughly every second against a sentence every five — is what makes them read as two signals rather than one stuttering one.

**The volume sliders are independent, and that is left alone.** The tick rides Radar on the Alerts bus, the voice lines ride Voice. Someone who has turned Radar down for proximity ticks gets the sentence without the beep: the escalation with its first stage missing. Strictly better than the alternative, and the honest fix if it ever bites is a dedicated slider, not a second warning kept as insurance.

## Shape of the code

Family B lives in its own module — `catalog/pit-crew/pit-speed.ts` — not in `pit-limiter.ts`. Putting a deliberately limiter-free scenario inside the limiter module would re-muddle the distinction the two-family shape exists to draw, and the next person adding a scenario would have no signal about which side of the gate they are on.

Both families register from `index.ts` alongside the existing families, and the stale header comment there is corrected in the same change.

## Settings

One opt-in per scenario, following `callout<Polarity><Family><Subject>`:

- Family A: `calloutEnabledLimiterOnTrack`, `calloutEnabledLimiterMissing`, `calloutEnabledLimiterDropped`, `calloutEnabledLimiterSpeeding`
- Family B: `calloutEnabledPitSpeedNoLimiter`

B's key names the audience rather than the condition, because the family has exactly one member and "the pit-speed callout for cars without a limiter" is what a user is actually choosing. A subject of `Speeding` under a family of `PitSpeed` would read as a stutter.

Each uses the union-plus-transform chain and `.default(true)` — new Race Engineer functionality ships on — and, like all 73 existing `calloutEnabled*` fields, carries **no `.catch`**. That chain has no throw path, which is the exemption `global-settings.md` names; the `.catch` requirement still binds any plain-value field and this change adds none. Both families are gated additionally by the existing `pitCrewRaceEngineerEnabled` master, with no family master of their own, per the #651 precedent that a callout family is not a mode.

## Clips

Six new lines, in one approval batch before anything is generated:

| Scenario | Lines | Wording constraint |
|---|---|---|
| A `limiter-on-track` | 2 | limiter framing free — only ever plays on limiter cars |
| A `limiter-dropped` | 2 | limiter framing free |
| B speeding | 2 | **must never mention a limiter**; the remedy is the throttle, so "lift" rather than "turn it on" |

Generation follows the audio-assets workflow — `.env.local` copied from the master checkout, a scoped dry-run showing the proposed wordings, approval, then clips and both manifests committed together. This is the one step in this issue that costs real money, so it does not happen on unapproved wordings, and both families go in a single batch.

An observation deliberately not acted on: family A's existing `pit-limiter-warn-002` reads "Over the limit. Lift." — the *non-limiter* remedy sitting in the limiter family. A's clips are slightly muddled on the exact axis this ruling draws. Family A is unchanged here as instructed; noted because it is the line to look at if A's wording is ever tightened.

## Testing

Unit tests extend `pit-limiter.test.ts` and add `pit-speed.test.ts`: each family's `where:` predicate, and specifically that **A and B are mutually exclusive and jointly exhaustive over known telemetry, and both silent on unknown**. That last case is the negated-gate trap above and deserves its own assertion — null telemetry must produce neither callout.

Manual testing is where the pairing is actually judged, because the escalation is heard rather than asserted: on pit road over the limit in a limiter car, confirm tick then A's sentence; marginally over, confirm tick only; the same in a car with no limiter, confirming B's line and never A's.

## Alternatives rejected

**Deleting `limiter-speeding` and `limiter-on-track`.** Recommended independently by two workers — the first because #912's cue covers the same condition more directly, the second because it fires on a deliberate driver action. Overruled: the maintainer wants the engineer to announce speeding, and "no clips exist yet" is not a reason to cut a scenario when clips can be generated.

**Ungating `limiter-speeding` instead of adding family B.** The proposal both workers reached. Rejected above: it would send limiter-family content to cars with no limiter, which is the same wording problem #639 identified, pointed the other way.

**Mirroring all four scenarios into family B.** Three of the four have no condition that can occur without a limiter. A symmetric family would be three scenarios that never fire.

**Putting family B in `pit-limiter.ts`.** Convenient, and it would erase the distinction on first contact.

**Dropping the `+1.0 m/s` margin to match the tick.** Both warnings would then fire on identical conditions and the voice line would add latency and nothing else.

**Firing the voice line once per episode rather than on a cooldown.** The tick already carries persistence, so a repeat looks redundant — but a driver still speeding five seconds later has ignored both signals, and a one-shot would need new episode state where the cooldown already exists and works.

**Removing the translator-side speeding machinery.** `limiter.speeding` keeps its subscriber, so `SPEEDING_MARGIN_MPS`, `SPEEDING_COOLDOWN_MS`, `state.speedingWarnedAt`, the emit block, the catalog entry and the harness line all stay. This was correct under the delete recommendation and is a bug under the ruling — called out because it is exactly the tidy-looking cleanup a later reader would attempt after finding that recommendation in the history.

## Sequencing with #912

Agreed directly between the two workers: **#912's PR merges first and this branch rebases onto it.** #912 already touches `event-catalog.ts`, `state.ts` and `translator.ts`, all adjacent to this work. If #1051 becomes ready first the order is renegotiated before either pushes, rather than discovered in a conflict.

Two documentation consequences follow. The changelog entry **edits #912's existing Features bullet** rather than adding a second — one capability arriving in one release is one line per `changelog.md`, and separate bullets would invite the question of why there are several warnings. The website section extends the **Pit road speeding** section #912 adds to `pit-crew.md` rather than starting a sibling, and is the natural place to make both the `+1.0 m/s` threshold and the two-family split legible: a driver should be able to find out why their car says one thing and their team-mate's says another.
