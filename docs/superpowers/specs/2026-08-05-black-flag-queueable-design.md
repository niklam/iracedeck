# Black flag queueable delivery — design (issue #923)

Date: 2026-08-05
Issue: [#923](https://github.com/niklam/iracedeck/issues/923) — Race Engineer: black flag can go unannounced when it lands during another callout

## Problem

A directly-issued black flag (pit-lane speeding penalty, race-admin `!black`, escalation after an ignored meatball) can go completely unannounced. `BLACK` in `packages/audio-scenarios/src/catalog/pit-crew/flag-alerts.ts` runs at `WEIGHT.SAFETY` with the default `queueable: false`, so a fire arriving while the Voice bus is busy with an equal-or-higher-weight line (another flag, pit-approach/exit/stall-departure, the spotter info line, a CRITICAL line, or a spotter proximity call) goes through the interpreter's `queueOrDrop` and is dropped with only a debug log. The raise is a one-shot edge (`diffFlags` plain rising edge) that never re-fires, so the driver is never told they have a penalty.

`DISQUALIFY` and `DQ_SCORING_INVALID` are identical one-shot penalty edges at `WEIGHT.SAFETY` with the same loss paths — and a DQ is even more must-hear.

## Decisions

Both decided with the user (2026-08-05):

1. **All three scenarios become `queueable: true`** — `BLACK`, `DISQUALIFY`, `DQ_SCORING_INVALID`. Same class as #671 (yellow-cleared) and #867 (meatball, start-gantry): the penalty is a sustained state, so a replay a few seconds late is always still correct. Making `DISQUALIFY` queueable also structurally covers the black→DQ escalation case: a DQ fire arriving while the black line sits in the pending slot replaces it (equal weight, ties → newest in `setPending`), so the driver hears "Disqualified. Pull off." instead of a stale black-flag line.
2. **No speak-time `if:` gate** (the FURLED #669 pattern is NOT applied). Queue latency is bounded by one in-flight clip (seconds). A black flag cannot be *served* in that window (serving requires a pit visit, ≥ 30 s), and the escalation path is covered structurally by decision 1. The only case a gate would cover is a race-admin `!black` followed by an immediate `!clear` within one clip's duration — very rare, low harm. This mirrors the #867 meatball precedent (queueable, no gate, "instruction stays valid until obeyed"); the FURLED gates exist because that warning is genuinely withdrawable in normal play.

## Change

### Production code — one file

`packages/audio-scenarios/src/catalog/pit-crew/flag-alerts.ts`:

- Add `queueable: true` to `BLACK`, `DISQUALIFY`, and `DQ_SCORING_INVALID`, each with a house-style comment: one-shot edge that never re-fires; sustained penalty state so a seconds-late replay is always correct; no speak-time gate (serving takes ≥ 30 s, escalation handled by the pending-slot tie replacement).
- Extend the file-header delivery notes to cover the penalty-flag trio.

No interpreter change. No event-bus, translator, plugin, manifest, PI, schema, clip, or scenario-harness change — the pools and events already exist.

### Tests

`packages/audio-scenarios/src/catalog/pit-crew/flag-alerts.test.ts`:

- Update the queueable-roster test (~line 310, "…and they're the only flags that are") to include `pit-crew.flag-black`, `pit-crew.flag-disqualify`, `pit-crew.flag-dq-scoring-invalid`.
- Add a behavioral test mirroring the yellow-cleared one (~line 713): `flag.black.raised` deferred behind an equal-weight non-flag line replays when the bus idles.
- Add an escalation test: black pending behind a busy bus → `flag.disqualify.raised` fires → the DQ fire replaces the pending black and only the DQ line plays.

`register-pit-crew.test.ts` needs no change — its fire matrix asserts event→clip only.

### Documentation (same PR)

- `packages/audio-scenarios/CLAUDE.md` — update the queueable one-shot roster in the spotter-engine section (currently names the #867 meatball/gantry set) and the flag-family summary line.
- `packages/website/src/content/docs/changelog.mdx` — create the `## 2.4.0` / `_Unreleased_` section (does not exist yet; 2.3.0 shipped 2026-08-04) with one **Bug Fixes** line.
- `.claude/rules/race-engineer-callout-examples.md` — add a #923 entry: pattern = penalty one-shots made queueable; lesson = for sustained penalty states, structural coverage via the pending-slot tie replacement beats a speak-time gate.

## Known residual limitation (documented, not fixed)

The engine keeps a single pending slot per bus, so a queued black-flag line can still be displaced by a *different* equal-weight queueable fire (e.g. yellow-cleared) arriving while it waits — inherent to the #652 scheduler design, same acceptance as #867.

## Verification

- `pnpm install && pnpm build && pnpm test && pnpm lint:fix && pnpm format:fix` in the `ir-923` worktree.
- Manual repro via the scenario harness: fire a SAFETY/CRITICAL line (spotter call or meatball), then `flag.black.raised` while it plays. Expected: the black-flag line plays when the bus idles (previously: debug log `Scenario "pit-crew.flag-black" dropped (bus busy)`). Repeat for disqualify and dq-scoring-invalid.
