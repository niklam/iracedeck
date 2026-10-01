# The session-start and race-start briefs wait for conditions, then speak what is known

> **Issue:** [#1284](https://github.com/niklam/iracedeck/issues/1284) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

Both briefs stop deciding once, 3 s after `session.changed`. After that first delay they keep the fire pending, re-checking every 500 ms, until every condition they read is known or 10 s have passed since the event — and then they speak once, with whatever is known. A condition that is still unknown at 10 s drops its own clause rather than the brief: the greeting and the session line play, and the pit-speed, temperature and wetness clauses each play only when their value exists. The log names every condition the brief went ahead without, and every reason a brief was rejected.

Two things in today's code combine to lose the brief. The conditions snapshot (`getSessionStartConditions()` / `getRaceStartConditions()` in `sim-events-iracing`'s translator) returns `null` as a whole when `TrackWetness` reads outside Dry..ExtremelyWet, and the contracts' `where:` runs once at +3 s and rejects on a `null` snapshot — the race-start one with an info line, the session-start one silently. In the 3.4.0 log from the issue, the qualifying brief left no trace and the race brief logged `snapshot is null` at +3 s; telemetry and session info were both present (a fuel callout played 2 s later, practice spoke the driver's name), which leaves an unknown `TrackWetness` as the likely cause. That is inferred, not measured — see **Testing**.

Rejected first: dropping the brief after a longer window (30 s was proposed). The maintainer ruled the wait should stay short — 3 to 10 s — and that an unknown value should cost its clause, not the brief: "At bare minimum we could be playing 'Ok, Niklas. It's time to race!', and then all parts after that would be conditional to the data existing."

## The snapshot reports each condition, not all-or-nothing

The two snapshots return `null` only when there is nothing to build from: no telemetry yet, or no session info. Every value that can be transiently unknown becomes nullable on its own:

| Field | Unknown when | Today |
| --- | --- | --- |
| `wetness` | `TrackWetness` is missing or outside Dry..ExtremelyWet | nulls the whole snapshot |
| `trackTemp` | `TrackTempCrew` is not a finite number | reads `0` — a false "zero degrees" |
| `airTemp` | `AirTemp` is not a finite number | reads `0` — a false "zero degrees" |

The vocabulary resolvers already return `null` for a missing value, which an `optional` clause skips; they only need to accept the nullable fields. The pit speed limit and the grid position keep their current shape: an unknown limit is `0`, which has no clip and so already skips its optional clause, and an unknown grid position is the `none` key of `raceStart.gridPosition`. Neither is a condition the brief waits for — a track with no limit in its YAML, or a race-only event without qualifying results, would otherwise delay every brief by the full 10 s for a value that is never coming.

## The scripts say when the track conditions are unknown

Today the wetness clause — `pool:session-start/wetness-intro` followed by `{{sessionStart.wetness}}` / `{{raceStart.wetness}}` — is the only required clause after the session line, so an unknown wetness aborts the whole callout under #835 even once the snapshot no longer nulls.

In both first-party voices (`default`, and the Terse pack's `shawn`), both briefs branch on a new registered condition instead (maintainer's suggestion, 2026-10-01):

```json
{
  "if": "sessionStart.wetnessKnown",
  "then": [{ "optional": ["pool:session-start/wetness-intro", "{{sessionStart.wetness}}"] }],
  "else": [{ "optional": ["pool:session-start/wetness-unknown"] }]
}
```

and the same with `raceStart.wetnessKnown` / `{{raceStart.wetness}}`. The condition is true when the snapshot exists and its `wetness` is not `null`; it is a pure read of the snapshot, as every registered condition must be. A known wetness keeps today's clause; an unknown one at the deadline says so — Default: "Track conditions are still unknown." — rather than going quiet about the track, which a driver would otherwise read as dry. Both branches are `optional`: each is a whole clause, and a voice that lacks the unknown line (a third-party pack) simply leaves it out, which is also true and shorter. The new line is `session-start/wetness-unknown-01` in each first-party voice, and the `(session-start, wetness-unknown)` source joins both families' `*_CLIP_SOURCES`. The temperature clauses need no such line: an unknown temperature drops its clause, since saying nothing about the air temperature asserts nothing.

What stays required: session-start's session line, which is what the brief exists to say; and the greetings stay optional as they are, since a name the voice lacks must not kill the brief. Race-start has no required step at all — its greeting, grid, temperature and now wetness clauses are all optional — so a race brief with no name clip and no conditions expands to nothing and plays nothing, the engine's empty-body rule.

A changed script is a changed pack archive: `default`'s published 1.1.1 is bumped and its catalog entry regenerated; `iracedeck-terse` 1.0.1 is not yet published and is regenerated at its current version.

**Both packs require plugin 3.5.0** (amended 2026-10-01, from the branch review). A plugin's script compiler refuses an entry naming a condition it does not know, and the 3.4.0 launch step auto-updates the managed `default` pack from the live catalog — so without a floor, a 3.4.0 user would install 1.1.2 and lose both briefs for good the moment 3.5.0's catalog is published. `minPluginVersion: "3.5.0"` on both catalog entries keeps the update from being offered: a 3.4.0 launch leaves the installed pack where it is. Any later change that makes a first-party script use a vocabulary name a released plugin lacks needs the same floor.

**A voice with no driver-name clips keeps the snapshot.** The plugins composed the snapshot as `null` when the active voice had no `names/` clip to pick from; they now fall back to the generic `driver` name, which the optional greeting simply skips, so `null` keeps meaning "no telemetry or session info".

## The engine gains a settle wait on the contract

`ScenarioContract` gains an optional field:

```typescript
settle?: {
  /** `null` once everything the callout reads is known; otherwise what is still missing, for the log. */
  pending: (ctx: ScenarioContext) => string | null;
  /** Upper bound on the whole wait, measured from the event. */
  maxWaitMs: number;
  /** How often `pending` is asked again. */
  pollMs: number;
};
```

When a contract carries it, the deferred path does this after `triggerDelay`: ask `pending`; while it names something missing and the event is younger than `maxWaitMs`, ask again `pollMs` later (the last poll lands at the deadline, never past it); then run `where:` once and fire as today. A fire that reaches the deadline with something still missing goes ahead, and the engine logs `Scenario "<id>" proceeding without <reason> after <n> ms` at info — the production log is where the next report will be read. A throwing `pending` is logged at error and read as ready, so a bug in the check cannot silence the callout. `where:` is not polled: it runs once, so its own logging stays one line per decision.

The wait reuses the existing `pendingTriggerTimer`, so everything that cancels a deferred fire today cancels a settling one: a newer event of the same trigger (the session changing again — the newest event wins), disabling the scenario, and redefining it. A contract with `settle` and no `triggerDelay` enters the same path with a zero first delay.

The field is engine-level rather than a new bus event because the bus catalog is a published contract, and moving the briefs onto a "conditions ready" event would also move the #871 check — whether the driver was already on track at connect — away from the moment of connect that its envelope telemetry describes. `contracts()` does not report `settle`, as it does not report `queueBehind`: it is scheduling, which packs never see.

Both briefs set `settle` with `maxWaitMs: 10_000` and `pollMs: 500`, keep `triggerDelay: 3000`, and derive `pending` from their own snapshot: `null` snapshot → "telemetry or session info", otherwise the list of null fields from the table above.

A brief that its `where:` will refuse must not wait (amended from the review — the wait runs before `where:`, so it would otherwise wait out the window and log `proceeding without …` for a fire that never proceeds). So `pending` answers ready at once for a session that is not the brief's own — race-start outside a race, session-start in one — and the master and per-callout opt-in wrappers answer a closed gate's `pending` as ready too.

**Both briefs become `queueable`** (amended from the review). They now fire anywhere from 3 to 10 s after the event, where other callouts are as likely to hold the Voice bus; a non-queueable NORMAL-weight fire meeting an equal-weight line is dropped with a debug line only, which would lose the brief silently again. A brief a few seconds late is still correct — but not a brief for a session that has since ended, so both carry the same pure `speakGate` (amended from the PR review, per #1211's rule for a queueable one-shot): the session number on the event's own telemetry must still be the live one. It compares against the envelope rather than the payload's `to`, because the scenario harness publishes `to: 1` against a mock that stays at session 0; missing data admits.

## Logging

- Engine: the `proceeding without …` line above, at info, once per fire that hit the deadline; a settle that resolved early logs its wait at debug.
- Session-start `where:` gains a logger and logs each rejection at info as race-start's already does: snapshot `null`, race session (race-start's), fresh connect while on track.
- Race-start's `null`-snapshot line is reworded, since wetness no longer nulls it.

## Gates kept

The #871 fresh-connect suppressions are kept and read from the event's envelope telemetry, which is still the connect tick. Race-start's also asks the LIVE `SessionState` when it decides (amended from the review): a connect during the parade laps can see the green fly inside the 10 s wait, and a grid brief must not play after it. Unchanged: the #604 replay gate (at emission, in the translator), session-start's rejection of race sessions so the two never double-greet, and the master and per-callout opt-ins. The settle wait runs before `where:`, so a callout switched off mid-wait is still refused by its wrapper when the wait ends.

## Out of scope

- **A green-flag bound on race-start's genuine transitions.** The issue proposed one for a long pending window. At a 10 s cap it cannot bind on a session transition: a race session opens in `GetInCar`, and the green is minutes after it in every format. A fresh connect can land close to the green, which is why the #871 gate reads the live state too (above).
- **Waiting for the pit speed limit or the grid position** — see the snapshot section.
- **Other `triggerDelay` contracts** (caution, pit limiter) keep their single evaluation; `settle` is opt-in.
- **Measuring how long `TrackWetness` stays unknown.** The fix does not wait on it; the capture below sets the constant.

## Testing

Automated:

- Interpreter: a contract with `settle` fires once when `pending` turns `null` between polls, with `where:` run exactly once; one whose `pending` never clears fires at `maxWaitMs` and logs the reason; a newer event, a disable and a redefinition each cancel a wait in progress; a throwing `pending` fires; no poll lands past the deadline. Fake timers throughout.
- Translator: each of `TrackWetness`, `TrackTempCrew` and `AirTemp` missing or out of range yields a snapshot with that field `null` rather than a `null` snapshot; no telemetry or no session info still yields `null`.
- Contracts: a transition whose wetness reads Unknown for 5 s speaks once, with the wetness clause, after it settles; one whose wetness never settles speaks at 10 s with the unknown-conditions line and logs it; a `null` snapshot at the deadline is rejected and logged by `where:` — for both briefs. Session-start's rejections log.
- Contracts: `sessionStart.wetnessKnown` / `raceStart.wetnessKnown` follow the snapshot, and a brief whose wetness never settles plays the unknown line in place of the wetness clause.
- `bundled-scripts.test.ts` and `script-coverage.test.ts` over the edited scripts and the new clips; `pnpm generate:pack-reference` freshness after the description edits.

Manual: a weekend with separate practice, qualifying and race sessions, connected from practice onward — each transition speaks its brief once, and the log shows either no `proceeding without` line or one naming what was missing. The scenario harness's session-start and race-start buttons still fire immediately (its snapshots carry every value).

Capture that sets `maxWaitMs`: `pnpm telemetry-watch` recording `TrackWetness`, `TrackTempCrew`, `AirTemp`, `SessionNum` and `SessionState` at full rate across a practice → qualifying → race weekend. If any transition shows a value unknown for longer than 10 s, the constant moves — with the capture cited beside it.
