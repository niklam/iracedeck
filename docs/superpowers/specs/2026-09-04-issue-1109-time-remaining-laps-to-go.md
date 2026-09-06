> **Issue:** [#1109](https://github.com/niklam/iracedeck/issues/1109) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Session Info: Time Remaining shows laps to go when the lap count binds

## The problem

MarcoP's Discord request: the Time Remaining key should switch to laps remaining in a race that is counted in laps, Porsche Cup being the example. Today that key reads `UNLIM` for the whole race, because a lap-limited race reports `SessionTimeRemain` as the unlimited-time sentinel (604800 s) — validated in `fuel-laps-left.test.ts` and relied on by `leader-white.ts`. The key is not wrong; it is answering a question nobody asked.

There is no laps-remaining mode to point people at instead. Session Info's `laps` mode is current lap over total, which tells you where you are, not how much is left.

## What ships

The `time-remaining` mode picks its content from the session: the clock when the clock binds, **laps to go** when the lap count binds, and `UNLIM` only when neither limit exists. The title follows the content (`TIME LEFT` / `LAPS LEFT`). No new setting.

## Decisions

### 1. Auto-switch inside the existing mode, no setting

Session Info already has the precedent: Position mode shows the grid slot before the green and the live running order once the player is racing, with nothing to configure. The same shape applies here. A user who placed a Time Remaining key wants "how much is left", and `UNLIM` in a lap race is never that.

An explicit "Laps remaining" mode beside the auto behaviour was weighed and dropped as YAGNI: a driver in a dual-limit race who wants both figures is served by the existing `laps` mode next to this key, and a second mode is a second PI entry, icon and doc section for that one case. Leaving the auto behaviour out and adding only an explicit mode was rejected because it leaves the `UNLIM` key exactly as useless as it is today.

### 2. Which limit binds: the #880 comparison, extracted

A race can carry both a lap cap and a clock. The 2026-08-08 capture was a **10-lap race whose clock read 23.7 h** — a nominal value that would never bind. So "show the clock whenever it is finite" is wrong on real data, and "show laps whenever a lap cap exists" is wrong the other way for a timed race with a generous cap.

The repo already has the correct rule in `fuel-laps-left.ts` (#866/#880): remaining laps × a leader-lap estimate against the clock, whichever ends the race sooner. That comparison is **extracted into a shared helper** and both consumers use it; `fuel-laps-left` keeps its behaviour to the tick, guarded by its existing tests. Two policies for one question is how the two keys would eventually disagree.

**Before an estimate exists** — the first lap, no leader lap time yet — a finite lap cap binds over the clock. A lap cap is a hard number the sim was given; a clock alongside it is more often the nominal ceiling than the real limit, and on the captured data the alternative is showing `23:44:24` for a lap and then flipping.

### 3. What "laps to go" is

`SessionLapsRemainEx` — never `SessionLapsRemain`, which the reference marks as superseded and which is deliberately not typed. In races it is leader-relative (`SessionLapsTotal − leaderLapCompleted`, validated across the #880 captures): the "N to go" the chequered flag follows for everyone, lapped cars included, which is what a driver means by laps remaining. In qualifying it is player-relative (#776), which is also right for a lap-limited qualifying.

The unlimited sentinel (`IRSDK_UNLIMITED_LAPS`) or a missing reading means the lap side does not bind.

### 4. Display

The laps figure is the bare count with the title `LAPS LEFT`; the clock rendering is unchanged. No flashing. The website's Session Info page says the icon flashes under five minutes; no code does that (`updateDisplayFromTelemetry` starts a flash for the incidents and flags modes only), and a final-lap counterpart was proposed here. Settled 2026-09-06: neither, for now — the stale website line is corrected in this issue's PR, and a flash for either limit is a separate decision if anyone asks.

### 5. Two hygiene fixes that fall out of the helper

- `session-info.ts` carries its own copies of the two unlimited sentinels (`604800`, `32767`) instead of `IRSDK_UNLIMITED_TIME` / `IRSDK_UNLIMITED_LAPS` from `@iracedeck/iracing-sdk`, which every other consumer imports. They are replaced.
- `template-context.ts` exposes `session.laps_remaining` without excluding the sentinel, so an unlimited session renders `32767` in a custom Telemetry Display template. The same helper closes that gap; it is a two-line change next to the work, not a scope expansion.

## Alternatives rejected

**A new `laps-remaining` mode only.** See decision 1.

**Time whenever the clock is finite.** Fails the captured 10-lap race.

**Laps whenever a lap cap exists.** Ignores a binding clock in a dual-limit race.

**A sub-setting "lap-limited races: laps / keep time".** The "keep time" branch shows `UNLIM` in the only case it applies to.

## Verification

Tests for the helper: lap-limited, timed, dual-limit before and after an estimate, both unlimited. Session Info tests for the title switch. Manual: a lap race, a timed race, and the harness driving `SessionLapsRemainEx` across the last lap.
