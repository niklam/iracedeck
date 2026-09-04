> **Issue:** [#1110](https://github.com/niklam/iracedeck/issues/1110) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Race Engineer: running incident total, penalty-ladder warnings, and team incident counts

## The problem, and the part of it that already shipped

owwidius asked on Discord for the Race Engineer to call out incident points, "after each increase", and for a warning as the count nears a drive-through or a disqualification. Peter added that in team endurance events the limit is the team's, every driver contributes, and a per-stint summary would help.

The first half is already in the product. #530 built six per-incident-type callouts, and #922 and #938 made the spoken figure the exact scored delta. What is missing is narrower than the request reads: nobody hears the **running total**, nothing reads the session's **penalty ladder**, and the two team counters (`PlayerCarTeamIncidentCount`, `PlayerCarDriverIncidentCount`) have no consumer anywhere. This spec covers those three things and nothing about the per-incident detection.

## The ladder, as ruled

The session YAML carries the whole penalty structure in `WeekendInfo.WeekendOptions`: `IncidentLimit`, `IncidentWarningInitialLimit`, `IncidentWarningSubsequentLimit`, each a number or the literal `unlimited`. The maintainer's ruling on what they mean: a **drive-through at the initial limit, another every subsequent-limit points after it, disqualification at the limit**. The hosted-session "Penalty at x incidents, then every y" control maps onto this directly.

One verification task is carried, not a design branch: how "No Incident Penalty" and "Penalty every x" serialise (absent, `0`, `unlimited`, equal values), and what official sessions carry. #887 raised the same question for the Session Info flash and the answer serves both. A ladder that reads `unlimited` throughout arms nothing.

## What ships

1. **Running total** — an optional clause after the existing per-incident line: _"Contact, two points. That's twelve now."_
2. **Ladder warning** — an optional clause when the total is within a user-set margin of the next step: _"Four points from a drive-through."_ / _"Two points from a disqualification."_
3. **Team sessions** — the count is the team's, with _"for the team"_ wording; a driver hears the team's standing once when they get in the car; and a summary repeats every N laps.

Each behind its own opt-in, all default on, all under the Race Engineer master.

## Decisions

### 1. Clauses on the existing callouts, not new callouts

The moment the total matters is the moment an incident lands, and the incident line is already speaking then. Appending is the #835 optional-clause shape the incident family already uses for its points clause: self-contained sentences that skip locally when their clip or value is missing, never a fragment mid-sentence. A separate "total" callout would race the incident line for the bus and, with the family rule, replace it.

Each clause reads its own opt-in — `calloutEnabledIncidentTotal`, `calloutEnabledIncidentLadderWarning` — inside its `if:` predicate, live on every fire, so a toggle takes effect on the next incident without re-registration.

### 2. A typed ladder accessor, shared with the Session Info issues

`iracing-sdk` gains a parser for the three fields (number or `unlimited` → `undefined`) and a pure `nextPenaltyStep(total, ladder)` returning the next step above the total and what it is (`drive-through` | `disqualification`), or nothing when no step is ahead. #887 (flash at the threshold) and #1027 (`4x/17` on the key) want the same numbers; one parser, three consumers.

### 3. The margin is a setting, default 4

`incidentWarningMarginPoints`, a plain number in the settings window's Race Engineer card, default **4** — one car contact, the largest single step the sporting code scores, so the warning arrives while one incident can still be avoided. A fixed margin was the cheaper option and was set aside by the maintainer in favour of a user-set one: drivers weigh the risk differently between a sprint and an enduro. Schema shape: `z.coerce.number().min(0).max(50).default(4).catch(4)` — a plain-value field, so it carries `.catch` per `global-settings.md`.

The warning fires at an incident when `step − total ≤ margin`, and re-fires at each further incident inside the margin, because each one moves the number. The step itself needs no line from us: the sim shows its own penalty at that moment.

### 4. Team sessions: the team count, and two summaries

When `WeekendInfo.TeamRacing` is set, the total and the ladder distance read `PlayerCarTeamIncidentCount` — the number that ends the team's race — and the clause says _"for the team"_. The player's own count is still what the per-incident line speaks as the delta; only the total changes source.

**Stint start.** When the player gets in the car in a team session, the team standing is spoken once: total plus ladder distance. It is the hand-over summary Peter's "per stint" asks for, at the one moment a driver cannot have heard the earlier incidents. Only when the team total is above zero — a first stint with nothing to report stays quiet.

**Periodic summary.** `calloutEnabledIncidentTeamSummary` (default on) every `incidentTeamSummaryLaps` laps (default 10, a setting), team sessions only, on `lap.completed`, the `race-status.ts` modulo shape with its own counter rather than that module's position-change counter. The maintainer kept this alongside the stint-start line; a driver two hours into a stint has no other reminder.

### 5. Numbers

Totals resolve through the existing cardinal clips (0–150) by the #836 value-pool rule; a total beyond the clip range skips its clause rather than mis-speaking. The `position-number` clips (1–64) are not used: enduro team totals exceed 64.

### 6. Events

`incident.occurred` gains `total`, `teamTotal` and `ladder: { nextStep, kind, distance } | undefined` so the scenario formats rather than computes. Two new events carry the summaries: `incident.stintStanding` and `incident.teamSummary`, both `{ total, ladder }`, with harness entries.

## Alternatives rejected

**A fixed 4-point margin.** Cheaper; overruled for a setting.

**Warning only at the exact step.** The sim already announces the step; the value here is the run-up.

**Speaking the driver's own count in team sessions.** It is not the number that ends the race.

**Reusing `lapsSincePositionChange` for the cadence.** It is anchored to position changes and would drift the summary interval.

## Verification

Parser tests over the four serialisations named above. Scenario tests for the clauses with and without a ladder, inside and outside the margin, team and solo. Harness shortcuts for the two summaries. Manual: a hosted session with a small ladder to walk through drive-through and DQ distances.
