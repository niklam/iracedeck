# Platform Feature Flags

Per-plugin build-time flags that gate platform-specific features and temporary kill-switches. `dialFeedback` strips touch-strip feedback/input code and PI controls from the Mirabox and Ulanzi bundles (neither has a plugin-facing touch strip) while keeping it on Stream Deck. `pngRasterization` is a temporary kill-switch for the in-plugin PNG rasterization pipeline (issue #642) — true on all three platforms today, so nothing is actually stripped by it yet; it exists to let the pipeline be disabled quickly (locally, or via a hotfix) if a rendering regression turns up. `profiles` gates the Stream Deck Profiles PI accordion and profile switching (Elgato-only; #736) and, unlike the other two, is a **runtime-only** flag — read via `getFeatureFlag("profiles")` / `locals.platform`, with no `__FEATURE_*__` compile-time constant (see "Runtime-only flags" below). Since #642 retired the `borderGlow`/`svgFilters`-class flags (icons rasterize to PNG in-plugin now, so QT5-vs-QT6 SVG engine capability is no longer a build-time concern — see `.claude/rules/svg-platform-compatibility.md`), these three are what's left.

## Layout

- `packages/iracing-plugin-stream-deck/platform-features.json` — committed Stream Deck flags (all true by default).
- `packages/iracing-plugin-mirabox/platform-features.json` — committed Mirabox flags (QT5-incompatible features off).
- `packages/iracing-plugin-ulanzi/platform-features.json` — committed Ulanzi flags. Kept at the Mirabox conservative baseline (filters/masks/patterns off): basic SVG data-URI icons are confirmed to render in UlanziDeck (issue #508), but filters/masks/patterns haven't been exercised — widen a flag only once that feature is confirmed on Ulanzi.
- `feature-flags.local.json` — **optional, gitignored** developer override at repo root. Deep-merges over every plugin's committed flags at build time.
- `feature-flags.local.json.example` — committed example showing the file shape.

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

if (getFeatureFlag("pngRasterization") === true) { /* ... */ }
if (getFeatureFlag("profiles") === true) { /* ... */ }
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

## Related files

- `@.claude/rules/svg-platform-compatibility.md` — resvg's SVG support baseline and the `pngRasterization` kill-switch caveat.
- `packages/rasterizer/src/index.ts` — `createSvgRasterizer()`, the `@resvg/resvg-js` wrapper injected by each plugin.
- `packages/deck-core/src/rasterizer-service.ts` — `initializeRasterizer()`, `isRasterizerInitialized()`, `toDeviceImage()` (LRU cache, supersede guard, SVG fallback on render error).
- `packages/deck-core/src/plugin-config.ts` — `PluginConfig`, `PlatformFeatureFlags`, `getFeatureFlag`, `getPlatformFeatures`.
- `.claude/rules/plugin-structure.md` — the `initializeRasterizer` step in the `plugin.ts` init order.
- `.claude/rules/profiles-and-devices.md` — the `profiles` flag's PI accordion and Elgato-only rationale in full.
