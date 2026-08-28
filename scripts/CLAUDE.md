# Scripts

Repo-level Node `.mjs` utilities, mostly backed by root `package.json` scripts. Everything runs on plain `node` **except** `generate:action-comms`, which runs via `tsx` because `generate-action-comms.mjs` imports the TypeScript `comms-catalog.ts` directly — moving it to plain node breaks it.

## Build & release

- `build.mjs` — the root `pnpm build` entrypoint (runs `turbo run build`).
- `build-with-restart.mjs` — `pnpm build:with-restart`: stops a running Stream Deck app, builds, restarts it (the host app locks the native `.node` during a build).
- `release.mjs` — `pnpm release` / `pnpm release:dry`: wraps `release-it` (pulls `GITHUB_TOKEN` from `gh`, strips pnpm's `--` sentinel, sets `RELEASE_IT_DRY_RUN=1` on `--dry-run` so the hook doesn't write files).
- `release-hooks.mjs` — the `.release-it.json` `before:bump` hook (`node scripts/release-hooks.mjs ${version}`). Auto-discovers every `packages/*/package.json` and plugin manifest (`*.sdPlugin` / `*.ulanziPlugin`) via `lib/version-discovery.mjs` and bumps them (manifests get 4-part `x.y.z.<git commit count>`); stamps the changelog date on stable releases via `lib/changelog-stamp.mjs` (policy: `.claude/rules/changelog.md`); preflights with `git add --dry-run`, then stages everything.

## Generators (committed JSON output, guarded by freshness tests)

- `generate-action-comms.mjs` — `pnpm generate:action-comms` (tsx) → `action-comms.json` from `comms-catalog.ts`.
- `generate-action-profiles.mjs` — `pnpm generate:action-profiles` → `profiles.json` from the Elgato manifest's `Profiles` array.
- `generate-icon-previews.mjs` — run after modifying any icon SVG; `generate-icon-defaults.mjs` — run after adding icons. Policy in `.claude/rules/icons.md`.

## Icon migrations & one-offs

The remaining scripts are one-off or occasional icon-SVG tools (`migrate-*`, `flatten-*`, `pad-icon-viewbox`, `refactor-icons-to-snippets`, `check-icon-bounds`, `add-svg-editor-defaults`, `add-title-metadata-to-icons`, `transform-car-svg`). Many are already-applied migrations — read the script's header comment (usage + purpose) before running.

## Dev linking and host control (Mirabox, Ulanzi)

Elgato is absent from all of these on purpose: its linking uses the `streamdeck` CLI and its start/stop scripts hardcode the one install path (see root `package.json`).

- `link-mirabox.mjs` / `unlink-mirabox.mjs` — `pnpm link:mirabox` / `unlink:mirabox` / `relink:mirabox`: junction-links the built Mirabox plugin into the host's plugins dir (default `%APPDATA%\HotSpot\StreamDock\plugins`; override with `MIRABOX_PLUGINS_DIR` in a gitignored `.env.local`).
- `link-ulanzi.mjs` / `unlink-ulanzi.mjs` — the Ulanzi equivalents (default `%APPDATA%\Ulanzi\UlanziDeck\Plugins`; override with `ULANZI_PLUGINS_DIR`). Added in #1040.
- `host-app.mjs` — `pnpm start:ulanzi` / `stop:ulanzi` / `start:mirabox` / `stop:mirabox`, dispatched as `node scripts/host-app.mjs <start|stop> <host>`. The executable comes from `ULANZI_APP_PATH` / `MIRABOX_APP_PATH` with a `%ProgramFiles(x86)%` default, because two Mirabox-compatible hosts are commonly installed side by side (StreamDock, VSD Craft). `start` first prints which worktree the link points at — the junction serves exactly ONE checkout, which is the usual cause of "my fix isn't working".

All four link scripts are thin descriptors over `lib/plugin-link.mjs`, and `host-app.mjs` is argv handling over `lib/host-control.mjs`; the behaviour lives in `lib/`, not in the entry files. Every lib function takes injected `env`/`platform`/`log` and **returns an exit code instead of calling `process.exit`**, which is what makes it testable — follow that shape when adding to them. The entry scripts set `process.exitCode` rather than calling `process.exit`, because a Windows TTY's stdout is asynchronous and exiting outright can truncate the line naming which worktree now owns the host.

Three subtleties there are load-bearing and must survive any edit:

- `lstat` rather than `exists` throughout, so a dangling junction whose target is gone is still detected.
- The unlink branch on entry type. A junction gets `unlinkSync`; a **real** directory is **moved aside** to `<folder>.replaced-<timestamp>`, never deleted. (`rmSync(recursive)` on a Windows junction with a missing target silently no-ops and leaves the junction behind, which is why the branch exists at all; the move-aside is because the folder carries the plugin's own logs and `relink` runs inside `switch-test-env`, where a printed warning scrolls past unread.) The aside suffix must keep breaking the host's `*.sdPlugin` / `*.ulanziPlugin` scan pattern.
- `taskkill` exit codes: 0 stopped, **128 = not running**, anything else is a genuine failure. Collapsing the last two reports a refused kill as success, and the build then hits the EPERM the stop step exists to prevent.

**The dev loop's order is not arbitrary.** `pnpm stop:<host> && pnpm switch-test-env:<host> && pnpm start:<host>`: the host must stop before the **build**, not before the relink, because a running host locks `iracing_native.node` and the build fails with EPERM. And both hosts read their plugins directory at start only, so a relink without a restart changes nothing.

## Tests

`*.test.mjs` files are colocated here and run under the root vitest (`scripts/**/*.test.mjs` in `vitest.config.ts`). `manifest-actions-order.test.mjs` discovers every plugin manifest dynamically (same discovery as the release bump) and enforces alphabetical action order, name uniqueness, and cross-manifest action-set parity — `ECOSYSTEM_SPECIFIC_ACTIONS` (currently `Switch Profile`) is exempt from parity only. `generate-action-profiles.test.mjs` and `release-hooks.test.mjs` are the generator/release guards.

## Structure

- `lib/` — shared helpers with colocated `.test.mjs` siblings: `version-discovery.mjs` (package/manifest discovery used by the release bump and the manifest tests), `changelog-stamp.mjs`, `deck-hosts.mjs` (host descriptors + the pure path resolvers), `plugin-link.mjs` (the shared link/unlink core), `host-control.mjs` (start/stop), `env-local.mjs` (`.env.local` loading, shell wins).
- `data/` — script-owned inputs, e.g. `icon-title-defaults.json` (consumed by `add-title-metadata-to-icons.mjs`).
- `radio-effect/` — self-contained ffmpeg clip-processing spike with its own README; not wired into any build.
- `local/` — Personal automation scripts, excluded from version control via `.gitignore`. Each developer can place their own scripts here without affecting the repository.
