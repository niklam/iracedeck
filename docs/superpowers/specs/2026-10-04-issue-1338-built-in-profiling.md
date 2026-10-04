# Built-in profiling and a resource self-report

> **Issue:** [#1338](https://github.com/niklam/iracedeck/issues/1338) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

On 2026-10-04 two performance problems were found only by attaching to the plugin over a debug port:

- #1337: a templated Chat key rebuilt the whole template context every frame, per key.
- #1339: Telemetry Display did the same once per frame, at about 60 MB/s of allocation.

Nothing in an ordinary log hinted at either. Getting the port meant adding the manifest's `Debug` key by hand, which needs Stream Deck developer mode, changes the plugin under test (it adds a console log target, a #1330 freeze suspect), and is nothing a user can do. A user report of high plugin CPU (Discord, 2026-10-04) could not be followed up at all. The maintainer wants this measurement run routinely.

## Decision

Three parts: one for users and support, one that watches by itself, and one for the developer.

### 1. Capture CPU profile, on the settings window's Diagnostics tab

- **What it does.** A **Capture CPU profile** button records 30 seconds of the plugin's main thread and writes two files to a `profiles` folder inside the plugin's own log directory:
  - Elgato: `<cwd>/logs/profiles/`
  - Mirabox and Ulanzi: `<plugin>/log/profiles/`
- **The files.**
  - `cpu-<ISO time>.cpuprofile`, which opens in Chrome DevTools.
  - `cpu-<ISO time>.txt`: total wall and busy time, then the top 30 functions by self time with their bundle positions. That's enough to read a profile in a chat without tools.
  - The folder keeps the newest five captures (pairs), pruned by name pattern only, after each save, the same as the log retention.
- **Mechanism.** The capture is a deck-core module using an in-process `inspector.Session` on the main thread (`session.connect()`, then `Profiler.setSamplingInterval` 1000 µs, `Profiler.start`, `Profiler.stop`). This is Node's built-in inspector, so it needs no `--inspect`, no port and no developer mode. The 1 ms interval halves the 0.5 ms overhead seen in manual profiling; 30 s still yields ~30,000 samples.
- **Page interface.**
  - The button sends `sendToPlugin { event: "captureCpuProfile" }`. It carries no duration and no path, because a command never takes a path from the page (`settings-window.md`).
  - Its status is the run-scoped key `_profileCaptureStatus` (`{ state: "idle" | "capturing" | "saved" | "failed", startedAt?, durationMs?, file?, reason? }`, published as a JSON string like `_voicePackStatus`). `capturing` carries `durationMs`, so the page's countdown never hard-codes 30 s. It is enrolled in `RUN_SCOPED_SETTING_KEYS`, the same pattern as `_voicePackStatus`. It is exempt from the "every producer re-asserts its state" rule in `global-settings.md`, because a capture dies with the process that ran it.
  - The button shows a countdown while capturing and the saved file name afterwards.
  - A press during a capture is refused (the state already says capturing).
  - An **Open folder** button (`openProfilesFolder`) opens the folder through the existing `openDirectoryInExplorer`, which also creates it when no capture has run yet. `openFolderInExplorer` would select a file inside the folder's parent instead.
  - Both buttons render only under `locals.settingsWindow`, like the Diagnostics card's existing Open folder.
- **Logging.** `INFO` "CPU profile capture started" and "CPU profile saved", with the path at `debug`. Unavailable inspector, write failure: `WARN` with the reason, and the state `failed` with that reason.

### 2. Resource monitor, in the plugin log

- **Sampling.** A deck-core module started by every `plugin.ts` beside the #1330 watchdog. Once a minute, on an `unref`'d timer, it samples:
  - `process.cpuUsage()` as a delta, expressed as a % of one core
  - `performance.eventLoopUtilization()` as a delta
  - `process.memoryUsage()`
- **The rule.** The decision is a pure reducer over samples, so it unit-tests without timers:
  - **High:** CPU ≥ 50% of one core, or event-loop utilisation ≥ 0.5, for **three consecutive samples** writes one `WARN`: `Plugin CPU use is high: <n>% of one core, event loop <m>% busy, over 3 min (rss <r> MB, heap <u>/<t> MB)`.
  - **Recovery:** it writes `INFO` "Plugin CPU use back to normal" on the first sample below both thresholds, then re-arms.
  - **Why WARN carries numbers:** the logging rule keeps info lines parameter-free, so the numbers go on the WARN, and that line is what a support log needs.
- **Per-minute figures.** One `debug` line per sample: `Resources: cpu 12.3% core, loop 9.8%, rss 340 MB, heap 64/172 MB`. Visible when debug logging is on, which is when a maintainer is looking.
- **Session summary.** At each iRacing disconnect, through the app-monitor terminate path: `INFO` "Resource summary for the iRacing session", plus a `debug` line with the average and peak CPU, the peak event-loop load, and the peak RSS and heap. Only samples taken while iRacing runs count towards it, and a session with no such samples writes nothing.
- **Not gated on `debugLogging`.** The WARN and the INFO lines always reach the file, because users run with debug off.

### 3. A local debug switch for the developer, never shipped

- **The switch.** `pnpm debug:plugin on|off|status` (`scripts/debug-plugin.mjs`) adds or removes `"Debug": "--inspect=127.0.0.1:9229"` in the Elgato manifest's `Nodejs` block.
  - The port is fixed, so attaching needs no port hunting.
  - The script edits the file as **text**, touching only that one line, so the manifest's formatting and inline arrays survive (never parse and re-dump a JSON config).
  - It prints that Stream Deck must restart the plugin, and that the key only takes effect in developer mode.
  - It refuses a manifest whose `Debug` holds anything else, naming the value, rather than overwriting it.
- **Three guards so a release can never carry it:**
  - **Pack time.** `assert-release-build` also refuses a manifest with a `Debug` key. `pack:plugin` already runs it first, so a packed artifact can't carry the port.
  - **Commit time.** The pre-bash hook denies a `git commit` that includes the Elgato `manifest.json` while its staged content carries `"Debug"`, with `pnpm debug:plugin off` as the fix. This is a mechanical rule, so per `hooks.md` rule 1 it lives in the hook, with a test.
  - **CI.** `scripts/manifest-no-debug.test.mjs` asserts the **committed** manifest has no `Debug` key, reading `git show HEAD:<path>`, never the working tree. So a local `on` keeps the suite green, and only a commit that carries the key goes red.
- **Rule update.** `logging.md`'s #1330 paragraph replaces "add `"Debug": "enabled"` locally" with the switch.

## Alternatives rejected

- **Shipping `"Debug": "enabled"`.**
  - It only acts in developer mode, but the maintainer's machine is always in developer mode, so every test run would carry the console-pipe #1330 suspect again. That confounds the freeze investigation.
  - Users still couldn't produce a profile without DevTools.
- **Heap snapshots on demand.** A snapshot freezes the plugin for seconds (and would trip the watchdog), and runs to hundreds of MB. The monitor's used-versus-reserved heap figures were enough on 2026-10-04 to tell churn from a leak.
- **A sampling allocation profile button.** Useful (it found #1339's source), but a second capture type doubles the UI for a rarer question. Revisit if allocation questions recur.
- **Continuous profiling.** Its overhead is always on, for a problem that appears in one session in fifty.

## Out of scope

- Uploading profiles anywhere. The user attaches the files to a report.
- Profiling worker threads or native code. The capture sees the main thread's JavaScript and the time it spends in native calls, which is where both 2026-10-04 findings were.
- Mirabox and Ulanzi debug switches. Neither host has a manifest-driven inspector flag. Their capture button and monitor work the same.
- Changing the #1330 watchdog.

## Testing

- **Monitor reducer (unit).**
  - Three high samples give one WARN carrying the numbers.
  - Two high samples then one normal give nothing.
  - Recovery gives one INFO and re-arms.
  - The CPU and loop thresholds each trigger independently.
  - The session summary computes average and peaks.
- **Capture (integration, child Node process).** A real 2-second capture against a busy function writes a `.cpuprofile` that parses, with `nodes` and `samples`, and a `.txt` naming that function. A second capture while one runs is refused. The prune keeps exactly five pairs and never touches other files.
- **Command handler.**
  - `captureCpuProfile` and `openProfilesFolder` take no parameters and ignore any sent.
  - The status key is run-scoped: stripped before the file and from UI frames.
- **Debug switch.**
  - `on` then `off` restores the manifest byte for byte.
  - `on` twice is a no-op.
  - A foreign `Debug` value is refused.
  - `status` reports all three states.
- **Guards.**
  - `assert-release-build` fails on a manifest with `Debug`.
  - The hook denies the staged-manifest commit and allows one without the key.
  - The CI test fails when HEAD's manifest carries it, proven against a temporary commit in a test repo.
- **Manual.**
  - Press **Capture CPU profile** on each host during a session. The files appear; the `.txt` top entry matches what DevTools shows for the `.cpuprofile`.
  - With six templated Chat keys on a pre-#1337 build, the monitor WARNs after three minutes.
  - `pnpm debug:plugin on`, a restart, then `chrome://inspect` attaches on 9229. `off` restores the file, and `git status` shows it clean.
