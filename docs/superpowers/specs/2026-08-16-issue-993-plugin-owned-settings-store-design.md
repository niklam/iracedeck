# Plugin-owned settings store — design (#993)

**Status:** approved in conversation 2026-08-16 (Niklas), pending review of this document.
**Branch:** `release/3.0` (worktree `ir-release-3.0`). Builds on the settings window (#992, `.claude/rules/settings-window.md`).
**Related:** #868 / #895 / #896 (the history this ends), #992 (the window), #996 (Export / Import / Reset — trivial after this), #995 (first-run setup, which becomes testable).

## 1. Problem

Plugin-global settings live in the **deck host's** store, and two independent full-object writers edit that one blob: the Property Inspector (sdpi-components saves its whole page snapshot straight to the host over its own socket) and the plugin (`updateGlobalSettings` sends its whole cache through the adapter). Every guard in `deck-core/src/global-settings.ts` — the first-arrival gate, the pending-write overlay, the per-key salvage, the shrink guard — and the Ulanzi adapter's write gate exist to survive that arrangement. Two facts make it untenable now:

1. **Ulanzi persists nothing at all** across restarts (confirmed 2026-08-16), after two rounds of workarounds against a host store we neither control nor can inspect.
2. **The settings window (#992) is a third UI.** On hardware, a PI edit was rolled back to the window's value: the window's full-snapshot save marked every key pending, and the PI setting a key _back_ to its previous value was indistinguishable from a stale host echo (`Re-applied keys: driverName`). Fixed at the source by writing only changed keys, but the residual — the one changed key, flipped straight back in the PI before the host confirms — is inherent to the dual-writer model.

## 2. Goal

**One writer, one file.** The plugin owns a JSON file; every UI (settings window _and_ every Property Inspector, on all three hosts) reads and writes global settings only through the plugin. The deck host's global-settings store is read **once** (migration) and otherwise unused. All dual-writer machinery is deleted. Ulanzi is fixed because the file never touches UlanziStudio's storage. Per-action settings are unaffected — they stay host-owned (keyed by action context) and are out of scope.

## 3. Decisions taken (and why)

| Decision                     | Choice                                                                                                                                                                                                                                                                                          | Why                                                                                                                                                                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File location                | `%LOCALAPPDATA%\iRaceDeck\Settings\<Stream Deck \| Mirabox \| Ulanzi>\global-settings.json`                                                                                                                                                                                                     | Per-user, outside every host's plugin folder (survives host-driven plugin updates), per-ecosystem so the three plugins never share state; sits beside the window's browser profile.                                                                           |
| Configurable location        | **No.** Env override `IRACEDECK_SETTINGS_PATH` only (dev/testing).                                                                                                                                                                                                                              | Niklas dropped it; a pointer-file indirection isn't worth its own failure modes. The window shows **where the file is** (a link/path on Diagnostics) so users can back it up by hand until #996.                                                              |
| Migration                    | **Copy once, leave the host copy.**                                                                                                                                                                                                                                                             | Downgrade to a pre-#993 plugin still finds settings. On Ulanzi the host has nothing → the file starts at schema defaults (already better than today).                                                                                                         |
| PI reroute                   | **(L) PIs connect to the plugin's loopback server** exactly like the window.                                                                                                                                                                                                                    | One channel for every UI on every host; doesn't bet on Mirabox/Ulanzi plugin→PI push, which is unverified. The server runs for the plugin's lifetime rather than on demand.                                                                                   |
| Port + token delivery to PIs | One **bootstrap read of the host store**: the plugin writes `_settingsChannel = {port, token}` there at startup — the _only_ remaining host write — and the PI bridge reads it with a plain host `getGlobalSettings` before switching every later global-settings frame to the loopback socket. | The PI is a host-hosted page whose URL and per-action payload we don't control; the host store is the one universal channel that reaches it. Within-session host writes land on Ulanzi (the write gate's own history proves it — early writes wiped storage). |
| Ecosystem folder names       | from `getPluginPlatform()`: `stream-deck`→`Stream Deck`, `mirabox`→`Mirabox`, `ulanzi`→`Ulanzi`                                                                                                                                                                                                 | Human-readable on disk; the mapping is a tested pure function.                                                                                                                                                                                                |

## 4. Architecture

```text
                 ┌────────────────────────── plugin process ───────────────────────────┐
  PI (any host)  │  loopback server (#992, now lifetime)  ──▶  global-settings (cache) │
   sdpi + bridge ─┼─▶  /ws fake host: get/set/didReceiveGlobalSettings, sendToPlugin     │
  settings window │                     ▲                        │      ▲                │
   sdpi + bridge ─┘                     └── push on any change ──┘      │ save (debounced)│
                                                                       ▼                │
                                                            SettingsStore (file)        │
                                                        %LOCALAPPDATA%\iRaceDeck\…      │
                                                                                          │
  deck host store  ──(read ONCE: migration)──▶ global-settings ; ◀──(write ONCE per start:│
                                                                    _settingsChannel)     │
                 └──────────────────────────────────────────────────────────────────────┘
```

### 4.1 `deck-core/src/settings-store.ts` (new)

- `interface SettingsStore { load(): Promise<Record<string,unknown> | undefined>; save(settings): void; flush(): Promise<void>; readonly path: string }` — `undefined` from `load` means "no file yet" (→ migration).
- `createFileSettingsStore({ path, logger })`: JSON, pretty-printed; **atomic** write (write `.tmp`, `rename`); **debounced** save (250 ms, trailing) with `flush()` awaited on shutdown paths; a malformed file logs `error` and loads as `undefined` **after moving it aside** to `global-settings.corrupt-<timestamp>.json` (never silently discard a user's file).
- `resolveSettingsStorePath({ platform, env })`: env override first, else the default above. Pure, tested.
- Per-key salvage stays in `global-settings.ts` (it protects against a partially-bad file exactly as it did against a partially-bad host payload).

### 4.2 `deck-core/src/global-settings.ts` (rewritten core; API preserved)

- `initGlobalSettings(adapter, logger, store)` — the third argument is required (tests pass an in-memory store; the `_reset` helper stays).
- Startup: `store.load()` → parsed with salvage → cache; listeners notified once. If `undefined` → **migration**: `adapter.getGlobalSettings()`; on the first `didReceiveGlobalSettings` (or a 10 s timeout, logged) parse the payload with salvage, write it as the file, proceed. Migration state is a module flag; the file's existence is the marker.
- Writes: `updateGlobalSettings(partial)` / `deleteGlobalSettings(keys)` → merge → parse+salvage → cache → listeners → `store.save(cache)`. **No** pending overlay, first-arrival gate, shrink guard, queued writes. Read-your-writes is trivial (cache is truth).
- `hasReceivedHostSettings()` becomes `isSettingsStoreReady()` ("the store has loaded — migration done") and the old name is **removed**; its callers in-repo (`focusIRacingIfEnabled`, the plugins' `startupDefaultsApplied` block) are retargeted in the same change. The gate itself is still right: don't act on schema defaults before the real settings are in.
- After startup the adapter's `setGlobalSettings` is called **exactly once**: `{ _settingsChannel: { port, token } }` for the PIs' bootstrap. `adapter.onDidReceiveGlobalSettings` after migration is **ignored** for the cache (logged at debug) — the host is not truth.
- Every schema default now reaches existing installs? **No, and that's deliberate:** the migrated file carries whatever the host had, exactly as before; the "changing a default reaches new installs only" rule in `global-settings.md` stays true and gets a note.

### 4.3 The settings server (existing, `settings-window-server.ts`)

- Started at **plugin startup** by the controller (`ensureStarted()`), not on first window open; still ephemeral port + per-launch token, still Origin-then-token/cookie, still no CORS. Same fake host serves PIs and the window — no protocol change.
- The `setGlobalSettings` diff-before-write stays (a PI's sdpi still sends full snapshots) but is now merely an optimisation, not a correctness guard.

### 4.4 The PI bridge (new, `pi-components/src/pi-settings-bridge/`, built to `browser/pi-settings-bridge.js`)

- Injected before `sdpi-components.js` in **every action PI on every host** (the shared `injectBridgeScriptPlugin`; on Ulanzi it must compose with the existing Ulanzi bridge — see 4.5). Never in `settings-window.html`, which keeps its own bridge.
- Behaviour: wraps the socket sdpi creates. Passes everything through **except** the global-settings frames: on `getGlobalSettings` it first performs one _host_ `getGlobalSettings`, reads `_settingsChannel` from the reply, opens `ws://127.0.0.1:<port>/ws?t=<token>` (cookie-less — token on the upgrade), then answers sdpi with the plugin's `didReceiveGlobalSettings` and forwards all later `getGlobalSettings`/`setGlobalSettings` to that socket; inbound pushes from the plugin become sdpi `didReceiveGlobalSettings`. Per-action `getSettings`/`setSettings`/`didReceiveSettings` are untouched (host).
- If `_settingsChannel` is absent (old plugin, or the bootstrap failed): fall back to the host path with a console warning — the PI keeps working, just against the (unmaintained) host copy. Never a blank PI.

### 4.5 Ulanzi

- The existing `ulanzi-pi-bridge` translates frames both ways; the PI-settings bridge sits _inside_ it: `translate.ts` maps sdpi's `getGlobalSettings`/`setGlobalSettings` to the loopback socket instead of Ulanzi `cmd`s once `_settingsChannel` is known, using the same bootstrap. One bridge bundle on Ulanzi (`ulanzi-pi-bridge.js` grows the behaviour) — two bridge scripts must never share a page.
- `UlanziPlatformAdapter.setGlobalSettings`'s write gate: **deleted** with the rest; the one `_settingsChannel` write goes through the adapter unchanged.

### 4.6 Window additions

- Diagnostics: a **Storage** card showing the resolved file path (selectable/copyable text — the requirement Niklas stated: "a link to it") plus an **Open folder** button: `sendToPlugin openSettingsFolder` → the plugin spawns `explorer.exe /select,<path>` (Windows-only, detached, the path comes from the plugin's own store — nothing from the page). This is a second `child_process` use beside the app-window spawn and is called out as such; it does **not** go through `openUrl`, which is http(s)-only everywhere by design and which the Ulanzi adapter rejects for other schemes.

## 5. What gets deleted

`global-settings.ts`: `pendingLocalWrites`, `pendingLocalDeletes`, `lastHostSettings`/shrink guard, `hasQueuedWrites`/first-arrival flush, `sameValue`'s reconciliation role (it stays exported for the window's diff). `deck-adapter-ulanzi/src/adapter.ts`: the write gate + timer. `global-settings.md`: the "Write semantics — stale-cache safety (#896)" section is replaced by a short "Single writer" section. Every test that exercised those paths is deleted or rewritten against the store; the salvage tests stay.

## 6. Migration & compatibility

- First start after upgrade: file absent → host read → file written → normal. Log at info: `Migrated global settings from the deck host (N keys)` or `No host settings to migrate; starting fresh`.
- Downgrade: the host copy is untouched, so a pre-#993 plugin behaves as before (minus anything changed since the migration).
- Two plugins of different ecosystems on one PC: separate files, no interaction.
- `_settingsChannel` is written to the host every start (port/token change per start); it's harmless if a downgraded plugin sees it (passthrough key).

## 7. Testing

- **Unit:** store (atomic write, debounce, corrupt-file move-aside, path resolution incl. env override, ecosystem folder mapping); global-settings core (load, migration incl. timeout, write→save, salvage, listeners, the single host write, ignoring later host payloads); PI bridge (bootstrap read, switch-over, fallback, per-action frames untouched); Ulanzi translate additions; window Storage command.
- **Build checks:** every PI HTML on every host carries exactly one bridge script before sdpi (`pi-settings-bridge.js` on Elgato/Mirabox, the grown `ulanzi-pi-bridge.js` on Ulanzi); `settings-window.html` unchanged.
- **Hardware (Elgato, Niklas):** fresh install (delete the file) → migration → PI + window both show host values; edit in PI → window updates and the file changes; edit in window → PI updates; restart → values persist from the file; downgrade sanity: the host copy still has the migrated values.
- **Hardware (Mirabox, Niklas):** same round-trip.
- **Hardware (Ulanzi, community tester):** the one thing only they can answer — after restart, settings persist (file) and PIs bootstrap `_settingsChannel` within the session.

## 8. Phasing (each independently shippable on `release/3.0`)

1. **Store + core rewrite** behind the existing API, migration, deletions, tests. The window and PIs still work exactly as before _from their point of view_ — the plugin just persists to a file and stops writing the host. **After this step Ulanzi is fixed for everything that goes through the plugin (the window).**
2. **Server at startup + `_settingsChannel`** — the plumbing PIs will need; no PI change yet.
3. **PI bridge (Elgato + Mirabox)** with fallback; hardware round-trip on both.
4. **Ulanzi bridge growth**; community test.
5. **Storage card** in the window; docs/rules/changelog (`global-settings.md` rewrite, `settings-window.md` §, architecture page's settings path shrinks to one arrow, changelog line).

## 9. Risks, stated

- **Ulanzi within-session host echo** for the bootstrap read is inferred, not observed. Mitigated by the fallback (PI works against the host copy) and by step 1 already fixing the window/plugin path regardless.
- **Two-phase PI bootstrap** adds ~1 round-trip to PI open. Acceptable; measured on hardware in step 3.
- **A lifetime loopback listener.** Same guard as the window (token + Strict cookie + Origin, loopback bind, no CORS); the surface is now justified.
