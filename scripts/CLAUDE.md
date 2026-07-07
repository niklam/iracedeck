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

## Dev linking (Mirabox)

- `link-mirabox.mjs` / `unlink-mirabox.mjs` — `pnpm link:mirabox` / `unlink:mirabox` / `relink:mirabox`: junction-links the built Mirabox plugin into the host's plugins dir (default `%APPDATA%\HotSpot\StreamDock\plugins`; override with `MIRABOX_PLUGINS_DIR` in a gitignored `.env.local`). Elgato linking uses the `streamdeck` CLI instead (see root `package.json`).

## Tests

`*.test.mjs` files are colocated here and run under the root vitest (`scripts/**/*.test.mjs` in `vitest.config.ts`). `manifest-actions-order.test.mjs` discovers every plugin manifest dynamically (same discovery as the release bump) and enforces alphabetical action order, name uniqueness, and cross-manifest action-set parity — `ECOSYSTEM_SPECIFIC_ACTIONS` (currently `Switch Profile`) is exempt from parity only. `generate-action-profiles.test.mjs` and `release-hooks.test.mjs` are the generator/release guards.

## Structure

- `lib/` — shared helpers with colocated `.test.mjs` siblings: `version-discovery.mjs` (package/manifest discovery used by the release bump and the manifest tests), `changelog-stamp.mjs`.
- `data/` — script-owned inputs, e.g. `icon-title-defaults.json` (consumed by `add-title-metadata-to-icons.mjs`).
- `radio-effect/` — self-contained ffmpeg clip-processing spike with its own README; not wired into any build.
- `local/` — Personal automation scripts, excluded from version control via `.gitignore`. Each developer can place their own scripts here without affecting the repository.
