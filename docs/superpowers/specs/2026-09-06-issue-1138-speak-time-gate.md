> **Issue:** [#1138](https://github.com/niklam/iracedeck/issues/1138) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# A contract-level speak-time gate

## Pacing leaked into the script through the side door

The #1064 split put *whether and when* in the code-owned contract and *what* in the pack-owned script, and withheld pacing from packs deliberately: a pack that lets the engineer nag reads as a plugin bug. But a `where:` runs at event arrival, and several families need a second look at speak time — is the car still too far left when the repeat nag reaches the front of the queue; is the limiter still off; is the readback's limiter reminder still due. Those re-checks lived inside code sequences as `if` steps, and #1065 migrated them faithfully into the script as `{ "if": "pitStatus.stillTooFarLeft", … }` over registered conditions. Correct for wording; wrong for ownership. The promise "never nags more than he should" now holds only for a voice pack that keeps those `if`s, and a pack author has no way to know which `if`s are load-bearing.

## The gate

`ScenarioContract` gains an optional speak-time gate, evaluated by the engine after the script has expanded and immediately before the ops are accepted for the bus:

```ts
{
  id: "pit-crew.pit-status-repeat-too-far-left",
  when: { event: "pitStatus.changed", where: … },     // event time, unchanged
  speakGate: {                                        // speak time, code-owned
    description: "The car is still too far left when the nag reaches the speaker.",
    admit: (ctx) => stillTooFarLeft(ctx),
  },
  …
}
```

`admit` returning `false` drops the fire the way a required-step abort does — at debug, no cooldown stamp, no bus take, and never cancelling an in-flight callout, since it runs ahead of the preemption cut — for every voice, whatever its script says. The same context the vocabulary resolvers receive (`event`, `data`, `telemetry`, `now`, and the resolved `vars`) is handed to it. It runs once per fire that plays: a deferred fire meets it again at idle-replay, exactly as expansion re-runs there, and a *resumed* fire (#758) skips it, since a resume continues a fire that already passed. The `description` is required, like a condition's, because the reference renders it (below). Settled at implementation: the field is an object rather than a bare predicate so the sentence travels with the check, and it is named `speakGate` rather than `speakWhen` because it is allowed to commit — see the next section — and a name shaped like `when` reads as pure.

Which script `if`s move back is decided by one question per branch: does it choose *words*, or does it decide *whether to speak at all*? An `if` that wraps the whole body and re-checks live state decides whether; it becomes a gate. Session-type and flag-state branches choose words; they stay in the script. The inventory at implementation found four families on the "whether" side: the five pit-status repeat re-checks, both limiter re-checks, and — added to the issue's list — the furled black-flag pair (`flag.furledStillShown` / `flag.furledWithdrawn`), which is the same ownership bug with a claim on top: a pack that drops the raised line's `if` announces a stale flag and never gets the cleared line, because it is the condition that marks the raise as spoken. The readback's limiter reminder, which the issue named, is **withdrawn from the list**: it gates one clause (the "limiter" pre-opener) while the recap still speaks, which a contract gate cannot express — `false` drops the whole fire — and the ownership argument does not apply to it, since a pack that drops that `if` nags less, not more. It stays a script `if`.

A moved condition stays registered, so a pack that wants to fall silent earlier than the gate can still write the `if` — belt and braces is allowed, absence is no longer harmful. For that to hold, a registered condition must be **pure**: the furled conditions therefore become plain reads of the flag bit and the marker, and the marking moves into the gate, otherwise a belt-and-braces `if` would consume the marker during expansion and the gate would then refuse the cleared line.

## The cooldown claims go through the same door

#1137 records that some `where:` predicates commit a cooldown claim assuming the callout will play, and that since #1065 an expansion can abort after the claim. The gate is where a claim belongs: it runs after expansion succeeded and before the bus take, so a claim made there is made for a callout that will play. The two land together in one branch (decided 2026-09-08), and `admit` is the one place a claim may be committed — the `tryClaim…` shape (`if (!can) return false; last = now; return true;`) moves into it verbatim, while the `where:` keeps the pure half of the check so a fire outside the cadence is still dropped cheaply at event time.

The inventory found nine mutating `where:` closures and splits them by what the write is. Four are **claims**, which move: the shared position cooldown (`tryClaimPositionAnnouncement`, four contracts), the shared gap cooldown (`tryClaimGapCallout`, two contracts), the qualifying-invalidation per-lap latch (`checkAndUpdateQualifyingLatch`, whose check stays in `where:` and whose update moves), and the furled spoken-marker (set by the raised gate, consumed by the cleared gate). Four are **stashes** a var resolver reads during expansion — the incident point count, the two opponent number stashes, and the furled reset on a fresh raised episode — and they stay in `where:`: nothing downstream is silenced by a stash an abort left behind, and the resolver that reads them runs inside the expansion the gate follows. The rule that comes out of it, written into the callouts rule: **`where:` may stash what a resolver will read; it never claims.** A queued replay never re-runs `where:` (unchanged), which is now the reason a claim there was always the wrong shape rather than a reason to keep it there.

## What the reference shows

`contracts()` reports the gate's description (`speakGate: string | null`), and the callouts page renders "Re-checked at speak time: …" beside the trigger, so a pack author reading a silent callout knows the second gate exists and what it asks. This is a `ContractReport` and artifact change of the additive kind #1066 made twice; the website mirrors the field, and the bundled-scripts test holds every gate description to the same sentence rules as a contract's `description`.

## Not in scope

Letting a pack define gates (that is pacing, withheld by #1064); changing any `where:`; the bundled voice's wording. If a moved `if` was the only branch in an entry, the entry's `sequence` shrinks to the clip alone and the bundled `callouts.json` is regenerated — the diff is the proof that only the gate moved.
