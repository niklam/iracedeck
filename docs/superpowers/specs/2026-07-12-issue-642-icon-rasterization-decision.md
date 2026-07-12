# Icon rasterization decision (#642) — GO, with `@resvg/resvg-js`

**Decision: GO.** iRaceDeck should rasterize key/dial icons to PNG itself and send finished pixels to every host, instead of shipping SVG data URIs for three different device renderers to draw. Chosen library: **`@resvg/resvg-js`** for painting, paired with a **build-time font-metrics table** (pure-TS text measurement/fitting, no runtime font library). Sharp is the documented fallback if the full icon sweep surfaces a resvg rendering gap.

Spike environment: Windows 11, Node v24.15.0, dev machine, 2026-07-12. Libraries: `sharp` 0.35.3 (libvips 8.18.3), `@resvg/resvg-js` 2.6.2, `fontkit` 2.0.4 (measurement experiment only). Benchmark icon: a realistic assembled 144×144 key — background rect, border with `feGaussianBlur` glow (a feature QT5 silently drops today), artwork paths, two-line Arial-bold title. Spike scripts were throwaway (scratchpad, not committed), per the issue's "no production changes" constraint.

Maintainer decisions taken during discovery (Niklas, 2026-07-12): **PNG on all devices** (no per-platform split); **rasterize at each device's native resolution** (also the answer to Mirabox/Ulanzi quality concerns); package size is **not** a blocking concern (Race Engineer audio already puts the plugin at ~7 MB); production is **Windows-only** (iRacing), so no mock addon is required.

## 1. What self-rasterization unlocks

- **One renderer, one output.** Today the same SVG is drawn by QT6.7+ (Elgato), QT5 (Mirabox), and an unverified engine (UlanziStudio, only basic SVG exercised — #508). The weakest engine sets the ceiling for every icon. With PNG, hosts just blit pixels: the whole `svg-platform-compatibility.md` restriction matrix, the `borderGlow` feature flag and its tree-shaking machinery, and the conservative Ulanzi capability flags can be retired.
- **QT5-blocked features become universal.** Filters (glow verified in the spike — both libraries rendered `feGaussianBlur` pixel-equivalently; PNG is platform-independent, so rendering once proves both device platforms), masks, patterns, and even `clipPath` (broken on _both_ QT engines today).
- **Deterministic fonts.** All title text is `font-family="Arial, sans-serif"` resolved by whatever font stack the user's machine has, and both QT engines ignore `dominant-baseline` (hence the `+0.36em` centering hack). Bundling font files with the plugin gives identical glyphs and metrics on every machine, plus real text measurement (see §7) — the multi-line-title control Elgato declined to provide natively.
- **Pixel-snapshot testing.** Rendering finally happens in our process, so what users see becomes unit-testable (PNG comparison in CI). Today it is untestable by construction.
- **Native-resolution output.** Each device gets pixels at its exact key/strip size instead of three hosts downscaling SVG differently — this _removes_ scaling variance. It also cleanly serves the Mirabox dial screen, whose aspect ratio differs from the Elgato 200×100 strip slot (the redesign of what to draw there is its own task; PNG just makes the output exact).
- It is the substrate for the richer-key direction Elgato is signalling (stateful images, Lottie/Rive) — all of those end in raster frames.

## 2. What it costs (measured)

Production footprint on Windows x64 — everything is prebuilt and vendored into `bin/node_modules/`; nothing compiles or installs on the user's machine:

|                   | Installed   | Zipped (added to distribution) | Shape                                                                                    |
| ----------------- | ----------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| `@resvg/resvg-js` | **4.5 MB**  | **~1.9 MB**                    | one `.node` file, zero JS deps                                                           |
| `sharp`           | **20.1 MB** | **~8.3 MB**                    | `libvips-42.dll` 18.0 MB + 0.4 MB `.node` + 1.2 MB JS (`sharp`, `semver`, `detect-libc`) |

For Sharp, what is _not_ needed: every other `@img/sharp-<platform>` package (npm `optionalDependencies`, only the matching platform installs), no compiler, no system libraries. The 18 MB DLL is indivisible — libvips statically bundles librsvg, pango/fontconfig, and codecs we would never use (TIFF, WebP, HEIF, JXL); slimming it means maintaining a custom libvips build.

Distribution impact: plugin zip ~7 MB → ~9 MB (resvg) or ~15.3 MB (sharp). Per-plugin `bin/node_modules/` grows by the installed size, once per installed plugin.

Cross-platform dev story: **no mock is needed at all** — unlike `iracing-native`/`audio-native`, both libraries ship macOS/Linux prebuilds, so the existing macOS dev/test path (`cross-platform-development` skill) keeps working for free. Rollup treats the library as `external` and the emitted `package.json` carries it as a dependency, same pattern as `keysender` (`plugin-structure.md`).

## 3. Runtime performance (measured)

Correction to the issue text: the real dynamic cadence is **10 Hz per key/dial**, not 4 Hz — the `IconUpdateThrottle` (#493) caps per-key updates at 10 Hz off a ~70 Hz SDK tick, and the dial surfaces throttle to the same 100 ms.

Warm render of the full assembled icon (200 iterations; cold = first call):

|                                 | Cold   | Warm avg @144px | p99 @144 | Warm avg @288px | PNG out @144 |
| ------------------------------- | ------ | --------------- | -------- | --------------- | ------------ |
| sharp                           | 595 ms | 2.52 ms         | 4.4 ms   | 4.94 ms         | 7.0 KB       |
| resvg (bundled `fontDirs`)      | 3.9 ms | **2.86 ms**     | 3.1 ms   | 8.17 ms         | 7.5 KB       |
| resvg (`loadSystemFonts: true`) | —      | **127.8 ms**    | 143 ms   | —               | —            |

Budget check: the pathological case (32 keys all visually changing every 100 ms) is ~32 × 10 × 3 ms ≈ one saturated core — and both libraries render off the JS thread (`sharp` is async-native on the libuv threadpool; resvg has `renderAsync`), so even that leaves the event loop free. Realistic decks (a handful of fast keys, state-key caching already gating re-renders) land at single-digit % CPU. Static icons render once and cache exactly as today. **10 Hz at native device resolution is comfortably affordable.**

Two resvg pitfalls found (both must be encoded in the implementation):

- **`loadSystemFonts: true` rescans the system font directory on every `Resvg` construction** (~128 ms/render). Always `loadSystemFonts: false` + bundled `fontDirs`.
- **The `fontFiles` option silently fails** (text vanishes from the output). Use `fontDirs` (a directory of bundled fonts) instead.

Sharp's 595 ms cold start is one-time and acceptable, but fontconfig's first-ever-run cache build on end-user machines is a known Sharp text wart with no resvg equivalent — one more reason resvg is the safer default.

## 4. Vector vs raster trade-offs

- **Resolution.** SVG scales for free; PNG makes resolution our problem — and per the maintainer decision we make it an asset by rendering at each device's true pixel size. Requires a device→resolution map: `device-profiles.ts` already carries the Elgato device-type side; Mirabox/Ulanzi registration handshakes carry device info, but the actual per-model key/knob-screen pixel sizes must be verified on hardware (follow-up).
- **Payload.** PNG is ~6× the SVG data URI (7.5 KB vs 1.2 KB for the benchmark icon) — irrelevant at these sizes, including over the Mirabox/Ulanzi WebSockets at 10 Hz.
- **Round-trip.** Our ~758 icons deliberately use the minimal SVG Tiny subset, which resvg (a spec-accuracy-focused renderer) covers trivially; the win is what becomes _newly_ allowed (§1). A full-set pixel sweep against current QT output is a pre-landing verification step, not a decision blocker.
- **Dial strip.** The Fuel Service dial already draws its slot as one full-canvas pixmap; with self-rasterization we emit exactly 200×100 (Elgato) or the Mirabox knob-screen size — no viewBox gymnastics.

## 5. Library choice — why resvg over Sharp

|                                | `@resvg/resvg-js` 2.6.2                                        | `sharp` 0.35.3                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Job fit                        | purpose-built SVG→PNG                                          | general raster toolbox (SVG via bundled librsvg)                                                                                                                                           |
| Warm render @144px             | 2.86 ms                                                        | 2.52 ms (par)                                                                                                                                                                              |
| Footprint (installed / zipped) | 4.5 / 1.9 MB                                                   | 20.1 / 8.3 MB                                                                                                                                                                              |
| Bundled-font story             | explicit `fontDirs` + `defaultFontFamily`, fully deterministic | SVG `<text>` goes through fontconfig — custom bundled fonts need `FONTCONFIG_PATH` + `fonts.conf`; only the separate Pango text-creator input takes `fontfile` directly (verified working) |
| Text fitting                   | `getBBox()` measurement primitive; fit logic is our code       | built-in Pango box-fit: auto wrap + auto size + markup, 12.6 ms warm; but no max-lines/ellipsis control, and output is a separate raster to composite                                      |
| Cold start                     | ~4 ms                                                          | 595 ms + fontconfig first-run cache risk                                                                                                                                                   |
| Prebuilds                      | win32/darwin/linux, single file                                | win32/darwin/linux via `@img/*` packages                                                                                                                                                   |
| Maintenance                    | smaller project (we hit the `fontFiles` bug)                   | one of npm's most-depended-on packages                                                                                                                                                     |

The deciding argument: with the build-time font-metrics approach (§7), text _fitting_ leaves the rasterizer entirely — Sharp's Pango autofit, its one genuinely superior capability, goes unused, because we want iRaceDeck-opinionated title policy (user font-size overrides, locked title fields, two-line conventions, future max-lines/ellipsis) that Pango's black-box autofit cannot express anyway. What remains is painting, where resvg is equal-speed, 4× smaller, deterministic about fonts, and free of fontconfig. Sharp stays the documented fallback: if the icon sweep reveals a resvg gap, or a future feature needs raster compositing/encoding, the seam (§6) makes swapping painters cheap.

## 6. Migration shape

Everything already funnels through one seam: `assembleIcon()` → `svgToDataUri()` (`icon-composer/src/svg-utils.ts`) → `BaseAction.setKeyImage()` → adapter `setImage(dataUri)` — the Mirabox adapter just forwards the string. The change inserts "SVG → resvg → PNG data URI" behind that seam with **zero action-code changes**:

- A rasterizer service in `deck-core` (initialized from each plugin's `plugin.ts` like the keyboard service, so `deck-core` stays dependency-free; `@resvg/resvg-js` marked `external` in each plugin's Rollup config and vendored into `bin/node_modules/`, the `keysender` pattern).
- Icon _composition_ stays SVG (Mustache templates, `assembleIcon`, overlays like the #612 binding-missing glyph are untouched); only the final paint changes.
- The render call sites (`setKeyImage`, the dial pixmap path) become async-aware and pass the target pixel size from the device-resolution map.
- **All devices at once** (maintainer decision) — a per-platform split would forfeit the simplification payoff in §1. Static and dynamic icons go together (same code path; static icons keep today's render-once caching, now caching PNG).

Pre-landing verification checklist:

- [ ] PNG data URIs accepted through `setImage` on real hardware for all three hosts (Elgato certain; Mirabox/Ulanzi near-certain — their own stock icons are raster — but verify).
- [ ] Device-resolution map values confirmed per device model (Elgato from SDK device info; Mirabox 293/293s/N4 and Ulanzi D200/D200H/Dial/D200X key + knob-screen sizes on hardware).
- [ ] Full ~758-icon sweep: resvg output pixel-diffed against current QT renders; every diff triaged (expected improvements vs regressions).
- [ ] Font-metrics table agreement test: computed advance widths vs resvg-rendered extents across the title corpus (spike saw ≤2 px, ink-box vs advance).
- [ ] 10 Hz soak on real hardware with a full page of telemetry keys.

## 7. Text measurement & fitting — build-time font metrics (no runtime font lib)

A font file already contains per-glyph advance widths (Arial Bold: 2048 units/em), kerning pairs, and ascent/descent. Text width at size S = (Σ advances + kerning) ÷ 2048 × S — pure arithmetic. Spike numbers (fontkit 2.0.4): parsing `arialbd.ttf` takes 0.9 ms; each measurement ~15 µs; advances scale perfectly linearly with font size, so "fit into 132 px" is **one division** (verified exact: computed 11.65 px → renders 132.00 px), not a search.

Because of that linearity there is nothing per-font-size to cache — one width-at-1em per string covers every size. So the cache is a **per-character advance table + kerning pairs for our charset** (~100 chars, a few KB), and it is generated at **build time**, matching the existing generator pattern (`generate-icon-defaults.mjs`, `generate:action-comms`): a script reads the bundled font files, emits `font-metrics.json`, and a freshness test guards it against font drift. Runtime measurement is then a ~20-line pure-TS summation — no fontkit in production, no startup cost, unit-testable with plain Vitest.

Numeric readouts get a bonus: **all ten Arial-Bold digits share one advance (1139 units, no inter-digit kerning)** — "5432" and "2345" are both exactly 40.04 px @18 px. A field like RPM only changes width when the digit _count_ changes; sizing the field once for the maximum expected digits means zero layout recomputation and zero visual jitter at runtime.

Caveats: table summation is exact for the Latin+digits title vocabulary but is not full text shaping (revisit if titles ever need Arabic-class scripts); user-typed title text can contain out-of-table characters, which needs a fallback advance (or a one-off `getBBox()` measure for exotic input).

## 8. Follow-up issues (proposed)

1. **Rasterizer service + resvg vendoring** — `deck-core` service behind the `setKeyImage`/dial-pixmap seam; Rollup `external` + `bin/node_modules` packaging in all three plugins; async render path; PNG caching for static icons.
2. **Device-resolution map** — extend the `device-profiles.ts` data with per-model pixel sizes for Elgato, Mirabox, and Ulanzi (hardware-verified); render at native resolution, including dial/knob screens.
3. **Build-time font metrics + bundled fonts** — pick and license the bundled font, `font-metrics.json` generator + freshness test, pure-TS measure/fit module, replace the `+0.36em`/`calculateYPositions` heuristics with real metrics.
4. **Auto-fit multi-line titles** — the user-facing feature that motivated the original Elgato request, built on (3): wrap + fit policy with max-lines/min-size/user-override rules.
5. **Retire the QT5 ceiling** — remove `borderGlow`/`svgFilters`-class feature flags and their `platform-features.d.ts` plumbing, rewrite `svg-platform-compatibility.md` as a resvg authoring guide, widen the Ulanzi capability baseline, enable glow/masks/`clipPath` where icons want them.
6. **Icon sweep harness** — one-time pixel-diff tooling for the pre-landing checklist in §6 (can live inside issue 1).
