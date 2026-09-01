> **Issue:** [#1052](https://github.com/niklam/iracedeck/issues/1052) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# `registerPitCrew`: from positional parameters to an options object

> Every figure below was measured with the TypeScript compiler API against `00f2e912`. **Any count of these parameters is stale the moment it is written.** The arity went 51 → 50 → 52 in the twelve hours around #912 and #1051 landing; the issue title was corrected once and was wrong again within a day; this spec's own first draft said 51. Re-measure rather than trusting a number here. That instability is an argument *for* the correspondence check below, not against it.

## The problem, stated as a failure rather than a smell

`registerPitCrew` takes 52 positional parameters — `bus`, `logger`, and 50 optional getters and resolvers, every one defaulted. Almost all share a structural shape (`() => boolean`, `(id: SomeId) => boolean`, `() => Snapshot | null`), so an argument landing in the wrong slot is usually **assignable to that slot**. Inserting a parameter anywhere but the very end slides every later argument at every call site one position left, and it still type-checks.

Nothing fails. No error, no warning. A getter wired to one thing quietly answers for another.

**It happened twice on 2026-08-28, independently, by two different authors.** #912 inserted one parameter and shifted `rolling-start.test.ts` and `register-pit-crew.test.ts`. #1051 inserted two: `register-pit-crew.test.ts` failed 42 tests loudly, because its argument 48 was `() => voiceMasterEnabled` and it landed in a callout-opt-in slot, so the Race Engineer master fell back to `() => true` and callouts fired that the test expected suppressed — while `rolling-start.test.ts` and `start-lights.test.ts` shifted **silently and stayed green**, their trailing arguments being all `undefined`, where one `undefined` in the wrong slot is indistinguishable from the right one.

**The loud failure was luck.** It depended on a test happening to pass a real closure late in the list. The silent case is the ordinary one, it occurred twice, and it is what ships. An argument resting on "we caught it twice" invites the reply that the process works; the honest version is that the process caught the easy one by accident.

## The hazard, measured

The intuitive version of this problem is "several parameters share a shape, so a misplaced argument still compiles". That is true and it understates the exposure by more than an order of magnitude — which matters, because the understatement is what makes the conversion look reviewable by eye.

The question to ask of each slot is directional: **if the wrong value lands here, does it still compile?** That is assignability from the source expression's type to the target slot's type. A *one-way* pair is therefore exactly as silent as a mutually-assignable one — it simply also fails in the direction nobody is exercising.

Measured at `00f2e912`:

```text
174  directed silent-swap edges (the value of X is accepted in the slot of Y)
 12  of them mutual
150  one-way
 40  of 52 parameters exposed to at least one edge
 12  parameters type-protected
```

The dominant mechanism is that a zero-argument `() => boolean` is assignable to any `(id: SomeId) => boolean`, since a function may ignore parameters it is handed. Each of the five zero-argument boolean getters is consequently accepted in **32** other slots.

Mutual assignability — the frame this spec's first draft used, and the one the issue discussion inherited — describes only the 12 mutual pairs. It is a special case of the above, not the shape of the problem.

### There is no "dangerous pair"

The `() => boolean` equivalence class has **five** members, not two:

```text
# 5  getPitActionsAllowed
# 6  getPitServiceRequestsEnabled
#20  getRaceFinishedFired
#51  getRaceEngineerMasterEnabled
#52  getRadarMasterEnabled
```

Three of them are not master gates. A swap between #5 and #51 is exactly as invisible as one between the two masters, so the working shorthand of "the two masters are the pair the compiler cannot tell apart" should be retired rather than softened: it is ten silent pairs, not one.

### The edge that will actually bite

`getFlagCalloutEnabled` (#2) is assignable into the slot of `getOpponentFlagCalloutEnabled` (#46).

`FlagCalloutId` has 22 members; `OpponentFlagCalloutId` has four — `black`, `disqualify`, `furled`, `meatball` — a strict subset. Function parameters are contravariant, so a getter accepting the *wider* union satisfies a slot expecting the narrower one. The reverse is correctly rejected.

This is the edge to hold in mind, because it is the only one that is both silent **and** plausible: two flag getters, adjacent in meaning, forty-four positions apart in the list. Every other edge in the set pairs values a reader would never confuse — which is precisely why the count alone is not persuasive and this example is.

### What #912 and #1051 did *not* do

All three getters those issues added take distinct id unions, so none joined an equivalence class. The mutual figure is unchanged at 9 parameters in 3 classes despite the arity moving 50 → 52: **the new parameters did not enlarge this hazard.**

One point worth recording so it is not re-derived later: `PitLimiterCalloutId` and `NoLimiterCalloutId` share the member `"speeding"`, and are assignable in **neither** direction. The compiler catches that swap. The shared literal is a **human** readability trap for whoever keys the object — not a type hole.

### Why the existing convention is not the fix

New parameters are appended immediately before the two master gates, which stay last — the one placement that cannot shift an existing argument. It is documented, and both #912 and #1051 followed it. But it is enforced by each author reading the right paragraph, and its backstop (re-verify by parsing the signature against every call site) only *catches* the error. Neither stops an insertion by someone who has not read either. A convention is not a mechanism.

## What ships

One options object. `bus` required; everything else optional with today's defaults, keyed by the parameter names that exist now, following the `registerX(bus, deps)` precedent already set by `registerPitSpeedingEngine` and `registerSpotterEngine` in this same file. A misplaced or misspelled key becomes a compile error instead of a silent rebinding, and insertion order stops carrying meaning at all.

### Flat, not grouped

50 optional keys is a lot, and grouping them (`callouts`, `snapshots`, `masters`) would read better. **Rejected for this change**: it changes the migration from a mechanical rename into a restructuring, and this conversion's whole difficulty is proving it preserved intent across 17 call sites that all type-check either way. Do one risky thing at a time. Grouping stays available afterwards, when the type system is holding the shape and a mistake is loud.

### A hard cut, not a transition period

No overload accepting either shape. Every consumer is in this repository — 17 call sites, no external API — and keeping the positional form alive would keep the defect alive with it, in the one function where it has already fired twice.

### Defaults live in one place

Each parameter currently carries its own `= () => true` or `= () => null`. Those move into a single `DEFAULT_DEPS` object, matching the two engines above, so the default for a getter is stated once and is greppable rather than spread across 50 signature lines.

## Two semantic hazards the type system will not see

Both are invisible to the correspondence check below, because that check compares *which expression reaches which name* — and in both of these the expression and the name are already right. They are recorded here because a conversion that tidies them is the natural mistake.

**The three callout getters are not wired alike.** #49 and #50 are passed as raw id-taking getters into `wrapCalloutScenario`, which resolves the id per scenario at event arrival. #48 is not: it is consumed as a pre-bound zero-argument thunk inside an engine dependency object —

```ts
registerPitSpeedingEngine(bus, {
  getMasterEnabled: getRaceEngineerMasterEnabled,
  getCueEnabled: () => getPitSpeedingCalloutEnabled("cue"),
  logger,
});
```

— because that cue plays from the imperative engine and has no `where:` to gate. The id is bound at registration; the *value* is still read live, on every invocation, deliberately. A conversion that maps all three symmetrically through `wrapCalloutScenario` would type-check and silently move **when the gate is evaluated**. Keep the asymmetry.

**`PIT_LIMITER_POOL_NAMES` and `NO_LIMITER_POOL_NAMES` look dead and are not.** Their only consumer is `register-pit-crew.test.ts`, which asserts each pool still resolves to a non-empty clip set — the guard against a callout that is registered, enabled, unit-tested and mute. Both are computed as `Object.keys(POOL_REGISTRY).filter(...)` on a name prefix, so a prefix rename silently yields `[]` and every `for…of` over them passes vacuously; the test compares them against literal lists precisely to catch that. An export-pruning pass over this module would take both and delete the guard with them.

## The verification is the hard part, and it is a migration artifact

**"It compiles" proves nothing here.** That is not a caveat; it is the entire problem restated. All 17 call sites type-check today whether or not they are correct, and they will type-check after the conversion whether or not each argument reached the key it was meant for. The conversion cannot be reviewed by reading the diff either — 17 call sites of near-identical getters is exactly the diff a reader's eye slides over.

So the check is mechanical, type-blind, and runs **against the pre-conversion state**:

1. Parse the old signature to get the parameter list in order.
2. Parse each old call site's argument expressions, in order, and pair them positionally with that list — producing, per call site, a map of parameter name → argument source text.
3. Parse each new call site's object literal, producing key → argument source text.
4. Assert the two maps are equal for every call site, ignoring keys absent from both.

This is the same method that diagnosed both incidents, and it is the only one that answers the actual question. Step 2 must handle **prefixes**: the call sites are not uniform. Measured at `00f2e912` — the three plugins pass 52, `scenario-harness/src/main.ts` passes 48, and the tests range from 52 down to 7 across nine distinct arities. A rewrite assuming a full argument list will mangle the short ones.

Two call sites deserve naming. `scenario-harness/src/main.ts` stops at 48 **deliberately** — it seeds no `calloutEnabled*` settings and wants the masters at their `() => true` defaults, so it must not be "completed" during the conversion. And `rolling-start.test.ts` and `start-lights.test.ts` each pass 52 arguments of which 49 are `undefined`: still exactly the shape that shifted silently and stayed green in August.

### The check is deleted once the conversion lands

Not merely because it would imply coverage it no longer provides — the sharper reason is that **it has no input**. Its baseline is the positional signature; after the conversion there is no positional list left to disagree with, so the check cannot be run at all, let alone kept.

What survives the conversion is a different and much smaller hazard: a wrong value at a *right* key still compiles, since the 174 edges above are properties of the types, not of the calling convention. That residual is not what this check tests, so keeping it would not cover it either. It is also qualitatively milder — a mis-key is written next to the correct name and is locally visible at the call site, where an insertion shift acted at a distance, breaking call sites the author never opened. If it is ever worth closing, branded id types would do it structurally; that is a separate issue, not this one.

## Consequence to state, not discover

**"Masters last" stops meaning anything.** That convention is what #912 and #1051 both relied on to avoid this bug, and it is documented in `.claude/rules/race-engineer-callouts.md`. Under an options object, position carries no meaning, so the rule is not merely obsolete — keeping it would imply an ordering discipline that no longer does anything, and a future reader would follow it believing it protects them.

So the rule is **replaced rather than deleted**: the paragraph should say that parameters are keyed, that order is irrelevant, and that this is why. Deleting it silently loses the reason.

## Alternatives rejected

**Leave it and rely on the convention.** It is what is in place, and it failed twice in one day. The second failure went green.

**A lint rule forbidding insertion below a marker parameter.** Enforces the existing convention mechanically without restructuring, which is cheaper. Rejected: it protects only this one function against only this one mistake, and it still leaves 52 positional arguments that a reader cannot check by eye at a call site. It treats the symptom the convention already names.

**Group the options into sub-objects in the same change.** See above — it converts a mechanical migration into a restructuring at exactly the moment the type system cannot help.

**Keep a permanent keys-versus-parameters test.** There is nothing left to compare against after the conversion; the test would assert a tautology while implying coverage.

**Split `registerPitCrew` into several smaller registration functions.** Plausibly the better end state, and a much larger change with its own design questions about what the seams are. It is not excluded by this conversion — an options object is a step toward it, since the groups become visible — but it is not this issue.
