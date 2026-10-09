# One debounced replay state, read by every consumer

> **Issue:** [#1324](https://github.com/niklam/iracedeck/issues/1324) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

For about 300 ms after every replay seek, iRacing reports `IsReplayPlaying` false (measured 2026-10-04 during #1230's manual test). Every consumer that reads the raw flag on each tick takes those ticks as live:

- **The translator** (`sim-events-iracing` `handleTick`). On a blip tick it leaves its replay guard, wipes state and runs every live diff module against replay telemetry. It then re-enters the guard, tears active state down and wipes again. Any edge the diffs see between the seed tick and the next replay tick can publish a Race Engineer event. Four diff modules carry their own `SimMode === "replay"` guard (`pits-open`, `pit-speeding`, `tire-wear`, `replay-laps`), which covers saved replays only. The in-session replay of a live race keeps `SimMode` `"full"`.
- **Session Info's incident mode** sees `PlayerCarMyIncidentCount` go from -1 to 0 on a blip and flashes an incident.
- **Replay Control** refuses Jump to Fastest Lap "from the car" when it is pressed right after a seek.
- **Replay Markers** already debounces the flag (#1230): `readReplayContext` holds "in a replay" for `REPLAY_EXIT_GRACE_MS` (1 s) after the last replay read. That debounce is local. Its sighting is recorded only when a Replay Markers surface reads the context, not on every tick, so nothing else can use it.

## Decision

**One rule, one instance, owned by `SDKController`** (maintainer's choice, 2026-10-09).

- **The rule** is a pure function in `@iracedeck/iracing-sdk` `telemetry-features.ts`, beside `resolveReplayFrame` and `isLiveOnTrack`. It takes the previous state, the tick's telemetry, its session info and the time, and returns the next state.
- **The instance** lives in `SDKController`. It is updated on every notified tick, before subscribers run, and read through an accessor (for example `getReplayState()`). Every reader holds the controller already: the translator through `self.controller`, and the actions through `this.sdkController`. Because there is only one instance, the translator, the keys and the dials cannot disagree about whether a replay is on screen. Keeping the state in the translator was rejected: the actions would then depend on the Race Engineer's translator for a fact about the sim, and the sim-agnostic `shared/` modules would have to import it.

### The rule

A tick is **in a replay** when any of these holds:

1. `IsReplayPlaying === true`. Entering a replay counts at once, as it does today, so the translator's teardown still happens on the first replay tick.
2. The last tick that read `IsReplayPlaying === true` was less than `REPLAY_EXIT_GRACE_MS` ago. The grace is **1 s**, #1230's measured margin over the ~300 ms blip, and it moves from `replay-markers-ops.ts` to the SDK.
3. The loaded session is a saved replay (`WeekendInfo.SimMode === "replay"`, the #604 discriminator). A saved replay is never live, whatever the flag says (maintainer's choice). This folds the four per-module `SimMode` guards into the one gate, and those modules drop their own copies where the gate now covers them.

The state also carries **the frame on screen**, so Replay Markers keeps its held frame:

- On a replay tick it is `ReplayFrameNum`.
- Through the grace it is the last frame a replay tick showed.
- Live, it is `ReplayFrameNumEnd`, as in `resolveReplayFrame`.

`resolveReplayFrame` stays as the raw read for anything that wants the tick's own value.

**A real exit to live skips the grace.** Replay Control's Jump to Live and Replay Navigation's Jump to End send `goToEnd`. Sent outside a saved replay, it returns the user to the car, and `noteReplayGoToEnd` drops #1230's sighting so no grace follows. That hook moves onto the controller's state (for example `noteReplayLeftForLive()`) and keeps its rule: it has no effect in a saved replay, where `goToEnd` only seeks to the end of the file.

### What each consumer does

- **Translator.** The replay guard in `handleTick` reads the debounced state instead of `telemetry.IsReplayPlaying`, and so does `diffFirstOnTrack`'s live-on-track test. The `lastTickInReplay` edge, the teardown and the wipes are unchanged. They now fire on a real entry and exit, not twice per seek.
- **What stays on the raw flag.** The `session.changed` paths and `diffStartCountdown` deliberately do not gate on `IsReplayPlaying` (#568, #829) and are unchanged. `diffReplayLaps` keeps its own gate shape, with its `IsReplayPlaying !== true` term replaced by the debounced state, so a blip tick neither seeds nor records.
- **Session Info.** The incident-flash comparison is skipped while the state says "in a replay". It neither flashes nor moves its baseline, so a blip cannot read as an increase. After #1345 this check lives in `detectTelemetryEdges`.
- **Replay Control.** Both "refuse from the car" checks read the state: the walk's own guard and the Jump to Fastest Lap dispatch.
- **Replay Markers.** `readReplayContext` reads `inReplay` and the held frame from the controller. The sighting in `shared/replay-cursor.ts` and its three accessors are deleted, together with the local `resolveReplayState`.

### Does a callout fire on a seek today?

The issue leaves this open. The work answers it with a translator test that reproduces a seek: replay ticks, then about 300 ms of `IsReplayPlaying: false` ticks whose telemetry differs from the seed tick (a flag bit, pit road, an incident count), then replay ticks again. The test asserts that nothing is published. Run against the pre-fix guard, it shows whether the old path published anything. Record that result in the PR body either way, because it decides whether the changelog line names the Race Engineer.

## Out of scope

- **The template context's `IsReplayPlaying`.** The value a user's title template reads stays the raw flag. A template is a display of telemetry, not a decision.
- **Any other blip signal.** Whether a blip tick could be told apart by `ReplayFrameNum` or another field is unmeasured. A time debounce needs no such claim, and the issue's own measurement shows the whole snapshot goes live-ish, not just the one flag.
- **Shortening the grace for a real exit made in iRacing's own UI**, such as Esc or Drive. It costs one second of live diffs after getting into the car, which no callout depends on. Only the plugin's own `goToEnd` is known to be a real exit.
- **Holding Session Info's other displayed values through the grace.** Only the incident flash is an edge. A value flickering for 300 ms on a replay seek is cosmetic.

## Testing

- **Rule (`telemetry-features.test.ts`).** Entry is immediate. The flag reads false for 999 ms, then 1 000 ms: in a replay, then out. A saved replay is in a replay with the flag false. The held frame is kept through the grace and `ReplayFrameNumEnd` is used once live. The goToEnd hook ends the grace at once outside a saved replay and does nothing inside one.
- **Controller (`SDKController.test.ts`).** The state is updated before subscribers are notified. A reconnect resets it.
- **Translator.** The seek-blip test above. A real exit still re-seeds the diffs after the grace. A saved replay with the flag false publishes nothing. The existing replay-guard tests keep passing with a controller mock that exposes the state.
- **Actions.** In Session Info, a -1 → 0 blip inside the grace does not flash, and a real increase while live still does. Replay Control accepts Jump to Fastest Lap inside the grace. The existing Replay Markers grace tests are rerun on the moved state.
- **Scenario harness.** Every `telemetrySequence` step that leaves replay and expects a live event must hold for at least the grace. Check the shortcuts that patch `IsReplayPlaying` and confirm each still publishes what its description promises.
- **Manual test (maintainer).** In a saved replay and in the in-session replay of a live race, jump repeatedly with Replay Markers and Replay Control while debug logging is on. Expect no `Incident count increased` line, no "replay not playing" refusal, no translator wipe line per seek, and no Race Engineer line. Then press Drive (or Esc) from the in-session replay and confirm the Race Engineer comes back within about a second.
