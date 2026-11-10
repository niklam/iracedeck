# The plugin version in every log

> **Issue:** [#1678](https://github.com/niklam/iracedeck/issues/1678) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Decision

One info line, written by `plugin-runtime`, names the build that wrote the log:

```text
INFO  Build: iRaceDeck 3.10.0 (stream-deck), Stream Deck 7.1.0, Windows 10.0.26300 x64, Node v24.16.0
```

- **Fields, in order:** the plugin version (`getPluginVersion()`), the plugin platform (`getPluginPlatform()`), the deck host's name and version, the Windows version (`os.release()`, whose build number tells Windows 10 from 11) and architecture (`os.arch()`), and the Node version (`process.version`).
- **Written twice over:** once at plugin start, as the first line `initCore` writes after it applies the log level, so before the watchdog's `Main-thread watchdog started`; and again at every iRacing session start, on `onIRacingStarted` from `deck-iracing`'s app monitor, which fires once per session on every host (the launch event, or the SDK connection on Ulanzi).
- **Never gated on `debugLogging`.** Support receives info logs; debug is off by default (#609).
- **Scope `Build`.** One `adapter.createLogger("Build")` in the core phase, so the line is easy to find with a search for `Build:`.

### Why the session-start repeat

A log a user sends is usually about one session, and the startup line is often not in that file:

- Elgato's SDK file target (`@elgato/utils` `FileTarget`, `maxFileCount: 10`, `maxSize: 50 MiB`) re-indexes at every plugin start and again whenever the file reaches 50 MiB. A file cut by size, which a long session with debug logging on can reach, opens mid-run.
- Mirabox and Ulanzi write one file per day (`FileSink`, `<YYYY.M.D>.log`). A plugin started before midnight writes the rest of its run, sessions included, into a file with no start in it.

Writing the line at each session start puts it beside the session in every case but a size cut in the middle of one session, which is accepted: it needs 50 MiB written inside one session, and the previous file, sent with it, holds the line.

### Where the host's name and version come from

`IDeckPlatformAdapter` gains one required, read-only member whose value may be `undefined`, the shape of `logLocation`:

```typescript
/** The deck host software the plugin runs in. */
export type HostApplication = { name: string; version: string | null };

/** What the host's registration reported of itself; `undefined` only when the adapter cannot name its host at all. */
readonly hostApplication: HostApplication | undefined;
```

- **Elgato** fills it from the SDK's registration info (`streamDeck.info.application.version`), name `Stream Deck`.
- **Mirabox** fills it from the registration info JSON VSD Craft passes in `argv[9]` (`application.version` when present), name `VSD Craft`. `parseConnectionParams` reads no `argv[9]` today. The field has not been seen in a capture; the manual test below reads it, and a host that leaves it out gives `version: null`.
- **Ulanzi** gives `{ name: "UlanziStudio", version: null }`: the adapter knows its host, and UlanziStudio's launch arguments carry an address, a port and a language but no version.
- **The two fakes** (`scenario-harness`' mock platform adapter, `plugin-runtime`'s `test-support/fake-host.ts`) set it explicitly.

The line writes what it has and nothing it does not: `Stream Deck 7.1.0`, `UlanziStudio` with no version, or no host part at all for an adapter that answers `undefined`, never a guess. Required rather than optional (`?`) so a fourth adapter has to decide what it reports: an omitted member would silently drop the host from its logs and snapshots with nobody having chosen that. `supportsApplicationMonitoring` is optional for a different reason, since leaving it out has a defined meaning.

### One reader for the build facts

`plugin-runtime` gets one `readBuildInfo(adapter)` that returns the six facts, and both consumers read it: the log line, and the Telemetry Snapshot's `environment` section (`state-sections.ts`), which today carries `pluginVersion`, `host` and `node` from its own reads. The snapshot gains `hostApplication`, `windows` and `arch` from the same function, so a log and a snapshot from the same run can never name different builds. No path is added to either, keeping `state-sections.ts`'s no-path rule.

### The exception to "info carries no parameters"

`logging.md` asks info lines to name an event and leave the values to debug. This line is the values, and it exists for the logs support actually gets, which are info logs. It joins the existing exceptions (the `LapCompleted` and `Overtake` race lines, the resource monitor's high-CPU WARN) as a named one in `logging.md`, with that reason, so it is not copied as a precedent for chatty info lines.

### Documents that change with it

The adapter member changes a seam, so the same change updates where the seam's host members are listed: the developer Architecture page (`packages/website/src/content/docs/docs/development/architecture.md`, the list beside `setLogLevel`, `logLocation`, `openUrl` and `onOpenSettingsRequest`), `packages/deck-core/CLAUDE.md`, and `packages/plugin-runtime/CLAUDE.md`, which also lists the snapshot's `environment` fields. `logging.md` gains the exception below.

### Why the session-start hook is `deck-iracing`'s

`onIRacingStarted` is a sim-specific signal, but `plugin-runtime` is where the sim is bound, and `initCore` already subscribes to this same signal for the resource monitor's session edges (and `startServices` for the audio hold). The Architecture page lists those running and exit signals among what a second sim replaces together with `initSim`. Subscribing beside the resource monitor keeps that swap in one place; a sim-neutral session hook on `HostSim` was rejected, since `HostSim` is the host extension's view of the sim and would widen for one consumer.

## Alternatives rejected

- **A header line written by the log sink when it opens a file.** It would cover every file exactly, but Elgato's file target belongs to the SDK and has no open hook, so only two of three hosts would get it, and the sinks would need to know the build, which they do not.
- **The git commit in a development build.** It would tell two `-dev` builds apart, but the commit changes on every commit, so the bundles would differ on every commit and turbo would rebuild all three plugins for nothing. A development build is identified by its `-dev` version and the date; the person running it knows which tree it came from.
- **Logging the line only at start.** The two file-splitting cases above leave it out of exactly the files that matter.
- **Logging at debug level.** Debug is off in the logs users send.

## Out of scope

- Voice pack versions: `VoicePacks` already logs its own state, and the Telemetry Snapshot records the installed packs.
- A dump of the settings or the feature flags.
- Any change to log retention, rotation or file names.

## Testing

- **Unit:** `readBuildInfo` with a fake adapter, with and without `hostApplication`, and with a `null` host version; the line's formatting for each, including the omitted host part.
- **Core phase:** the `Build:` line is written once at `initCore`, before the watchdog starts (a recording logger and a spied `startMainThreadWatchdog`), and at the info level with `debugLogging` off.
- **Session start:** each `onIRacingStarted` notification writes the line again; a second notification in the same session (there is none, since the monitor fires once per session) is not invented.
- **Adapters:** Elgato and Mirabox fill `hostApplication` from a registration fixture; Mirabox gives `version: null` for info without `application.version`; Ulanzi gives `{ name: "UlanziStudio", version: null }`. `pnpm typecheck` fails on an adapter or fake that does not set the member.
- **Snapshot:** the `environment` section carries the same values `readBuildInfo` returns.
- **Manual, on each host:** start the plugin, open the log, find the `Build:` line before the watchdog line; launch iRacing and find it again beside `iRacing launched`. On Mirabox this is also the check of whether VSD Craft reports its version.
