# PI Documentation Link Design

**Issue:** #191
**Date:** 2026-03-27

## Context

Users configuring actions in the Property Inspector have no quick way to access the full documentation for that action on iracedeck.com. They must navigate the website manually. Adding a "Documentation" link at the bottom of every PI template — above the version footer from #190 — gives users one-click access to the relevant docs page.

## Design

### Layout

```text
        Documentation
─────────────────────────
         v1.8.0
```

- "Documentation" is a centered link opening the action's specific docs page in the system browser
- Placed above the version divider (from #190)
- Styled consistently with the existing footer (same font family, `#4a90d9` link color)

### New data file: `src/pi/data/docs-urls.json`

Maps each PI template name (without `.ejs` extension) to its full documentation URL:

```json
{
  "ai-spotter-controls": "https://iracedeck.com/docs/actions/driving/ai-spotter-controls/",
  "audio-controls": "https://iracedeck.com/docs/actions/driving/audio-controls/",
  "black-box-selector": "https://iracedeck.com/docs/actions/driving/black-box-selector/",
  "camera-editor-adjustments": "https://iracedeck.com/docs/actions/view-camera/camera-editor-adjustments/",
  "camera-editor-controls": "https://iracedeck.com/docs/actions/view-camera/camera-editor-controls/",
  "camera-focus": "https://iracedeck.com/docs/actions/view-camera/camera-focus/",
  "car-control": "https://iracedeck.com/docs/actions/driving/car-control/",
  "chat": "https://iracedeck.com/docs/actions/communication/chat/",
  "cockpit-misc": "https://iracedeck.com/docs/actions/cockpit/cockpit-misc/",
  "fuel-service": "https://iracedeck.com/docs/actions/pit-service/fuel-service/",
  "look-direction": "https://iracedeck.com/docs/actions/driving/look-direction/",
  "media-capture": "https://iracedeck.com/docs/actions/media/media-capture/",
  "pit-quick-actions": "https://iracedeck.com/docs/actions/pit-service/pit-quick-actions/",
  "race-admin": "https://iracedeck.com/docs/actions/communication/race-admin/",
  "replay-control": "https://iracedeck.com/docs/actions/view-camera/replay-control/",
  "session-info": "https://iracedeck.com/docs/actions/display-session/session-info/",
  "setup-aero": "https://iracedeck.com/docs/actions/car-setup/setup-aero/",
  "setup-brakes": "https://iracedeck.com/docs/actions/car-setup/setup-brakes/",
  "setup-chassis": "https://iracedeck.com/docs/actions/car-setup/setup-chassis/",
  "setup-engine": "https://iracedeck.com/docs/actions/car-setup/setup-engine/",
  "setup-fuel": "https://iracedeck.com/docs/actions/car-setup/setup-fuel/",
  "setup-hybrid": "https://iracedeck.com/docs/actions/car-setup/setup-hybrid/",
  "setup-traction": "https://iracedeck.com/docs/actions/car-setup/setup-traction/",
  "splits-delta-cycle": "https://iracedeck.com/docs/actions/cockpit/splits-delta-cycle/",
  "telemetry-control": "https://iracedeck.com/docs/actions/cockpit/telemetry-control/",
  "telemetry-display": "https://iracedeck.com/docs/actions/display-session/telemetry-display/",
  "tire-service": "https://iracedeck.com/docs/actions/pit-service/tire-service/",
  "toggle-ui-elements": "https://iracedeck.com/docs/actions/cockpit/toggle-ui-elements/",
  "view-adjustment": "https://iracedeck.com/docs/actions/view-camera/view-adjustment/"
}
```

Templates **not** in the map get no docs link:
- `settings.ejs` — global plugin settings (not an action)
- `replay-navigation.ejs`, `replay-speed.ejs`, `replay-transport.ejs` — hidden sub-actions of Replay Control

### New partial: `docs-link.ejs`

```ejs
<% if (typeof docsUrl !== 'undefined' && docsUrl) { %>
<div class="ird-docs-link">
	<a href="<%= docsUrl %>" target="_blank" rel="noopener noreferrer">Documentation</a>
</div>
<% } %>
```

Renders nothing when `docsUrl` is falsy (undefined or empty string).

### Styling (in `head-common.ejs`)

```css
/* Documentation link */
.ird-docs-link {
  text-align: center;
  margin-top: 16px;
}
.ird-docs-link a {
  color: #4a90d9;
  font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif;
  font-size: 9pt;
  text-decoration: none;
}
```

The `.ird-version` style's `margin-top: 16px` is reduced to `8px` since the docs link provides the top spacing when present. When no docs link is rendered, the version div still has its `border-top` and `padding-top` for visual separation.

### Build plugin update (`pi-template-plugin.mjs`)

In the `generateBundle` loop, derive `docsUrl` from the template filename by looking it up in the loaded `docs-urls` data:

```javascript
const templateName = path.basename(templatePath, ".ejs");
const docsUrl = dataFiles["docs-urls"]?.[templateName] || "";
```

Pass `docsUrl` alongside existing template variables (`version`, `data`, `require`, `locals`).

### PI template changes (all 33 templates)

Add `<%- include('docs-link') %>` immediately before `<%- include('version') %>` in every `.ejs` template.

### Documentation updates

1. **`.claude/rules/pi-templates.md`** — Add `docs-link.ejs` to available partials, add `docs-urls.json` to data files, note maintenance requirement
2. **`packages/stream-deck-plugin/CLAUDE.md`** — Add `docs-urls.json` to "Adding a New Action" checklist
3. **`packages/mirabox-plugin/CLAUDE.md`** — Note that docs URLs are shared from stream-deck-plugin (if relevant)

## Files to modify

- `packages/stream-deck-plugin/src/pi/data/docs-urls.json` (new)
- `packages/stream-deck-plugin/src/pi-templates/partials/docs-link.ejs` (new)
- `packages/stream-deck-plugin/src/pi-templates/partials/head-common.ejs` (add CSS)
- `packages/stream-deck-plugin/src/build/pi-template-plugin.mjs` (inject `docsUrl`)
- All 33 `packages/stream-deck-plugin/src/pi/*.ejs` templates (add include)
- `.claude/rules/pi-templates.md` (document new partial and data file)
- `packages/stream-deck-plugin/CLAUDE.md` (add to new action checklist)

## Verification

1. `pnpm build` succeeds
2. Compiled HTML in `ui/` contains the docs link for actions with URLs (e.g., `black-box-selector.html`)
3. Compiled HTML for `settings.html`, `replay-navigation.html`, `replay-speed.html`, `replay-transport.html` does NOT contain a docs link
4. `pnpm lint:fix && pnpm format:fix` passes
5. `pnpm test` passes
