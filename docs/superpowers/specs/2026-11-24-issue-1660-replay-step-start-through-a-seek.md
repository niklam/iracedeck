# Where a replay step starts while the replay is seeking (#1660)

> **Issue:** [#1660](https://github.com/niklam/iracedeck/issues/1660) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

Replay Control's Next / Previous Lap and Session, on the key and the dial, and Replay Markers' Previous / Next, on the key and the dial, all step through a recorded list from one start frame through the shared walk (`replay-engine`'s `replay-record-walk.ts`, #1426). They do not agree on what that start frame is while the replay is seeking.

- **Replay Control** reads `resolveReplayWalkStart`. With no pending target, it takes the debounced state's frame only when the tick reads a replay or the last replay sighting is under `REPLAY_EXIT_GRACE_MS` old. Its `held` test is grace-only: it predates #1429 and ignores the seek hold.
- **Replay Markers** reads the debounced state's `frame` as it stands (`readReplayContext`), through `resolveMarkerJumpAnchor`.
- **The SDK state** (`telemetry-features.ts`, `replayStateAt`) holds `frame` at the last sighting through the grace and, since #1429, through the seek hold. Past both it falls back to the tick's own frame.

They disagree in two places:

1. **A seek hold that outlasts the grace with no pending target.** That means a search of the plugin's is on its way, since a sent target is itself the anchor. Replay Control reports `no cursor` and falls back to the key's search, which the gate holds behind the landing. Replay Markers steps from the held pre-search frame, and its absolute jump cancels the search ("an absolute jump into a search wins", the gate's table).
2. **A saved replay past the grace with the flag reading false**, for example a seek that is not the plugin's. The state's frame is the tick's `ReplayFrameNum`, which reads 0 mid-seek. Replay Control reports `no cursor`. Replay Markers steps from frame 0, so Next goes to the first marker of the session.

The website already promises, for Replay Control, that "a press made while a … search is still running waits for the search to land" (`replay-control.md`, the intro), and that a second lap press while a jump is on its way "steps on from where the replay is going". Record steps and marker jumps during a search keep neither promise today: they act at once, from where the replay was.

## Decision

**Where a step starts, in order:**

1. **The pending target**, while one stands (unchanged, #1430).
2. **The landing of a search of the plugin's that is on its way.** Its frame is not known until it lands: iRacing's search has no target the plugin can read. So the press waits for that landing, then reads its start again from the top and steps from there.
3. **The cursor**: the frame a replay tick shows, or the frame the SDK state holds through the grace or the seek hold.
4. **No cursor.** The flag reads false past the grace and the hold. A press with no cursor sends no step: Replay Control falls back to its search as today, and Replay Markers sends nothing.

**Owners.** The SDK state owns whether its frame is a cursor (point 3). The engine owns where the replay is headed (points 1 and 2), as it already owns the target and the search record. `resolveReplayWalkStart` composes them, and both actions read it. Replay Markers stops measuring a step from `state.frame` directly.

- **SDK, `iracing-sdk` `telemetry-features.ts`.** `ReplayState` gains one read of "the frame on screen, as a cursor": the frame when the tick reads a replay or the frame is held (grace or seek hold), else null. It is computed in `replayStateAt` beside `frame`. `frame` itself is unchanged, because Replay Markers' Add / Delete and the translator read it, and the live edge (`ReplayFrameNumEnd`) is a frame but never a cursor. The engine's own grace arithmetic in `resolveReplayWalkStart` goes. `REPLAY_EXIT_GRACE_MS` is then read only where the rule lives.
- **Engine, `replay-record-walk.ts`.** `resolveReplayWalkStart` stays synchronous and gains a fourth answer, `{ frame: null, reason: "search on its way" }`. A new async companion returns the step start once any such search has ended, and both presses call it. Its wait is the gate's own landing verdict (`waitForReplaySearchLanding`), bounded as the paced search bounds it: `replaySearchPatienceMs` while nothing shows the search (a paused replay), else up to the landing or `REPLAY_JUMP_MAX_WAIT_MS`. Whatever the outcome (landed, found nothing, not landed, gave up, superseded), it re-reads the start from the top. So a search replaced by a jump anchors on that jump's target, and one that found nothing anchors on the cursor.
- **Presses that wait together resolve in press order, each from the start as it reads at that moment.** The first one's jump records its target before the second one reads, so two quick presses during one search step twice from its landing, never twice to the same entry. The engine keeps one queue of waiting starts, so the order does not depend on poll timers. It is not a lane in the gate. The gate's table and its one waiting slot are unchanged, and a waiting start sends nothing until it resolves.
- **A step press waits for a command held before it.** A step press made while the gate's slot holds a command pressed before it waits its turn like a queued press, so presses from every key and dial go out in the order they were made, and a step press never silently drops a held command (master's "newest wins" did, for a step press made while another key's command waited behind a jump). Found by the hands-free probe on Niklas's Spa replay, 2026-11-28 (PO's call).
- **Queued jumps wait for a fresh tick.** After a queued press sends a position jump, the next queued press waits until the sim has delivered two new telemetry ticks, a read-back rather than a time: the 2026-10-12 measurement landed 5 of 10 jumps sent 20 ms after another and 20 of 20 at 35 ms, and one tick is about 16 ms. Found by the same probe: two queued marker jumps went out 4 ms apart and the second was lost.
- **Views do not wait.** A key's greyed state, the dial's side marks and its value read the synchronous answer. During a search they read the cursor, and they redraw when it lands.
- **Busy mark.** A Replay Control or Replay Markers press waiting on a landing shows the still mark on its key or dial, as a press waiting in the gate does. Both register with the replay busy indicator and their jumps carry the context id.

**Why this option.** Three were weighed for point 2:

- **Step from the held frame.** This is the smallest change, and #1429 already holds the frame. But the step's jump cancels the search the user asked for, and the step is measured from where the replay is leaving. A Lap press during an Incident search goes to the lap after the pre-search frame. The PO's concern about two Next Lap presses does not arise here: the first press missed the record, so the second misses again from the same frame, and its search waits behind the first in the gate. Two presses already go two laps on master. The loss is in the mixed cases: a step from one source while another source's search runs, the dial's paced search, and every Replay Markers press.
- **No cursor.** Replay Control's fallback search chains correctly behind the landing. But Replay Markers has no search to fall back on, so its press does nothing.
- **The search's landing (chosen).** Both actions chain from where the replay is headed. That is the principle the target anchor already follows (#1430) and the promise the website makes. It costs a new wait in the engine, which is the reason for the second read below.

The saved-replay frame 0 counts as no cursor under all three options.

## Load-bearing fact to verify first

Point 3 says a saved replay **at rest** past the grace has a cursor only if its tick reads `IsReplayPlaying` true. The 2026-10-12 measurements read the flag true on a paused saved replay at rest ("the first sample with the target frame already has the flag true"). The SDK's own comment marks the flag-false-at-rest case as unverified. If a paused saved replay can read the flag false at rest, this rule would stop every Replay Markers press there. So the hands-free probe below checks it before any code changes. If it fails, the spec is amended: a saved replay at rest then needs a different discriminator, such as `ReplaySessionNum` reading -1 only mid-seek.

## User-visible change

- A Replay Control Next / Previous Lap or Session press, on the key or the dial, made while a Lap, Session or Incident search is still running now waits for that search to land and steps on from there. Today it ends the search and steps from where the replay was. Two quick lap presses still go two laps.
- A Replay Markers Previous / Next press made in the same window behaves the same way.
- A Replay Markers Previous / Next press during a seek that is not the plugin's own, in a saved replay, now sends nothing. Today it jumps to the first marker.

**Changelog fragment (for Niklas's approval):** `changelog.d/1660-replay-step-during-search.md`, `Bug Fixes`, weight 50. Bug Fixes, because both behaviours shipped:

```markdown
---
category: Bug Fixes
weight: 50
---

A **Replay Control** Lap or Session step or a **Replay Markers** jump pressed while a Lap, Session or Incident search is still running now waits for the search to land and steps on from there, instead of ending the search and stepping from where the replay was. See [Replay Markers](/docs/actions/view-camera/replay-markers/).
```

**Website text (for Niklas's approval):**

- `replay-markers.md`, after "A second marker jump takes over instead, and remembers the state from before the first.": "A Previous or Next press made while a Replay Control Lap, Session or Incident search is still running waits for the search to land and moves on from where it landed."
- `replay-control.md`, Next / Previous Lap (the paragraph ending "so two quick presses go two laps."), append: "A press made while a Lap, Session or Incident search is still running, from any key or the dial, steps on from where that search lands."

## Out of scope

- Replay Markers' Add and Delete. They read `frame`, not a cursor, and filing at the live edge while driving is deliberate. A saved-replay mid-seek Add filing at frame 0 is the same class of bug, but it is not a step. It goes to a follow-up if the probe shows it reachable.
- The gate's table, its one waiting slot and its takeover rule ("pressing again acts at once" for gate commands).
- Jump to Fastest Lap and Jump to Race Start, which have their own press slot and walk.
- The legacy Replay Navigation action, whose lap and session keys send iRacing's search and take no walk start.
- Changing what the seek hold covers (#1429) or the grace.

## Testing

- **SDK (`telemetry-features.test.ts`).** The cursor read is the frame on a replay tick, the held frame inside the grace, the held frame through a seek hold past the grace, and null past both with the flag false, in a live session and in a saved replay (frame 0). The live edge is never a cursor.
- **Engine (`replay-record-walk.test.ts`).** A seek hold past the grace with no search gives the held frame. A search on its way gives `search on its way`, and the async start resolves to the landing. Each outcome other than a landing re-reads: `found-nothing` and `not-landed` give the cursor, `superseded` by a jump gives its target, and a departure gives `not in a replay`. Two waiting presses resolve in press order, the second from the first's target. A saved replay at frame 0 past the grace gives `no cursor`.
- **Actions.**
  - Replay Control key and dial: a Lap step pressed during a search past the grace waits and lands from the landing, not the pre-search frame.
  - Replay Markers key and dial: the same.
  - Replay Markers in a saved replay mid-seek with no hold sends nothing.
  - The busy mark shows on a waiting Replay Control key and on a waiting Replay Markers key and dial.
- **Hands-free sim probe**, on Niklas's saved replay, real action code (`IRACEDECK_REAL_NATIVE=1`):
  1. Paused at rest for more than 2 s: `IsReplayPlaying` reads true on every tick. This is the load-bearing fact; stop and amend if it fails.
  2. A long Next Session search from the start of the tape, with a Replay Markers Next and then a Replay Control Next Lap pressed through the actions about 50 ms into it. The search lands, and each press lands on the entry after the landing, in press order. Record what telemetry read at each send.
  3. The same on a replay playing at 1x.
- **Niklas's manual test** on a saved replay, debug logging on, two markers placed after the race start:
  1. From the start of the tape, press Replay Control Next Session, then at once Replay Markers Next. The replay lands in the next session, then on the first marker after it, not on a marker near the start.
  2. Press Next Incident, then at once Next Lap. The replay lands on the incident, then on the next lap from there.
  3. Press Next Lap twice quickly in a part of the tape with no record. It goes two laps.
  4. Turn the dial in Lap mode one detent during a Session search. The step goes from the session's landing.
- Review: `/code-review high`, plus the second read (a new wait in the engine, a state machine).
