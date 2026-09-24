# Development Voice Packs by Default

> **Issue:** [#1214](https://github.com/niklam/iracedeck/issues/1214) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

#1143 gave the plugin a development voice root, but reaching it takes three steps a developer has to remember: `pnpm dev:voices on` once per worktree, `pack:voice default --no-catalog` after every voice edit, and a Rescan or restart. The first two fail silently. A worktree that never ran `dev:voices on` plays the AppData copy, and a stale stage plays the previous clips; both are discovered in the sim. The marker is per worktree and dies with it, so every new `../ir-<n>` resets to the downloaded pack.

## Decision

Development mode becomes a **machine-wide opt-in**, and while it is on, **`pnpm build` stages the voice** the plugin will play. After opting in once, a developer builds any worktree and hears that worktree's clips after a plugin restart.

### 1. The opt-in is an environment variable

`IRACEDECK_DEV_VOICES=1`, set in the developer's user environment.

An environment variable rather than a file under the user profile, because turbo can hash it: a task's `env` list is part of its cache key, whereas a file outside the repo cannot be declared as an input, and an undeclared read is served stale from cache (the #1143 marker is hashed for exactly this reason). Turbo 2 also runs tasks in strict env mode, which strips any variable a task does not declare, so the declaration is required for the value to reach Rollup at all, not only for caching.

The reader is strict, like `dev.local.json`: `1` means on, `0` or unset means off, and any other value throws, naming the variable. A typo that silently leaves development mode off is the failure this issue exists to remove.

### 2. The worktree marker overrides the machine default, in both directions

Resolution, first match wins:

| `dev.local.json` | `IRACEDECK_DEV_VOICES` | Result |
| --- | --- | --- |
| `voicePacksRoot: "<path>"` | any | on, at that path |
| `voicePacksRoot: false` | any | off |
| absent | `1` | on, at `DEFAULT_DEV_VOICE_PACKS_ROOT` in this worktree |
| absent | `0` / unset | off |

`voicePacksRoot: false` is the one schema change to the marker: an explicit per-worktree off, which is how a developer who opted in machine-wide still tests the real download path. `pnpm dev:voices` gains a third verb:

- `on` writes the default root (unchanged)
- `off` writes `voicePacksRoot: false`. Before this change it deleted the file, which under a machine opt-in would turn development mode back ON.
- `auto` removes the marker, so the worktree follows the machine setting

All three keep #1143's transaction: capture the previous marker, rebuild and relink, restore on failure. `on` and `off` still refuse to overwrite a marker holding a hand-picked path.

The default root resolves against the worktree being built. So "the linked directory" falls out without further work: the host is linked to a worktree, that worktree's build points at its own stage, and its own stage holds its own clips.

### 3. The build stages the voice

`@iracedeck/audio-assets` gets a `stage:dev-voices` turbo task, and each plugin's `#build` depends on it. The task runs whether development mode is on or off, since a turbo `dependsOn` cannot be conditional:

- **Off:** it exits at once and stages nothing.
- **On:** it runs the packer's staging for every authored pack in `src/build/voice-packs.mjs`, into `dist/voice-packs/<id>/`. The packer's own checks stay, including the real-scanner verification of the staged tree. The zip and the catalog rewrite are skipped. This is a new packer flag (`--stage-only`), stricter than `--no-catalog`, which still zips.

Its turbo `inputs` are the voice configs, the clips, the packer and its libraries, `dev.local.json` and `scripts/lib/dev-local.mjs`. `IRACEDECK_DEV_VOICES` goes in `env`, and the stage directory in `outputs`. An unchanged voice is then a cache hit, and a changed clip restages only what the processed-clip cache does not already hold.

The same resolver (§2) decides both the stage task and the Rollup `devVoicePacksRoot`, so the build cannot stage without pointing the plugin at the stage, or the reverse. If the marker names a hand-picked path outside the default, the task stages nothing: that root belongs to whoever picked it.

### 4. No new rescan mechanism

The plugin scans voice packs on every start, so a build followed by a plugin restart plays the new stage. The Elgato `watch` script already restarts after each rebuild. The **Rescan voices** button covers the case where the developer doesn't want to restart. Niklas prefers the manual rescan over a watcher, so none is added.

### 5. Visibility moves to the build log

Before this change, forgetting development mode meant being OFF by accident. Under a machine opt-in, the risk flips: being ON by accident. The build prints one line per plugin build when development mode is on, naming its source (`dev.local.json` or `IRACEDECK_DEV_VOICES`) and the root. The plugin-side signals stay as they are: the `Voice packs: development root active` log line and the *Development build* badge.

## Release safety

Nothing here weakens #1143's guarantee that a shipped plugin cannot carry a development root:

- **CI** never sets the variable. The guard test fails if any `.github/workflows/*.yml` mentions `IRACEDECK_DEV_VOICES`, and if any plugin `#build` or the stage task leaves it out of `env`.
- **Local packing** is still refused by `assert-release-build.mjs`, which is the first step of every `pack:plugin` and reads the built config rather than the environment. A maintainer with the variable set who packs locally gets the same refusal a `dev:voices on` worktree gets today.
- **Release tags** build in CI (see the first point).

## Out of scope

- A file watcher on the development root, or an automatic rescan. §4 covers why.
- A machine-wide processed-clip cache. The cache lives under each worktree's `audio-assets`, so the first dev build of a new worktree processes every clip through ffmpeg once. The implementation measures this cost and reports it. It is accepted as paid once per worktree and only with the opt-in; sharing the cache across worktrees is a separate change.
- Staging `sfx/`, which still ships inside the plugin build.
- Any change to the scanner, the launch step, the shadowing rules, or the settings window. The plugin side of #1143 is untouched.
- Website and changelog. This is developer tooling only.

## Testing

**Suite**

- Resolver: the §2 table as a matrix. This covers every marker state (absent, path, `false`, invalid) crossed with every variable state (unset, `0`, `1`, garbage), including the throw on a garbage value and on a non-string, non-`false` `voicePacksRoot`.
- `dev:voices`: `off` writes `false` rather than deleting, `auto` removes the marker, and all three verbs still restore the previous marker when the build fails.
- Stage task: it stages nothing when off and nothing when the root is hand-picked. When on, it stages every authored pack without writing a zip or touching `catalog/`.
- `dev-voice-root-guard.test.mjs`, extended: every plugin `#build` and the stage task declare the variable in `env`; no workflow file mentions it; every plugin `#build` depends on the stage task.
- Positive control: the guard's new assertions are each shown to fail against a deliberately broken config before they are trusted.

**Manual**

1. With `IRACEDECK_DEV_VOICES=1` set and no marker, create a fresh worktree, link the Stream Deck to it, `pnpm build`, and restart the plugin. Installed Voices shows *Development build* with this worktree's directory, and the build log names `IRACEDECK_DEV_VOICES` as the source.
2. Edit one clip, `pnpm build`, restart, and hear the new clip. Edit another and press **Rescan voices** without restarting after the build. The new clip plays.
3. `pnpm dev:voices off` in that worktree: the row reads *Downloaded* and the launch step's ensure runs for `default` again.
4. `pnpm dev:voices auto`: back to *Development build*.
5. Unset the variable and `pnpm build` with no marker: *Downloaded*, and the build prints no development line.
6. With the variable set, `pack:plugin` is refused by `assert-release-build.mjs`.
7. Report the wall time of the first dev build in the fresh worktree, and of a rebuild with one changed clip.
