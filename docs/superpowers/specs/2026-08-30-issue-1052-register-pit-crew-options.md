> **Issue:** [#1052](https://github.com/niklam/iracedeck/issues/1052) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# `registerPitCrew`: from 51 positional parameters to an options object

## The problem, stated as a failure rather than a smell

`registerPitCrew` takes 51 positional parameters — `bus`, `logger`, and 49 optional getters and resolvers, every one defaulted. Almost all share a structural shape (`() => boolean`, `(id: SomeId) => boolean`, `() => Snapshot | null`), so an argument landing in the wrong slot is usually **assignable to that slot**. Inserting a parameter anywhere but the very end slides every later argument at every call site one position left, and it still type-checks.

Nothing fails. No error, no warning. A getter wired to one thing quietly answers for another.

**It happened twice on 2026-08-28, independently, by two different authors.** #912 inserted one parameter and shifted `rolling-start.test.ts` and `register-pit-crew.test.ts`. #1051 inserted two: `register-pit-crew.test.ts` failed 42 tests loudly, because its argument 48 was `() => voiceMasterEnabled` and it landed in a callout-opt-in slot, so the Race Engineer master fell back to `() => true` and callouts fired that the test expected suppressed — while `rolling-start.test.ts` and `start-lights.test.ts` shifted **silently and stayed green**, their trailing arguments being all `undefined`, where one `undefined` in the wrong slot is indistinguishable from the right one.

**The loud failure was luck.** It depended on a test happening to pass a real closure late in the list. The silent case is the ordinary one, it occurred twice, and it is what ships. An argument resting on "we caught it twice" invites the reply that the process works; the honest version is that the process caught the easy one by accident.

### Why the existing convention is not the fix

New parameters are appended immediately before the two master gates, which stay last — the one placement that cannot shift an existing argument. It is documented, and both #912 and #1051 followed it. But it is enforced by each author reading the right paragraph, and its backstop (re-verify by parsing the signature against every call site) only *catches* the error. Neither stops an insertion by someone who has not read either. A convention is not a mechanism.

## What ships

One options object. `bus` required; everything else optional with today's defaults, keyed by the parameter names that exist now. A misplaced or misspelled key becomes a compile error instead of a silent rebinding, and insertion order stops carrying meaning at all.

### Flat, not grouped

49 optional keys is a lot, and grouping them (`callouts`, `snapshots`, `masters`) would read better. **Rejected for this change**: it changes the migration from a mechanical rename into a restructuring, and this conversion's whole difficulty is proving it preserved intent across 17 call sites that all type-check either way. Do one risky thing at a time. Grouping stays available afterwards, when the type system is holding the shape and a mistake is loud.

### A hard cut, not a transition period

No overload accepting either shape. Every consumer is in this repository — 17 call sites, no external API — and keeping the positional form alive would keep the defect alive with it, in the one function where it has already fired twice.

### Defaults live in one place

Each parameter currently carries its own `= () => true` or `= () => null`. Those move into a single destructuring-with-defaults at the top of the function, so the default for a getter is stated once and is greppable, rather than being spread across 49 signature lines.

## The verification is the hard part, and it is a migration artifact

**"It compiles" proves nothing here.** That is not a caveat; it is the entire problem restated. All 17 call sites type-check today whether or not they are correct, and they will type-check after the conversion whether or not each argument reached the key it was meant for. The conversion cannot be reviewed by reading the diff either — 17 call sites of near-identical getters is exactly the diff a reader's eye slides over.

So the check is mechanical, and it runs **against the pre-conversion state**:

1. Parse the old signature to get the parameter list in order.
2. Parse each old call site's argument expressions, in order, and pair them positionally with that list — producing, per call site, a map of parameter name → argument source text.
3. Parse each new call site's object literal, producing key → argument source text.
4. Assert the two maps are equal for every call site, ignoring keys absent from both.

This is the same method that diagnosed both incidents, and it is the only one that answers the actual question. Note step 2 must handle **prefixes**: the call sites are not uniform — production passes 51, 51, 51 and 45, tests run from 51 down to 7 — so a rewrite that assumes a full argument list will mangle the short ones. `scenario-harness/src/main.ts` at 45 is the one that matters most, because its trailing parameters are defaulted deliberately.

**The check is deleted once the conversion lands.** It verifies a migration, not an invariant: afterwards there is no positional list to disagree with, and the type system holds the property permanently. Shipping it as a permanent test would leave a test that appears to guard something which can no longer break — worse than no test, because it implies coverage.

## Consequence to state, not discover

**"Masters last" stops meaning anything.** That convention is what #912 and #1051 both relied on to avoid this bug, and it is documented in `.claude/rules/race-engineer-callouts.md`. Under an options object, position carries no meaning, so the rule is not merely obsolete — keeping it would imply an ordering discipline that no longer does anything, and a future reader would follow it believing it protects them.

So the rule is **replaced rather than deleted**: the paragraph should say that parameters are keyed, that order is irrelevant, and that this is why. Deleting it silently loses the reason.

## Timing

**Do not start until #912 and #1051 have both merged.** Both are in flight, both touch this signature, and both add parameters to it. Converting underneath them would collide with everything and would also invalidate the pre-conversion parse the verification depends on.

## Alternatives rejected

**Leave it and rely on the convention.** It is what is in place, and it failed twice in one day. The second failure went green.

**A lint rule forbidding insertion below a marker parameter.** Enforces the existing convention mechanically without restructuring, which is cheaper. Rejected: it protects only this one function against only this one mistake, and it still leaves 51 positional arguments that a reader cannot check by eye at a call site. It treats the symptom the convention already names.

**Group the options into sub-objects in the same change.** See above — it converts a mechanical migration into a restructuring at exactly the moment the type system cannot help.

**Keep a permanent keys-versus-parameters test.** There is nothing left to compare against after the conversion; the test would assert a tautology while implying coverage.

**Split `registerPitCrew` into several smaller registration functions.** Plausibly the better end state, and a much larger change with its own design questions about what the seams are. It is not excluded by this conversion — an options object is a step toward it, since the groups become visible — but it is not this issue.
