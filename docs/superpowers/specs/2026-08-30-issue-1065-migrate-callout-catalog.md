> **Issue:** [#1065](https://github.com/niklam/iracedeck/issues/1065) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Migrating the callout catalog to pack scripts

The format is decided in the [#1064 spec](2026-08-30-issue-1064-callout-scripts-in-voice-packs.md); this records only what is specific to moving the remaining ~11 families across.

## Why finish it rather than migrate opportunistically

A half-migrated catalog is worse than either end state. A contributor adding a callout has to know which idiom the family uses, `race-engineer-callouts.md` has to document both paths, and the generated reference [#1066](https://github.com/niklam/iracedeck/issues/1066) depends on cannot be generated from a catalog where half the scripts are still closures. A voice pack cannot meaningfully override "everything except the eleven families that are still hardcoded".

## Readback goes first, not last

Pit readback is the entry most likely to read badly as data — it is the longest thing the engineer ever says, and its tire slot is a fifteen-way exhaustive table. The #1064 spec already writes it out and concludes the format holds *provided* the table becomes a `case` with a declared key set. That conclusion should be re-tested against the real file at the start of this issue rather than assumed, because if the format does buckle anywhere it buckles there, and finding out on the first family is far cheaper than on the last.

## No codemod

The two rules in the #1064 spec — *a lookup is a var, a condition is a choice*, and *a fragment may not be optional, a clause may* — both require reading each conditional on its own terms. A mechanical translation gets the second one wrong in exactly the cases that matter, because `{ if }` and `{ optional }` are structurally interchangeable and semantically opposite.

Every conditional step migrates as a judgement, one at a time, with the question asked explicitly: **if this step resolves to nothing, is what remains still true?**

## `voice-parity.test.ts` is replaced, and the replacement is stronger

The current test fails CI for any non-default voice carrying a `<group>/<base>` the default lacks, reasoning that:

> a base the canonical default voice doesn't know is referenced by no pool, so it would never play — almost certainly a misspelling

That premise holds only while pools come from `POOL_REGISTRY` in code. Once a pack ships its own scripts, its own base is referenced by its own sequence — not dead, just not ours. Enforcing parity would forbid the central thing the format exists to allow.

The replacement is a **within-pack** check: a base that no script in that same pack references is the typo. It needs no parity with default, it applies to every pack including the bundled one, and it catches something the current test cannot — a typo in `default.voice.json` itself, which nothing checks today.

## The bundled-pack completeness test lands here

Over the whole catalog, not just flags: every code-declared id has a script, no script names an id the code does not declare, and every entry carries `comment` and `test`. This is the safety net replacing "deleting a TypeScript array entry breaks a test", and it only becomes meaningful once the catalog is whole.

## Test-shape change, with a trap

The sibling `<family>.test.ts` files assert against TypeScript objects today and will assert the same things against loaded JSON. The trap is a suite that stays green because the new assertion never ran — a stale call site or a fixture that no longer reaches the code under test. **Verify the test count changed as expected, not merely that the suite is green.**

## Scope

In: the remaining families, the completeness test, the `voice-parity.test.ts` replacement, and the rules updates that drop the dual-idiom documentation.

Note that readback needs no code-built fragments once its tire table is a `case` with a declared key set — see the #1064 spec. Reach for a fragment only where a sub-sequence is genuinely shared between scenarios, not to hide complexity inside one.

Not in: the radar and pit-road-speeding engines, and the `playVoiceSequence` callers — none of them are scenarios.
