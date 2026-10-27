# A new subsession is a session change

> **Issue:** [#1509](https://github.com/niklam/iracedeck/issues/1509) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

`session.changed` is published from two places in `handleTick`: the fresh-connect synthesis, latched once per SDK connection, and a change of the telemetry `SessionNum`. An official race breaks that model. Registration opens a practice session about 30 minutes before the race, and at race time iRacing moves the driver into the race event, whose first session is again a practice. Both are `SessionNum 0` (and `SessionUniqueID 1`) on one live SDK connection; only `WeekendInfo.SubSessionID` changes. So no `session.changed` is published, the session-start brief does not play, `resetPerSessionState` does not run (laps, overtake baselines, fuel and the rest carry over from the registration practice). (The Stream Deck profile switch is not affected: `session-profile-reactor.ts` polls the session kind and never reads `session.changed`, and practice to practice is the same kind anyway.) The 2026-10-26 log in the issue shows it: the replay store opens `session_89660575.json` at 18:47:04 and the translator says nothing.

## Decision

The translator's notion of "which session we are in" becomes the pair `(SubSessionID, SessionNum)`.

- The instance keeps `lastObservedSubSessionId: number | null` beside `lastObservedSessionNum`, under the same rules: it advances only on a tick that is not a saved replay (#604's `isReplayOnlySession`), and `handleDisconnect` clears it, so a reconnect seeds rather than compares.
- It is read from the session YAML, and **only a readable value counts**. A tick with no session info, no `WeekendInfo` or no numeric `SubSessionID` neither seeds nor compares, so a transition that reads `N`, then nothing, then `M` publishes once. `resolveSubSessionId` folds "absent" into `0` (right for the replay recorders, which treat 0 as offline), so it becomes a wrapper over a nullable `readSubSessionId` beside it in `replay-record-gate.ts`, which the translator reads: one rule for the field, two answers for absence.
- A tick on which either half differs from its baseline runs the existing block once: `resetPerSessionState`, the info line, and `session.changed`. One block, so a tick on which both change publishes once.
- `0` is a real value. An offline session (test drive, AI race) reads `SubSessionID 0`, so offline → hosted on one connection is a session change too.

### The payload stays `{ from, to }`, both SessionNums

When only the subsession changed, the event carries `from === to` (here `{ from: 0, to: 0 }`). No consumer reads the pair for anything but the fresh-connect marker `from === -1`, and the speak gates of the two briefs compare the event tick's `SessionNum` with the live one, which a subsession change does not disturb. The event catalog's doc comment says what `from === to` means.

Rejected:

- **Publishing `from: -1`**, the fresh-connect marker. The #871 gate refuses a `-1` session brief when the driver is already on track, and at this transition iRacing has already put the driver in the car (`inCar=true` in the log), so the fix would be swallowed by the gate.
- **Adding `subSessionId` / `fromSubSessionId` to the payload.** Nothing needs it today, and a field on a published event is permanent. It can be added when a consumer needs it.

### Accepted: the YAML can lag the telemetry

If one transition changes `SessionNum` (telemetry) on one tick and `SubSessionID` (YAML) a few ticks later, two `session.changed` events are published. Both briefs wait `triggerDelay` (3 s) and a newer event for the same contract replaces a pending one, so a lag under 3 s still produces one brief; the second `resetPerSessionState` is harmless at the start of a session. No capture shows such a transition, since moving between events normally restarts the sim (the race-registration case is the exception that keeps the connection). This is left alone until one does.

### Accepted: a single reading is trusted

A changed `SubSessionID` is acted on the first tick it is read, with no agreement over several ticks. If iRacing ever reported a different id mid-session and then the original again, the translator would publish two changes, reset per-session state twice, and — because race-start rejects only a `from === -1` event once the race is underway — replay the race-start brief mid-race. No capture shows such a flicker, and none of the plugin logs on hand (2026-10-19 to 2026-10-27) shows the replay store, which opens its per-event file on this same field, opening a stray one; that is a short record, not proof. An agreement window would not help much either: the parsed YAML is held until iRacing's next session-info update, so a flicker would last whole seconds, not a tick. This is left alone unless a log shows one.

## Out of scope

- The fresh-connect synthesis and its gates (#568, #668, #871) are unchanged.
- The replay recorders keep their own `SubSessionID` reading; they already handle the boundary.
- No new callout, setting or clip.
- `SessionUniqueID` stays out of the identity. The replay recorders key a session on it too, and a restarted offline event repeats a `SessionNum` under a new one, so a restart while still in that session number publishes no `session.changed`. That is a separate case, not the one in this issue, and how `SessionUniqueID` behaves through an offline restart has not been captured.
- The start briefs' speak gate (`startBriefSessionStillCurrent`) still compares `SessionNum` only. A brief waiting from the previous event is cleared by the queue clear on the new `session.changed`, and a pending `triggerDelay` / `settle` timer is replaced by the newer event, so no path reaches the gate with a stale brief today.

## Testing

- `translator.test.ts`: a live connection that stays at `SessionNum 0` while `SubSessionID` goes `89659949 → 89660575` publishes one `session.changed { from: 0, to: 0 }` and resets per-session state; the same change while `SimMode` is `replay` publishes nothing and does not advance the baseline; a tick with no session info between the two readings publishes once; a tick where `SessionNum` and `SubSessionID` change together publishes once; a reconnect into a different subsession seeds rather than compares, and the next event after it is still detected; the change is caught on a replay-mode loading tick of a live session too.
- Manual: register for an official race, join the registration practice, and stay in the sim through the move into the race event. The session-start brief plays on the move (log: `session.changed` with both SubSessionIDs), then qualifying and race-start as before.
