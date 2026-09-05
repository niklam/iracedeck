> **Issue:** [#1066](https://github.com/niklam/iracedeck/issues/1066) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Documenting the voice-pack format

The format is decided in the [#1064 spec](2026-08-30-issue-1064-callout-scripts-in-voice-packs.md). This records how it gets published, and why the split between generated and hand-written falls where it does.

## The pack format is only an extension point if someone outside this repo can learn it

Everything a pack author needs is currently in TypeScript source or in nobody's head: which callouts exist, when each fires, which pools, variables, conditions and case keys a script may reference, and what any of them mean. A pack format nobody can read is a pack format nobody uses.

## Most of it must be generated

A hand-maintained reference across ~100 callouts, ~50 pools and the full vocabulary would be stale within one release. This repo already solves exactly this twice — `changelog.json` and `action-comms.json` — both generated, both guarded by a freshness test that names the command to run. Hand-writing this one would be choosing the single approach we already know rots.

`pnpm generate:pack-reference` emits, from the code contracts plus the bundled pack:

- **Every callout** — id, what triggers it in prose, whether it is framed by default, and the bundled pack's own `comment` and `test`.
- **Every pool** — name, `group/base` source, and its `comment`.
- **Every variable** — name, what it resolves to, and which callouts use it.
- **Every condition** — name and meaning.
- **Every case variable** — name, and **its declared key set with a description per key**.

That last one is why `defineCase` declares its keys rather than inferring them. A `case` step is unwritable by anyone who has not read the resolver unless the branches are published; sixteen tire-pattern keys are not guessable. This is also why `comment` and `test` are required in the bundled pack and enforced by its completeness check — they are the reference's source text, not decoration.

## What cannot be generated

The tutorial, and the concept page explaining what a pack can and cannot change. Their value is judgement — what to record first, why a pack sounds bad, what to test — and none of it is derivable from the catalog.

## Skip-by-default is what makes the tutorial finishable

A three-callout pack is a valid pack that plays three callouts. So "your first voice pack" can end with the reader hearing their own voice in the sim after an evening, rather than demanding 104 recordings before anything plays at all. Of every decision in #1064, this is the one adoption rests on, and the tutorial should be built around it rather than treating a partial pack as a caveat.

## The author auditions in the scenario harness — no in-plugin tooling

The scenario harness (`packages/scenario-harness`) is how this repo hears a callout without iRacing, and it is the pack author's audition path too: with `IRACEDECK_VOICE_PACKS_PATH` pointing at the packs folder it lists sideloaded voices beside the bundled one, and every callout has a shortcut button whose label the bundled script's `test` field already names. **Pack authors are assumed to have cloned the repo** (decided 2026-09-05). The first draft argued the opposite and derived a per-callout Play button in the settings window from it — first placed in [#1034](https://github.com/niklam/iracedeck/issues/1034), then here on 2026-09-04. Niklas dropped it on 2026-09-05: a 149-row audition list is a view every user would carry for the benefit of the few who write packs, and if an author without the repo ever turns up, tooling for them is its own issue. The tutorial therefore ends in the harness, not in the settings window.

**Document the harness's limit honestly rather than hiding it.** Firing a snapshot-driven callout with no matching state does nothing: `lap-time-best` with no completed lap resolves its snapshot to `null`, the variable resolves to nothing, and expansion aborts. That is exactly what the per-callout `test` field is for, and the tutorial should teach reading that field as the first move when a callout stays silent.

## Say the confusing thing early

The single most confusing experience available to a pack author is a script that is perfect and silent, because the `where:` predicate in code never matched the sim state. It is not a bug and it is not discoverable. It belongs on the concept page, near the top, not in a troubleshooting appendix.

## `lint:pack`

With skip-by-default, quiet failure is the design — so a lint pass is the only place an author is ever told anything loudly. It reports unknown pools, variables, conditions, case keys, includes and frames; bases the pack ships that no script references; scripts naming callout ids that do not exist; and a coverage summary.

It lands here (decided 2026-09-04) as a repo script: it shares its introspection — the contract enumeration, the vocabulary report, the coverage rules — with the reference generator, and a linter that could not name the same things the reference publishes would be a second source of truth. Under the assumption above every pack author can run it.

## Scope

In: the generator and its freshness test, the generated reference pages, the concept page, the tutorial (auditioning in the harness), and `lint:pack`. The reference needs prose no contract carries today — when a callout fires — so `ScenarioContract` gains a `description` and the engine gains a contract enumeration beside `vocabulary()`; the spec's pool section becomes a recording script (every clip group and base of the bundled voice with its line text), since named pools are an alias facility and the bundled script names none (#1064, amended 2026-09-05).

Not in: any change to the script grammar itself (#1064); any in-plugin audition or diagnostics tooling for pack authors (the per-callout Play button and compile diagnostics in the settings window — dropped 2026-09-05, revisit only if an author without the repo appears); and per-var scoping of the vocabulary to the callouts that may name it (a follow-up the #1065 review argued for).
