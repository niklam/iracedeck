---
paths:
  - "packages/website/src/**"
  - "scripts/lib/settings-window-capture/**"
  - "scripts/capture-settings-window.mjs"
---

# Website Screenshots

The website's only screenshots today are the Settings window's tabs (issue #1010). They are **generated, not hand-captured** — treat them as build output that happens to be committed, like `packages/icons/preview/`.

## Regenerating

```bash
pnpm build             # the harness reads the plugin's built ui/ folder
pnpm capture:settings  # writes packages/website/src/assets/settings-window/*.png
```

Run it whenever the window's layout, controls or copy change — including a `changelog.mdx` edit, which the What's New tab now renders directly (#1011). A stale screenshot is worse than none: it teaches a reader a UI that no longer exists.

`--scale=2` captures at HiDPI. The default is `1` (≈490 KB for all nine); 2× roughly quadruples that, which is why it isn't the default.

## Why a harness rather than hand-captured images

Three properties a manual screenshot can't give:

- **Deterministic.** The capture serves a fixed settings fixture (`scripts/lib/settings-window-capture/seed.mjs`), so reruns differ only where the UI actually changed — bar the two build-dependent elements in rule 4. Hand-captured shots differ on every unrelated detail, which makes review impossible.
- **Private.** A screenshot of a real install publishes that person's key bindings, audio devices and settings path. The fixture uses a fake `C:\Users\Driver\…` path and invented bindings.
- **Honest.** The page is served by the real `startSettingsWindowServer` against the real built `ui/` folder, so what's captured is what ships — not a static shell whose controls never populated.

## Rules

1. **Capture from the Stream Deck plugin build.** The Profiles tab only renders where the `profiles` platform flag is on, so a Mirabox or Ulanzi build is missing a tab. The harness hard-codes the Stream Deck `ui/` path for this reason.
2. **Never hand-edit the PNGs**, and never crop or annotate them. Change the seed or the page and recapture.
3. **Add a tab → add it to `SETTINGS_WINDOW_TABS`** in `scripts/lib/settings-window-capture/tabs.mjs`, recapture, and write the matching `###` section on `docs/getting-started/settings.md`. `tabs.test.mjs` fails until the list matches the built page, which is the automated nudge — the images themselves can't be diffed reliably across machines (fonts, GPU), so refreshing them stays a deliberate act.
4. **One element is not byte-reproducible, by design.** The window header carries the **plugin version of the build it was captured from** (`v2.5.0-dev.0` in the current set), so it appears in all nine. Expected; don't chase it — but do recapture near a release so the version shown isn't from a stale dev build. (Before #1011 the What's New tab was a second such element: it embedded a live `iframe` of the published changelog. It now renders the notes the build ships, so that shot is reproducible — and stale whenever `changelog.mdx` changes, which is a reason to recapture, not an exception.)
5. **Alt text describes the tab**, not the act of screenshotting ("The General tab of the iRaceDeck Settings window", not "Screenshot of settings").
6. **Fractional number fields render in the machine’s locale, and that is accepted.** Chromium RENDERS an `<input type="number">` in the locale — so on a comma-decimal machine a fractional control is captured as `12,5` while the page's own prose beside it, and every reader on an English locale, says `12.5`. The Mouse to Sim vertical offset (default `12.5`) is the first such control on a visible part of a tab; the Race Engineer gap thresholds are the others. Only the DISPLAY is affected — the DOM value stays canonical, so this is never a bug in the plugin, only in the screenshot. It cannot be fixed from the harness: on Windows the format comes from the OS **regional format**, and neither `--lang=en-US` nor CDP `Emulation.setLocaleOverride` changes it (verified — ICU still resolves `en-FI`).

   **Decided 2026-08-30 (#1061): do not switch the regional format for a capture.** Niklas ruled the prose/image disparity not worth solving for now, so a capture runs on whatever format the machine has, and a comma in a captured fractional field (`12,5` in `general.png`, the Race Engineer gap thresholds) is expected rather than a defect to fix or a reason to withhold a recapture. The mechanics above are still true and still worth knowing; what changed is that we no longer act on them. The regional-format switch remains the only known lever if it ever becomes worth solving.

## Layout

| Path | What |
|------|------|
| `scripts/capture-settings-window.mjs` | Composition root: resolves the real server, browser and filesystem |
| `scripts/lib/settings-window-capture/tabs.mjs` | The tab list — one source of truth for harness, test and docs |
| `scripts/lib/settings-window-capture/seed.mjs` | The deterministic settings fixture |
| `scripts/lib/settings-window-capture/cdp.mjs` | Minimal DevTools Protocol client (no dependencies — Node's global `WebSocket`) |
| `scripts/lib/settings-window-capture/capture.mjs` | Orchestration; every collaborator injected, so it is testable without a browser |
| `packages/website/src/assets/settings-window/` | The committed PNGs |

The harness adds **no dependencies**: `startSettingsWindowServer` and `findChromiumBrowserOnThisMachine` are already exported from `@iracedeck/deck-core`, and Node 22+ ships a global `WebSocket`. It needs a Chromium-based browser on the machine — the same requirement the Settings window itself has.
