> **Issue:** [#1136](https://github.com/niklam/iracedeck/issues/1136) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Resume compares pool-drawn ops by their pool, not by the take drawn

## The freshness check is stricter than the freshness it guards

A `resumable` fire cut by an `interrupt` continues from the interrupted clip at idle-replay (#758). Before it does, the engine re-expands the body and compares the fresh expansion with the stashed one (`opsEqual`); a difference means the state the body speaks about moved on while it was stashed, and the whole body replays from the top rather than speaking a stale tail (the #481 freshness guarantee). `opsEqual` compares play ops by clip path.

Since #1064/#1065 every readback slot is a pool (`pool:pit-readback/<base>`), and a pool with more than one take draws a take per expansion. The draw is not merely random: `noRepeat` defaults to `true` for a pool step, and the take the driver heard is committed to the pool's `lastIndex` when the fire is accepted (#1138). So a re-expansion of a two-take pool draws the *other* take every time, `opsEqual` sees a different path, and the resume degrades into a full replay deterministically — the engineer starts the readback over instead of finishing it. The bundled voice records one take per readback line, which is the only reason it does not show today; a pack that adds a second take to any readback line loses the resume for that line.

The path comparison is asking a question the freshness check does not need answered. What has to be unchanged for the tail to be safe is *what the body says* — which slots it fills, in what order, with which values. Which recording of a slot was drawn is not part of that.

## The comparison

Every play op that came out of a pool carries the key of the pool it was drawn from: the registered name for a named pool, the `pool:<group>/<base>` reference for a slashed pool step or a var resolver's reference, the connector pool's name for a connector step. `opsEqual` compares two pool-drawn play ops by that key and their channel; two path-drawn ops by path and channel, as today; a pool-drawn op and a path-drawn one are different ops. The frame tag stays part of an op's identity as #1064 made it.

What that keeps of the freshness guarantee: a var that resolves to a different value produces a different reference (`pool:numbers/12` against `pool:numbers/13`), a slot that appears or disappears changes the shape, a branch that flips changes the ops — every one of those still falls back to the full replay. What it stops doing: treating a second take of the same line as a change of state.

What the driver hears on a resume: the delivered part is not replayed (as before), the re-key with the frame's open is unchanged, the clip that was cut restarts from its start with whichever take the fresh expansion drew, and the tail plays the fresh expansion's takes. None of the tail had been heard, so the take drawn for it is immaterial; the restarted clip was heard in part, and a different take of it reads as the engineer repeating himself, which is what a restart is.

## Rejected: re-using the stashed takes

The other shape the issue named: the resume state carries the original expansion's pool picks and the re-expansion is made to honour them for unchanged pool references. It gives the same audible result for the tail, and it costs a second channel from the stash into expansion — the picks map threaded through `prepareOps` and `pickFromPool`, and a bypass of the no-repeat tracker for exactly those picks, whose committed `lastIndex` would then have to be reconciled against picks it was told to skip. The comparison-by-pool needs one optional field on `ExecOp` and one branch in `opsEqual`, and leaves expansion knowing nothing about resumes. Same outcome, less machinery, one seam fewer.

## What changes

- `ExecOp` play ops gain an optional `pool` key, set by `expandSequence` wherever a pick came from `pickFromPool` / `pickFromPoolRef`; `opLabel` prints it so a debug line shows the pool a take came from.
- `opsEqual` compares pool-drawn play ops by key and channel.
- `interpreter.test.ts`: a resumable sequence with a two-take pool, interrupted, resumes from the interrupted step; and a resolver value change across the stash still replays whole.
- `packages/audio-scenarios/CLAUDE.md`: the #758 resume paragraph and the `resumable` field's entry say what the comparison is by.
- Changelog: nothing, while every released voice pack records one take per readback line.
