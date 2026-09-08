# Platform Feature Flags

Per-plugin build-time flags that gate platform-specific features and temporary kill-switches. `dialFeedback` strips touch-strip feedback/input code and PI controls from the Mirabox and Ulanzi bundles (neither has a plugin-facing touch strip) while keeping it on Stream Deck. `pngRasterization` is a temporary kill-switch for the in-plugin PNG rasterization pipeline (issue #642) — true on all three platforms today, so nothing is actually stripped by it yet; it exists to let the pipeline be disabled quickly (locally, or via a hotfix) if a rendering regression turns up. `profiles` gates the Stream Deck Profiles PI accordion and profile switching (Elgato-only; #736) and, unlike the other two, is a **runtime-only** flag — read via `getFeatureFlag("profiles")` / `locals.platform`, with no `__FEATURE_*__` compile-time constant (see "Runtime-only flags" below). Since #642 retired the `borderGlow`/`svgFilters`-class flags (icons rasterize to PNG in-plugin now, so QT5-vs-QT6 SVG engine capability is no longer a build-time concern — see `.claude/rules/svg-platform-compatibility.md`), these three are what's left.

## Layout

- `packages/iracing-plugin-stream-deck/platform-features.json` — committed Stream Deck flags (`dialFeedback`, `profiles`, and `pngRasterization` all true).
- `packages/iracing-plugin-mirabox/platform-features.json` — committed Mirabox flags (`dialFeedback` and `profiles` off — no plugin touch strip and no profile system on the Mirabox host; `pngRasterization` on, same as Elgato).
- `packages/iracing-plugin-ulanzi/platform-features.json` — committed Ulanzi flags, identical shape to Mirabox today (`dialFeedback` and `profiles` off, `pngRasterization` on) — widen `dialFeedback`/`profiles` only once dial/profile support is verified on Ulanzi hardware.
- `feature-flags.local.json` — **optional, gitignored** developer override at repo root. Deep-merges over every plugin's committed flags at build time.
- `feature-flags.local.json.example` — committed example showing the file shape.
- `dev.local.json` — **optional, gitignored** developer marker at repo root, holding the single key `voicePacksRoot` (#1143). Not a feature flag: it names a development voice root the plugin scans ahead of the user's packs folder, and it lands in `bin/config.json` as `devVoicePacksRoot` rather than anywhere under `features`. It is documented in this file because it is the same _kind_ of thing — a gitignored root-level marker the same three Rollup configs read at the same point, hashed by turbo the same way, and impossible for a release build to carry. See _`dev.local.json` — the development voice root_ below.
- `dev.local.json.example` — committed example showing the file shape.

## Flag categories

`platform-features.json` has a single top-level `features` object (the former `capabilities` object — `svgFilters`/`svgMasks`/`svgPatterns` — was retired in #642 along with `borderGlow`; PNG rasterization means no code branches on raw SVG engine capability anymore). Current flags:

- `dialFeedback` — Stream Deck+ touch-strip feedback + touch-tap input (Elgato-only; Mirabox/Ulanzi have no plugin touch strip). Elgato `true`, Mirabox `false`, Ulanzi `false`.
- `pngRasterization` — temporary kill-switch for in-plugin PNG rasterization (`@iracedeck/rasterizer`, issue #642). Gates a single call site: `initializeRasterizer(...)` in each plugin's `plugin.ts` (see `.claude/rules/plugin-structure.md`). `true` on Elgato, Mirabox, **and** Ulanzi — it isn't a per-platform capability split like `dialFeedback`, it's a temporary escape hatch for the whole rasterization pipeline. Force it `false` locally to fall back to raw SVG data URIs for comparison/debugging (see `.claude/rules/svg-platform-compatibility.md` for what that fallback means for filter/mask/pattern icons).
- `profiles` — the "Stream Deck Profiles" PI accordion (bundled-profile install buttons) plus profile switching (Race Admin car selector, Camera Focus's `focus-select-car` mode). Elgato-only — Mirabox/Ulanzi hosts have no profile system, so `switchToProfile` is a no-op there regardless of the flag. Elgato `true`, Mirabox `false`, Ulanzi `false`. See `.claude/rules/profiles-and-devices.md`. Unlike `dialFeedback`/`pngRasterization`, `profiles` has **no compile-time constant** — see "Runtime-only flags" below.

  > **Note.** There is no dial long-press flag. Dial press / long-press / push+turn are classified at `dialUp` by a duration comparison (`classifyDialRelease` in `packages/deck-core/src/dial-gesture.ts`), with no `setTimeout` to gate, so they work cross-platform with no feature flag. The former `dialLongPress` / `__FEATURE_DIAL_LONG_PRESS__` flag has been removed.

## How flags reach runtime + PI

All three plugins' `rollup.config.mjs`:

1. Read their `platform-features.json`.
2. If `feature-flags.local.json` exists at the repo root, deep-merge it on top.
3. Feed the merged object to three consumers:
   - `@rollup/plugin-replace` — injects `__FEATURE_DIAL_FEEDBACK__` and `__FEATURE_PNG_RASTERIZATION__` as JSON-stringified boolean literals. Terser then tree-shakes the dead branches. `profiles` is **not** in this list — it has no compile-time constant (see "Runtime-only flags" below).
   - `emit-plugin-config` — writes the merged object as `featureFlags` in `/bin/config.json` (readable via `getFeatureFlag()` / `getPlatformFeatures()`). This is the **only** runtime path for `profiles`.
   - `piTemplatePlugin` — passes the object to EJS render context as `platform` (and `locals.platform`). All three flags, including `profiles`, reach PI templates this way.

## Using a flag in code

`dialFeedback` and `pngRasterization` are declared as ambient globals in **each plugin's own** `src/platform-features.d.ts` (mirroring `src/svg.d.ts`) — there is no longer a shared `icon-composer`-level declaration file, because no icon-rendering code branches on a flag anymore (border glow is unconditional since #642; see `packages/icon-composer/CLAUDE.md`). Reference the `__FEATURE_*__` constant directly:

```ts
// packages/iracing-plugin-stream-deck/src/plugin.ts
if (__FEATURE_PNG_RASTERIZATION__) {
  initializeRasterizer(
    createSvgRasterizer({ fontsDir: join(__binDir, "..", "assets", "fonts") }),
    adapter.createLogger("Rasterizer"),
  );
}
```

`__FEATURE_PNG_RASTERIZATION__` gates exactly that one call site, in each plugin's own `plugin.ts`. When the flag is `false`, `initializeRasterizer()` is never called, `deck-core`'s rasterizer service stays uninitialized, and its `toDeviceImage()` passes every image through unchanged (see `packages/deck-core/src/rasterizer-service.ts`) — so every adapter's `setImage`/`setFeedback` call falls back to sending the raw SVG data URI exactly as before #642.

**Dial touch-strip gating.** `__FEATURE_DIAL_FEEDBACK__` is gated directly in action code (not a shared utility) because the per-platform touch-strip difference is action logic, not shared rendering: an action calls it directly (touch-strip feedback + touch-tap, Elgato-only) because Mirabox/Ulanzi have no plugin touch strip. Dial press / long-press / push+turn are **not** gated — they are classified at `dialUp` and work cross-platform. Reference: `packages/iracing-actions/src/actions/fuel-service/fuel-dial-surface.ts`. See `.claude/rules/encoders-and-touchscreen.md` for why.

**Per-plugin ambient declarations for bundled action sources.** The shared `@iracedeck/iracing-actions` sources are compiled as part of each plugin's TypeScript program, so `__FEATURE_DIAL_FEEDBACK__` must be declared there too — that's why each plugin's own `src/platform-features.d.ts` declares both constants even though `__FEATURE_PNG_RASTERIZATION__` is only ever referenced in that plugin's own `plugin.ts`, not in the bundled action sources.

**Runtime-only flags.** `profiles` has no ambient declaration and no `__FEATURE_*__` constant — it's checked at runtime instead, either via `getFeatureFlag("profiles")` (TS) or `locals.platform?.features?.profiles` (PI templates, see below). This is a deliberate choice, not an oversight: `profiles` gates a PI accordion and a couple of conditional PI sections, none of which are hot enough to need tree-shaking, so there was no reason to also thread it through `@rollup/plugin-replace` and a per-plugin `.d.ts`.

## Using a flag in PI templates

`pngRasterization` gates no PI content (it gates a single plugin-startup call, not any rendering or control). `dialFeedback` and `profiles` both have PI-visible effects — gate `sdpi-item` controls and any related JS in the shared partial:

```ejs
<% var dialFeedbackEnabled = (locals.platform?.features?.dialFeedback !== false); %>
<% if (dialFeedbackEnabled) { %>
  <sdpi-item id="some-touch-strip-control" class="hidden" label="Touch Strip Behavior">...</sdpi-item>
<% } %>
```

`profiles` gates the "Stream Deck Profiles" accordion (`global-stream-deck-profiles.ejs`) and the Race Admin / Camera Focus car-selector sections the same way — `locals.platform?.features?.profiles !== false`.

The `!== false` check makes the default-enabled behavior explicit: when a caller doesn't set `platformFeatures` (e.g., tests), the control still renders.

## Runtime access (rare)

Most code should use the compile-time constants. If a runtime check is genuinely needed — and it's the **only** option for `profiles`, since it has no compile-time constant:

```ts
import { getFeatureFlag, getPlatformFeatures } from "@iracedeck/deck-core";

if (getFeatureFlag("pngRasterization") === true) {
  /* ... */
}
if (getFeatureFlag("profiles") === true) {
  /* ... */
}
const all = getPlatformFeatures(); // full object or undefined
```

Runtime checks don't participate in tree-shaking — prefer the compile-time constants when the decision can be made at build time (not an option for `profiles`).

## Testing

Root `test-setup.ts` sets `globalThis.__FEATURE_DIAL_FEEDBACK__ = true` and `globalThis.__FEATURE_PNG_RASTERIZATION__ = true` so tests see the defaults. Cover both paths with `vi.stubGlobal`:

```ts
afterEach(() => vi.unstubAllGlobals());

it("skips the touch strip when dialFeedback is false", () => {
  vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
  // ... assertion
});
```

`profiles` has no global to stub — it's runtime-only, so tests mock `getFeatureFlag`/`getPlatformFeatures` from `@iracedeck/deck-core` (or pass `platformFeatures`/`locals.platform` directly) instead of `vi.stubGlobal`.

## Adding a new flag

1. Add to all three `platform-features.json` files under `features` (enabled/disabled per platform).
2. Add its key to `PlatformFeatureFlags` in `packages/deck-core/src/plugin-config.ts`.
3. Decide whether it needs a compile-time constant. Most flags do:
   - Add the `__FEATURE_*__` ambient declaration to each of the three plugins' own `src/platform-features.d.ts` (so both plugin-only code and the bundled `@iracedeck/iracing-actions` sources see it — see "Per-plugin ambient declarations" above).
   - Add the replace entry to **all three** `rollup.config.mjs` files.
   - Add default to `test-setup.ts` and true/false path tests that `vi.stubGlobal` the constant.
   - A flag that only gates a PI control or a rarely-hit runtime branch (like `profiles`) can skip all three of the above and read `getFeatureFlag(...)` / `locals.platform?.features?.…` instead — see "Runtime-only flags" above.
4. Gate the relevant code (plugin init, `deck-core`, or an action file for a per-platform behavioral difference) and any relevant PI partial.
5. Update the example file (`feature-flags.local.json.example`).

## Watch mode caveat

Rollup loads each plugin config module **once per watcher session**, so the resolved `platformFeatures` object is captured at watcher startup and held for the lifetime of the watcher. Consequences:

- Creating `feature-flags.local.json` while a watcher is running: the file isn't in the watch set yet, and even once a rebuild is triggered by some other change, the resolved flags are still the ones from startup.
- Editing an existing `platform-features.json` or `feature-flags.local.json` while a watcher is running: a rebuild fires (the file is in the watch set), but it uses the flags captured at startup — the edit won't affect the output.

**Always restart the watcher after changing any flag file.** This is a deliberate trade-off: refreshing the flags on every rebuild would require either reinstantiating `@rollup/plugin-replace` (not possible mid-watch) or threading mutable state through `replace`, `piTemplatePlugin`, and `emit-plugin-config`, which adds complexity for a scenario that's already covered by a one-line restart.

## Local override round-trip

```bash
# Force pngRasterization off on this machine (falls back to raw SVG data URIs):
cat > feature-flags.local.json <<'EOF'
{ "features": { "pngRasterization": false } }
EOF
pnpm build

# Verify bundle (the `if (__FEATURE_PNG_RASTERIZATION__) { initializeRasterizer(...) }`
# block in plugin.ts is dead code once the constant is replaced with `false`,
# so terser drops the call entirely):
grep -c "initializeRasterizer(" packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/bin/plugin.js  # -> 0

# pngRasterization gates no PI template content (it only guards one plugin-startup
# call), so there's no PI HTML to check — unlike the retired borderGlow flag.

# Runtime sanity check: the rasterizer service never initializes, so every
# setImage/setFeedback call falls back to sending the SVG data URI unchanged
# (see packages/deck-core/src/rasterizer-service.ts toDeviceImage()). Launch
# the plugin and confirm keys still render — there is no PNG-specific log line
# to grep for a pass/fail signal, only the absence of the "Rasterizer service
# initialized" info log.

# Revert:
rm feature-flags.local.json
pnpm build
```

## `dev.local.json` — the development voice root (#1143)

Since #1034 stage 3 no plugin bundles a voice: the Race Engineer plays the copy under `%LOCALAPPDATA%\iRaceDeck\Race Engineer\Voices\default`, and the launch step keeps that folder matching the published catalog — installing it when it is missing, replacing a folder whose provenance is absent or foreign, force-reinstalling one whose record survived while its clips did not. Every one of those rules exists so a user's engineer works, and every one of them fights the person editing the voice. So a repo developer points the plugin at the packer's staged output instead, with a gitignored `dev.local.json` at the repo root holding exactly one key:

```json
{ "voicePacksRoot": "packages/audio-assets/dist/voice-packs" }
```

`scripts/lib/dev-local.mjs` reads it — the sibling of the `feature-flags.local.json` read, and deliberately stricter: an unknown key **throws** instead of being warned about and ignored, because a typo that silently leaves development mode off is a failure a developer chases in the sim rather than in the build log. A relative `voicePacksRoot` resolves against the repo root. Each plugin's `rollup.config.mjs` writes the resolved absolute path into `bin/config.json` as `devVoicePacksRoot`, through a **conditional spread** so the key is absent rather than `undefined` when there is no file, and `getDevVoicePacksRoot()` (`packages/deck-core/src/plugin-config.ts`) is how the plugin reads it back. **A release build cannot carry the mechanism** — the file is never in git, so a tag has nothing to read — and the marker dies with the worktree that wrote it.

What the plugin does with it, gathered here so it need not be pieced back together from four modules:

- **The scanner reads that root first.** `scanVoicePacks({ root, devRoot })` visits `devRoot` before the packs root and shares one `claimedVoices` map across both, so a pack found there claims its voice ids ahead of every pack in AppData — the `priorityPacks` rule of #1034 stage 3 generalised from one pack first to one root first. A pack under the packs root that loses gets a `problems` row naming the development pack that took its voice; nothing is deleted. **The SAME pack id under both roots is a different case and is shadowed whole**: the packs-root folder is skipped before its manifest is read, with one pack-level reason (`pack "<folder>" is provided by the development build; the copy under the packs root is ignored`). Per-voice would leave the AppData copy alive on any voice the dev copy had not claimed, and two `packs` rows sharing one id are ambiguous to every consumer of the list — all of them key by id. Shadowing is keyed on a dev pack the scan actually LISTED, so a half-staged dev folder silences nothing.
- **`development` is a provenance no folder can claim.** It is assigned from the root a pack was found under, never read from a record — the on-disk source enum in `voice-pack-provenance.ts` has no such value to write — and the scanner does not read a provenance record under the dev root at all.
- **The launch step leaves those packs alone.** `isProvidedByDevRoot(id)` (answered off the last scan, so an emptied dev root resumes the ensure) drops a dev-provided pack from the targets, the force-reinstall path included; every other pack still updates, which is what testing an update path needs. **The catalog card reads the same answer**: `createVoicePackCatalogService`'s optional `isProvidedByDevRoot` dep gives a dev-provided pack the verdict `installed`, right after the bundled-pack branch and for the same reasons — the voice is on this machine and plays, and offering Install would spend megabytes on a folder the next scan shadows whole. The step logs the parameter-free `Voice packs: development root active` once per start, path at debug, ahead of every other voice-pack line — that is what a developer who forgot the mode is on reads instead of hunting for an absence.
- **The settings window says so too.** The Installed Voices row badges _Development build_ and shows the pack's directory in place of a Remove button: the plugin never deletes from a directory it did not create, and the directory is what tells two clones of the repo apart. `_voicePacks` rows carry `dir`, and `managed` is false for such a pack — see `@.claude/rules/settings-window.md` item 6.
- **A missing or empty development root warns once per run**, not once per scan — **Rescan voices** is the loop, and a root still empty on the fifth press is not five pieces of news — and the scan continues against the packs root as normal, so the plugin stays fully usable.
- **A development root that IS the packs folder is refused**, warned about once per run and scanned as if there were none. Nothing else rejects it and the damage is quiet and total: every pack is scanned twice, the second copy loses every voice to the first, so every row reads _Development build_, loses its Remove button and drops out of the launch ensure — `default` included. The two paths are compared `resolve`d and lower-cased.
- **A development root that yields no usable pack warns on EVERY scan**, naming the folders it could not use at debug. Unlike the two above it reports what is on disk rather than a build-time value, and a Rescan is exactly when the developer is looking: a `callouts.json` that stopped parsing drops every voice, the AppData copy wins in silence and the row flips back to _Downloaded_, which is indistinguishable from an edit that had no effect.

Turbo hashes the marker: `$TURBO_ROOT$/dev.local.json` and `$TURBO_ROOT$/scripts/lib/dev-local.mjs` are `inputs` on all three plugin `#build` tasks, so toggling development mode is never served a stale plugin folder from the cache and needs no `--force`. The watch-mode caveat above applies unchanged — a Rollup config module is loaded once per watcher session, so restart the watcher after writing or removing the file.

### The loop

```bash
pnpm dev:voices on     # once per worktree: writes dev.local.json, rebuilds the three plugins, relinks the hosts linked to THIS worktree
# edit clips, or configs/<voice-id>.voice.json
pnpm --filter @iracedeck/audio-assets pack:voice default --no-catalog
# press "Rescan voices" in iRaceDeck Settings, then drive
pnpm dev:voices off    # before testing the real download path
```

`--no-catalog` stages and zips without rewriting the committed `catalog/<id>.json`. That entry is the release contract — its `sha256` is what the installer compares an installed pack against — so a run whose only purpose is a staged tree must not touch it. The flag is per run, not a mode: the release workflow keeps calling `pack:voice` without it.

`pnpm dev:voices off` removes the marker and rebuilds and relinks the same way — the rebuild is not optional in either direction, since the key lives in built output and nothing changes in-game until the plugin folder is rewritten. Because the rebuild is what carries the marker into `bin/config.json`, **the marker change is transactional**: the previous state of the file is captured before it is touched and restored if the build fails, so the two can never disagree. They would otherwise disagree exactly when it is hardest to notice — a deck host linked to this worktree locks `iracing_native.node` and the build fails with EPERM, leaving a `dev.local.json` that says development mode is on while all three plugin folders say it is off, with no reader anywhere able to see the difference (every one of them reads the built config). The same reason is why the script names the hosts linked to this worktree BEFORE the build, as the ones that must not be running. Two more things the switch deliberately will not do: it never **overwrites** an existing `dev.local.json` (a `voicePacksRoot` you pointed somewhere by hand is kept and reported — picking a root yourself is what the file is for — and any other content fails the run rather than being replaced), and it never relinks a host whose link points at **another** worktree, which it reports and leaves alone, because relinking would switch somebody else's test environment underneath them. Mirabox and Ulanzi read their plugins directory at start only, so the script prints the `stop:` / `start:` pair for whichever of them it relinked. `switch-test-env` and the `relink:*` scripts never read or write the marker at all, so testing the real download path stays an explicit choice rather than something a relink switches off by accident. `scripts/dev-voice-root-guard.test.mjs` is what holds the three build-time properties up — the marker is gitignored, every plugin emits the key only through the conditional spread, and every plugin build task hashes the marker — discovering the plugin list from the committed manifests, so a fourth deck ecosystem is covered the day its package appears. Those are properties of the SOURCE, and a maintainer packing from a worktree with development mode on is a different question, so **`node scripts/assert-release-build.mjs <bin/config.json>` is the first step of every plugin's `pack:plugin` script**: it exits 1, naming the key, the file and `pnpm dev:voices off`, when the built folder about to be packed carries `devVoicePacksRoot` — presence, never value, since the key only ever arrives through that conditional spread. The same guard test pins the wiring.

## Related files

- `@.claude/rules/svg-platform-compatibility.md` — resvg's SVG support baseline and the `pngRasterization` kill-switch caveat.
- `packages/rasterizer/src/index.ts` — `createSvgRasterizer()`, the `@resvg/resvg-js` wrapper injected by each plugin.
- `packages/deck-core/src/rasterizer-service.ts` — `initializeRasterizer()`, `isRasterizerInitialized()`, `toDeviceImage()` (LRU cache, supersede guard, SVG fallback on render error).
- `packages/deck-core/src/plugin-config.ts` — `PluginConfig`, `PlatformFeatureFlags`, `getFeatureFlag`, `getPlatformFeatures`, `getDevVoicePacksRoot`.
- `.claude/rules/plugin-structure.md` — the `initializeRasterizer` step in the `plugin.ts` init order.
- `.claude/rules/profiles-and-devices.md` — the `profiles` flag's PI accordion and Elgato-only rationale in full.
- `scripts/lib/dev-local.mjs` — `readDevLocal()`, the strict reader for `dev.local.json`; `scripts/dev-voice-root-guard.test.mjs` is the guard that keeps the marker build-time only.
- `packages/deck-core/src/voice-pack-scanner.ts` / `voice-pack-service.ts` / `voice-pack-launch.ts` — the `devRoot` scan order, the `development` provenance, and the ensure skip.
- `@.claude/rules/race-engineer-callouts.md` §11 — the same loop stated where a callout change is verified.
