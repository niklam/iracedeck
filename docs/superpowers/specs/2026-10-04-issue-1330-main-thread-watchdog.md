# Main-thread watchdog and audio reroute log line

> **Issue:** [#1330](https://github.com/niklam/iracedeck/issues/1330) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

The plugin has frozen at the moment it connected to an iRacing launched after Stream Deck. Its main thread blocked, the log went silent, and the process stayed alive until Stream Deck was restarted. The two captured freezes left no trace of where the thread was stuck, because everything that logs runs on that same thread. #1330 lists three suspects: the console pipe (removed by PR #1331), an audio device reroute, and a miniaudio wait. Nothing in a log can currently tell them apart. A freeze is rare and intermittent, so diagnosis that relies on the maintainer catching it live, before a restart, will keep failing.

## Decision

### 1. A watchdog worker that diagnoses a blocked main thread by itself

`@iracedeck/deck-core` gains `startMainThreadWatchdog(options)`. All three plugins call it from `plugin.ts` once their logging is up.

- **Heartbeat.** The main thread increments a counter in a `SharedArrayBuffer` every 500 ms. The worker reads it every 500 ms. Both sides use `Atomics`, so the worker never needs the main thread's cooperation to notice it has stopped.
- **Stall.** When the counter has not moved for **5 s**, the worker opens an in-process `inspector.Session`, calls `connectToMainThread()`, and posts `Debugger.enable` then `Debugger.pause`. This uses Node's built-in inspector and needs no `--inspect`, no port and no console. The proof of concept (2026-10-04, Stream Deck's Node 24.13.1, `--no-global-search-paths`) returned the right stack within 12 ms for a JS spin, and no pause for a native block (`execSync`).
  - **The pause lands within 2 s: stuck in JavaScript.** Write `ERROR MainThreadWatchdog: main thread blocked for <n> s in JavaScript`, then the call frames, one per line (function name, bundle line:column), then `Debugger.resume`.
  - **It does not land: blocked in native code.** Write `ERROR MainThreadWatchdog: main thread blocked for <n> s in native code`. Keep the pause pending. If the thread ever returns, the pause lands at the first JavaScript instruction after the native call, and the worker writes those frames under `main thread resumed after <n> s; the pause landed at:`. For a stall that ends, that names the JavaScript that made the blocking call.
  - **The thread recovers.** Once the counter moves again, write `WARN MainThreadWatchdog: main thread responsive again after <n> s`, disable the debugger, disconnect the session, and re-arm.
- **One report per stall.** The worker does not repeat the report while the same stall lasts.
- **Healthy runs write nothing.** No line is written while the heartbeat moves.
- **The worker writes the plugin's log file itself.** A worker's `console` goes through the main thread (measured in the proof of concept: its output appeared only after the main thread unblocked), and the plugin's logger runs on the blocked thread. So the worker appends with `fs.appendFileSync` to the same file the host logger writes. Both writers open, append and close per write, so they cannot corrupt each other's lines. The target is a serialisable descriptor the plugin passes in:
  - Elgato: a fixed file, `<cwd>/logs/<plugin UUID>.0.log`. `@elgato/utils`' `FileTarget` always writes index 0 and renames older files away from it.
  - Mirabox and Ulanzi: a directory whose file is computed per write as `<YYYY.M.D>.log`, matching their `FileSink`.
  - The line format is `<ISO time> <LEVEL> MainThreadWatchdog: <message>`, close enough to all three hosts' formats to read inline.
- **Not gated on `debugLogging`.** The reports are `ERROR` and `WARN`, so they reach users' logs, whose debug logging is off. A freeze is exactly the event a support log must carry.
- **The whole run is watched, not just the connect window.** The cost is one 500 ms timer on each side. Every captured freeze so far was at connect, but a detector watching only there could not show that this stays true.
- **The worker source is one self-contained function.** It is started with `new Worker(\`(${fn.toString()})()\`, { eval: true, workerData })` and uses only Node built-ins through `require`, so it needs no new Rollup entry in any plugin. A test runs the stringified function in a real worker, so a build step that broke `toString()` would turn the suite red.
- **The worker is `unref`'d,** so it never keeps the plugin alive. If `inspector` or `connectToMainThread` is unavailable on a host's Node, the watchdog still reports the stall, without the diagnosis, and says so once at start.

### 2. Log audio device reroutes

The second suspect is the #1253 rename on reroute. Its JS-thread handler `OnSessionRerouted` (`audio-native/src/addon.cc`) calls `applySessionIdentity`, a COM call that runs while miniaudio may still be switching the device.

- `audio-native` gains `setDeviceReroutedCallback(cb)`. `OnSessionRerouted` calls the registered callback **before** `applySessionIdentity`, so a freeze inside the COM call is preceded by the line in the log.
- `audio-service` registers it and logs `INFO Audio: Audio device rerouted`. A reroute is a rare, major event, which the logging rules put at info. Debug would hide it from exactly the users whose logs we need.
- The mock implements the method as a no-op that records the callback, so tests can fire it.

Together the two parts answer the question #1330 cannot answer today. "Blocked in native code" right after "Audio device rerouted" points at suspect 2. "Blocked in native code" with no reroute points at suspect 3, or something new. A JavaScript stack names its own culprit.

## Alternatives rejected

- **Re-enable `--inspect` and attach from outside.** That brings back the console target PR #1331 removed, and it still needs someone at the machine during the freeze.
- **Watchdog in a child process.** The child could not pause the main thread without the inspector port, so it would see only "stalled".
- **A separate log file for the watchdog.** It would split the evidence away from the lines that precede the freeze in the main log.
- **Watch only the connect window.** It saves almost nothing and assumes the answer.

## Out of scope

- **Mapping logged frames back to source files.** Release builds are minified (terser) without source maps. Method names survive minification and identify most code. Line:column refer to the bundle and can be mapped later with a locally built map of the same commit if one is ever needed.
- **Fixing the freeze.** This makes the next freeze diagnose itself. The fix follows from what it reports.
- **Recovering a frozen plugin** (for example, the worker exiting the process so the host restarts it). That decision waits until a cause is known. Killing a plugin that is merely slow would be worse than the freeze.
- **The Mirabox and Ulanzi console output.** Their loggers also write through `console`. Whether those hosts read it is not checked here.

## Testing

- **Unit tests for the decision logic.** The stall, report and recovery states run as a pure function of heartbeat samples and the clock: no report while the counter moves, one report per stall, a recovery line, and re-arming.
- **Integration tests with a child Node process** (the proof-of-concept shape), run by Vitest. The fixture starts the real watchdog with a temporary log file, then blocks its main thread. One case spins in JavaScript and asserts the file names the spinning function. One blocks in `execSync` and asserts "native code" followed by "resumed". A child process keeps the Vitest worker itself from blocking.
- **A `toString()` guard test** runs the stringified worker function in a real `Worker`.
- **The audio callback,** through the mock: registering it and firing it logs the info line once. The native change is exercised by the manual test.
- **Manual.**
  - Normal use on all three hosts adds no watchdog lines to the log.
  - Switching the Windows default playback device while a callout plays logs `Audio device rerouted`.
  - A temporary local edit that spins the main thread for 10 s produces the JavaScript report in the plugin log, then the recovery line.
