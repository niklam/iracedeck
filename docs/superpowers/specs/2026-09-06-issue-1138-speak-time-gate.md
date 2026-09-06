> **Issue:** [#1138](https://github.com/niklam/iracedeck/issues/1138) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# A contract-level speak-time gate

## Pacing leaked into the script through the side door

The #1064 split put *whether and when* in the code-owned contract and *what* in the pack-owned script, and withheld pacing from packs deliberately: a pack that lets the engineer nag reads as a plugin bug. But a `where:` runs at event arrival, and several families need a second look at speak time — is the car still too far left when the repeat nag reaches the front of the queue; is the limiter still off; is the readback's limiter reminder still due. Those re-checks lived inside code sequences as `if` steps, and #1065 migrated them faithfully into the script as `{ "if": "pitStatus.stillTooFarLeft", … }` over registered conditions. Correct for wording; wrong for ownership. The promise "never nags more than he should" now holds only for a voice pack that keeps those `if`s, and a pack author has no way to know which `if`s are load-bearing.

## The gate

`ScenarioContract` gains an optional speak-time predicate, evaluated by the engine after the script has expanded and immediately before the ops are accepted for the bus:

```ts
{
  id: "pit-crew.pit-status-repeat-too-far-left",
  when: { event: "pitStatus.changed", where: … },     // event time, unchanged
  speakWhen: (ctx) => stillTooFarLeft(ctx),           // speak time, code-owned
  …
}
```

`false` drops the fire the way a required-step abort does — at debug, no cooldown claim, no bus take — for every voice, whatever its script says. The same context the vocabulary resolvers receive (`event`, `data`, `telemetry`, `now`) is handed to it. Name to be settled at implementation; `speakWhen` is used here for want of a better one.

Which script `if`s move back is decided by one question per branch: does it choose *words*, or does it decide *whether to speak at all*? The pit-status repeat re-checks, both limiter re-checks and the readback limiter reminder decide whether; they become gates. Session-type and flag-state branches choose words; they stay in the script. A moved condition stays registered, so a pack that wants to fall silent earlier than the gate can still write the `if` — belt and braces is allowed, absence is no longer harmful.

## The cooldown claims go through the same door

#1137 records that some `where:` predicates commit a cooldown claim assuming the callout will play, and that since #1065 an expansion can abort after the claim. The gate is where a claim belongs: it runs after expansion succeeded and before the bus take, so a claim made there is made for a callout that will play. Land #1137 on top of this, or land the hook first as part of it — either order works; doing #1137 without a speak-time hook means inventing one.

## What the reference shows

`contracts()` reports whether a contract carries a gate (a boolean and, if the implementation can carry it cheaply, a one-line description), and the callouts page renders "re-checked at speak time" beside the trigger, so a pack author reading a silent callout knows the second gate exists. This is a `ContractReport` and artifact change of the additive kind #1066 made twice; the website mirrors the field.

## Not in scope

Letting a pack define gates (that is pacing, withheld by #1064); changing any `where:`; the bundled voice's wording. If a moved `if` was the only branch in an entry, the entry's `sequence` shrinks to the clip alone and the bundled `callouts.json` is regenerated — the diff is the proof that only the gate moved.
