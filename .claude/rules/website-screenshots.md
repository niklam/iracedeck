---
paths:
  - "packages/website/src/**"
  - "scripts/lib/settings-window-capture/**"
  - "scripts/capture-settings-window.mjs"
  - "scripts/release-capture.mjs"
  - "scripts/lib/release-capture.mjs"
---

# Website Screenshots

The website's only screenshots today are the Settings window's tabs (issue #1010). They are **generated, not hand-captured** — treat them as build output that happens to be committed, like `packages/icons/preview/` — and since #1536 **only the stable release captures them**, into its `chore(release)` commit.

## Regenerating

**A branch never commits a screenshot** — not after a UI change, a fragment or a `changelog.mdx` edit. Every user-facing PR used to recapture `whats-new.png`, and every recapture after a version bump rewrote the header version on all eleven tabs, so any two branches in flight conflicted on binaries git cannot merge (#1536). `capture-manifest.test.mjs` turns a branch's PNG red, since its hash no longer matches `capture.json`, and names the fix: `git checkout origin/master -- packages/website/src/assets/settings-window/`. Between releases `master`'s shots show the last release while its pages may already describe newer UI; the site ships from stable tags only, where the two agree.

To look at a change, capture locally:

```bash
pnpm build             # the harness reads the plugin's built ui/ folder
pnpm capture:settings  # writes local/settings-window-capture/*.png (gitignored)
```

`pnpm capture:settings` writes under `local/`, which the root `.gitignore`'s `local/*` keeps out of every commit, and never writes `capture.json`. Only the release hook passes the committed folder as `outDir`: the guard is where the tools write, not a version check, because a `release/*` fix PR builds a stable version too.

### The release capture

release-it's `after:bump` hook, `scripts/release-capture.mjs` (logic in `scripts/lib/release-capture.mjs`, every collaborator injected), runs after `before:bump` has folded the fragments and bumped the version files, and before release-it commits. On a version with any prerelease identifier it only says so — the fold's condition, since `release.yml` deploys the website for stable tags only. On a stable version, in order:

1. **Refuses a developer tree, before building**: `feature-flags.local.json` or `dev.local.json` at the root, or `IRACEDECK_DEV_VOICES` set to any non-empty value, `0` included. The maintainer's user environment sets that variable, so it must be unset in the release shell.
2. **Snapshots the tracked changes `before:bump` left** — the version files, the folded `changelog.mdx`, the fragment deletions, any sealed pack record — each with the hash of its content.
3. **Builds the Stream Deck plugin and its dependencies** through turbo's JS entry (`turbo run build --filter=@iracedeck/iracing-plugin-stream-deck... --output-logs=errors-only`, which keeps a successful build's output inside release-it's 1 MiB hook buffer), streaming its output and repeating the last 200 lines on stderr when it fails. The bumped `package.json` is a turbo input of `iracing-native` and `audio-native` too, so a stable release needs the native toolchain (Visual Studio, node-gyp) as well as a Chromium browser. An MSVC `LNK1318` abort is a toolchain hiccup: restore and rerun the release.
4. **`assertReleaseBuild`** on the built plugin's `bin/config.json`: the artifact carries no development voice root.
5. **Captures every tab into the committed folder with `expectVersion`**: before the first shot the capture reads `.sw-version` over CDP and refuses a page that does not print `v<version>`, which catches a build that missed the bump. A tab the capture skipped (rule 7) fails the release.
6. **Writes `capture.json`** and holds the folder to it, refusing a stray file git would stage (a gitignored `Thumbs.db` or `.DS_Store` passes).
7. **Refuses any tracked change outside the folder that the snapshot does not account for** — a file the build changed, one `before:bump` changed and the build changed again, or a `before:bump` change the build undid — because release-it's `git add . --update` would sweep it into the release commit unseen. Then it stages the folder, which `--update` alone would not do for a pending tab's first, untracked PNG.

Every failure stops before this hook stages anything (the index still holds `before:bump`'s changes) and names two commands: `git restore --staged --worktree -- :/` (safe because `requireCleanWorkingDir` held at the start; it also restores `before:bump`'s staged edits) and `git clean -fd -- packages/website/src/assets/settings-window/`, for a screenshot written for a tab that had none. **Nothing rolls back by itself:** release-it's own rollback (`git reset --hard`) arms only in `beforeRelease`, after `after:bump`, so a failed capture leaves the tree where it stopped. release-it shows hook output only with `--verbose` (`-V`); without it the build and capture sit behind a spinner and, on a failure, release-it prints only the hook's stderr, which is why a failed build repeats its tail there.

`pnpm release:dry` runs this hook's dry branch (`RELEASE_IT_DRY_RUN=1`) after `before:bump`'s, since release-it skips hooks in its own dry run (#1667): the developer-tree checks, then the build and capture it would do, writing nothing.

### `capture.json`

`{ "version": "<x.y.z>", "files": { "<file>": "<sha256>" } }` beside the PNGs, written only by the release hook (two-space JSON and a newline). It makes "captured by a release" checkable in text, which the PNGs are not (rule 3). `capture-manifest.test.mjs` runs `checkCaptureManifest` on the real folder in `pnpm test`, and each finding names its fix:

- **Listing**: every tab in `SETTINGS_WINDOW_TABS` has both a PNG and an entry, or neither (pending, rule 3); no file or entry for an unlisted tab.
- **Hash**: each entry is the sha256 of the file's bytes.
- **Version**: stable semver, at least the newest dated section of `changelog.mdx` (a release whose capture never landed), at most the root `package.json` version with its prerelease stripped.
- **Bootstrap**: while the newest dated section is `3.8.1` (`BOOTSTRAP_RELEASE` in `capture-manifest.mjs`), the version rules are skipped, because the committed `capture.json` says `3.8.1` over PNGs branches captured at assorted `-dev` versions. The 3.9.0 release folds a `3.9.0` section and recaptures at `3.9.0`, which ends it; a follow-up deletes the constant.

### Options and exit

`pnpm capture:settings --scale=2` captures at HiDPI; the release capture always uses the default, `1` (≈490 KB for the nine tabs the set had when it was measured); 2× roughly quadruples that, which is why it isn't the default.

The command exits by itself, and fails loudly when it cannot (#1544). The process it spawns can be only a launcher (Edge's hands off to the real headless browser and exits), so the capture shuts the browser down with `Browser.close`, waits for its own pid (learned over CDP with `SystemInfo.getProcessInfo`), then waits until no process names the run's profile folder, which is the browser's identity: every process of its tree carries it, nothing else does, and it still works when the capture failed before the pid was learned or a crash handler outlives the browser. Only the processes that listing has just named are killed, each with its tree, and only once the bound is spent; a bare pid is never killed, since Windows can reuse it once the browser exits. A listing that cannot run degrades to the pid with a Warning. The throwaway profile is then removed with a few short retries of its own, never Node's `maxRetries`, whose back-off on a file a live browser holds kept the run alive for minutes; a profile that still cannot be removed is a Warning naming the folder. Last, an unref'd tripwire (`exit-tripwire.mjs`) fails the run with exit 1, listing what holds the event loop, if the process is still alive 5 s after its final line.

## Why a harness rather than hand-captured images

Three properties a manual screenshot can't give:

- **Deterministic.** The capture serves a fixed settings fixture (`scripts/lib/settings-window-capture/seed.mjs`), so reruns differ only where the UI actually changed — bar the build-dependent version in rule 4 and the Support tab's hotlinked button in rule 7. Hand-captured shots differ on every unrelated detail, which makes review impossible.
- **Private.** A screenshot of a real install publishes that person's key bindings, audio devices and settings path. The fixture uses a fake `C:\Users\Driver\…` path and invented bindings.
- **Honest.** The page is served by the real `startSettingsWindowServer` against the real built `ui/` folder, so what's captured is what ships — not a static shell whose controls never populated.

## Rules

1. **Capture from the Stream Deck plugin build.** The Profiles tab only renders where the `profiles` platform flag is on, so a Mirabox or Ulanzi build is missing a tab. The harness hard-codes the Stream Deck `ui/` path for this reason.
2. **Never hand-edit the PNGs**: never crop or annotate one, and never copy one into the folder. Change the seed or the page; the next stable release captures it. Removing a tab (rule 3) is the one hand edit the folder allows.
3. **Add a tab → add it to `SETTINGS_WINDOW_TABS`** in `scripts/lib/settings-window-capture/tabs.mjs` and write its `###` section on `docs/getting-started/settings.mdx`, with its shot as `<SettingsShot file="<tab>.png" alt="…" />`, never a Markdown image. The tab is then **pending** until the next stable release captures it: listed, placed on the page, but with no PNG and no `capture.json` entry. The manifest check accepts that, and `SettingsShot.astro` renders nothing for a file the folder lacks, where a Markdown image of a missing file would fail the whole Astro build. `tabs.test.mjs` fails until the list matches the built page; `website-settings-shot.test.mjs` requires every listed tab exactly once in `settings.mdx`, and refuses a `file` that is not a listed tab (a misspelt one would render nothing, for ever) and any direct reference to the folder in website content. **Remove a tab →** delete its PNG and its `capture.json` entry in the same commit; the check names the half left behind. The images themselves can't be diffed reliably across machines (fonts, GPU), which is why the manifest records hashes rather than comparing pixels.
4. **The header shows the release version.** The window header carries the plugin version of the build it was captured from, so it appears in every shot and is not byte-reproducible. The release capture builds after the bump and refuses a page whose header is not `v<version>` of the release being cut, so the committed set always shows the release it shipped in. (Before #1011 the What's New tab embedded a live `iframe` of the published changelog. It now renders the notes the build ships, so at the release it shows the section the fold just wrote.)
5. **Alt text describes the tab**, not the act of screenshotting ("The General tab of the iRaceDeck Settings window", not "Screenshot of settings").
6. **Fractional number fields render in the machine’s locale, and that is accepted.** Chromium RENDERS an `<input type="number">` in the locale — so on a comma-decimal machine a fractional control is captured as `12,5` while the page's own prose beside it, and every reader on an English locale, says `12.5`. The Mouse to Sim vertical offset (default `12.5`) is the first such control on a visible part of a tab; the Race Engineer gap thresholds are the others. Only the DISPLAY is affected — the DOM value stays canonical, so this is never a bug in the plugin, only in the screenshot. It cannot be fixed from the harness: on Windows the format comes from the OS **regional format**, and neither `--lang=en-US` nor CDP `Emulation.setLocaleOverride` changes it (verified — ICU still resolves `en-FI`).

   **Decided 2026-08-30 (#1061): do not switch the regional format for a capture.** Niklas ruled the prose/image disparity not worth solving for now, so a capture runs on whatever format the machine has, and a comma in a captured fractional field (`12,5` in `general.png`, the Race Engineer gap thresholds) is expected rather than a defect to fix or a reason to withhold a recapture. The mechanics above are still true and still worth knowing; what changed is that we no longer act on them. The regional-format switch remains the only known lever if it ever becomes worth solving.

7. **The Support tab's shot needs the network, and carries a number that moves** (#1303). Its button is Buy Me a Coffee's hotlinked image, which has a supporter count drawn into it. Every other shot reads nothing from the network. The capture waits for the visible pane's images before each shot, bounded by a timeout. When one had not loaded or failed to load, that tab's file is **not written**, so an offline capture cannot replace a good shot with the alt text. `pnpm capture:settings` names the tab again after its last line and exits non-zero. In the release capture a skipped tab **fails the release**: a partial set would put the previous release's header on the site, and a release needs the network anyway, so the remedy is to restore and rerun once it is back. The count in the committed shot is whatever the image carried on the day, which is accepted and no reason to recapture by itself.

## Layout

| Path | What |
|------|------|
| `scripts/capture-settings-window.mjs` | `pnpm capture:settings`: arguments and report; captures into `local/settings-window-capture/` only |
| `scripts/release-capture.mjs` | release-it's `after:bump` hook: reads the version, sets the exit code, arms the exit tripwire |
| `scripts/lib/release-capture.mjs` | The release capture's steps, every collaborator injected |
| `scripts/lib/settings-window-capture/run-capture.mjs` | Composition root both callers share: resolves the real server, browser and filesystem; `localCaptureDir` / `committedCaptureDir` |
| `scripts/lib/settings-window-capture/capture-manifest.mjs` | `capture.json`: build, serialise, and `checkCaptureManifest` with `BOOTSTRAP_RELEASE` |
| `scripts/lib/settings-window-capture/tabs.mjs` | The tab list — one source of truth for harness, test and docs |
| `scripts/lib/settings-window-capture/seed.mjs` | The deterministic settings fixture |
| `scripts/lib/settings-window-capture/cdp.mjs` | Minimal DevTools Protocol client (no dependencies — Node's global `WebSocket`) |
| `scripts/lib/settings-window-capture/capture.mjs` | Orchestration; every collaborator injected, so it is testable without a browser |
| `scripts/lib/settings-window-capture/process-tree.mjs` | Listing the processes naming the profile folder, checking a pid, killing a tree |
| `scripts/lib/settings-window-capture/profile-dir.mjs` | Bounded removal of the throwaway browser profile |
| `scripts/lib/settings-window-capture/exit-tripwire.mjs` | Fails the run when something keeps the process alive after its last line |
| `packages/website/src/components/SettingsShot.astro` | Renders one shot on the Settings page, or nothing for a pending tab |
| `packages/website/src/assets/settings-window/` | The committed PNGs and `capture.json` |

The harness adds **no dependencies**: `startSettingsWindowServer` and `findChromiumBrowserOnThisMachine` are already exported from `@iracedeck/settings-window` (`run-capture.mjs` loads its built `dist/index.js`, so build first), and Node 22+ ships a global `WebSocket`. It needs a Chromium-based browser on the machine — the same requirement the Settings window itself has.
