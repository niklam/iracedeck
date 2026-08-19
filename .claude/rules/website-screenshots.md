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

Run it whenever the window's layout, controls or copy change. A stale screenshot is worse than none: it teaches a reader a UI that no longer exists.

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
4. **Two elements are not byte-reproducible, by design.** The What's New tab embeds a live `iframe` of the published changelog, so that shot carries whatever the site served at capture time; and the window header carries the **plugin version of the build it was captured from** (`v2.5.0-dev.0` in the current set), so it appears in all nine. Expected; don't chase either — but do recapture near a release so the version shown isn't from a stale dev build.
5. **Alt text describes the tab**, not the act of screenshotting ("The General tab of the iRaceDeck Settings window", not "Screenshot of settings").

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
