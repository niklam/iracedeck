# PI Documentation Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Documentation" link above the version footer in every Property Inspector template, linking to the action's docs page on iracedeck.com.

**Architecture:** A JSON data file maps PI template names to docs URLs. The build plugin injects the URL per template. A new partial renders the link conditionally (skipped when no URL is mapped).

**Tech Stack:** EJS templates, Rollup build plugin (pi-template-plugin.mjs), JSON data file

---

### Task 1: Create docs-urls.json data file

**Files:**
- Create: `packages/stream-deck-plugin/src/pi/data/docs-urls.json`

- [ ] **Step 1: Create the data file**

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

Templates intentionally omitted (no docs page): `settings`, `replay-navigation`, `replay-speed`, `replay-transport`.

- [ ] **Step 2: Commit**

```bash
git add packages/stream-deck-plugin/src/pi/data/docs-urls.json
git commit -m "feat(pi): add docs-urls.json mapping templates to documentation pages"
```

---

### Task 2: Create docs-link partial and add styling

**Files:**
- Create: `packages/stream-deck-plugin/src/pi-templates/partials/docs-link.ejs`
- Modify: `packages/stream-deck-plugin/src/pi-templates/partials/head-common.ejs`

- [ ] **Step 1: Create the docs-link partial**

Create `packages/stream-deck-plugin/src/pi-templates/partials/docs-link.ejs`:

```ejs
<% if (typeof docsUrl !== 'undefined' && docsUrl) { %>
<div class="ird-docs-link">
	<a href="<%= docsUrl %>" target="_blank" rel="noopener noreferrer">Documentation</a>
</div>
<% } %>
```

- [ ] **Step 2: Add CSS to head-common.ejs**

In `packages/stream-deck-plugin/src/pi-templates/partials/head-common.ejs`, add the docs-link styles immediately before the existing `/* Version footer */` comment block (before line 62):

```css
  /* Documentation link */
  .ird-docs-link {
    text-align: center;
    margin-top: 16px;
  }
  .ird-docs-link a {
    color: #4a90d9;
    font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
    font-size: 9pt;
    text-decoration: none;
  }

```

- [ ] **Step 3: Reduce version footer margin-top**

In the same file, change `.ird-version` `margin-top` from `16px` to `8px`. The docs link provides the top spacing when present; when absent, the version div still has its border-top and padding-top.

Change:
```css
    margin-top: 16px;
```
To:
```css
    margin-top: 8px;
```

- [ ] **Step 4: Commit**

```bash
git add packages/stream-deck-plugin/src/pi-templates/partials/docs-link.ejs packages/stream-deck-plugin/src/pi-templates/partials/head-common.ejs
git commit -m "feat(pi): add docs-link partial with styling"
```

---

### Task 3: Update build plugin to inject docsUrl

**Files:**
- Modify: `packages/stream-deck-plugin/src/build/pi-template-plugin.mjs`

- [ ] **Step 1: Add docsUrl to template variables**

In `packages/stream-deck-plugin/src/build/pi-template-plugin.mjs`, inside the `generateBundle()` method's `for (const templatePath of ejsFiles)` loop, add the docsUrl lookup before the `ejs.render()` call.

After line 179 (`const templateDir = path.dirname(templatePath);`), add:

```javascript
          const templateName = path.basename(templatePath, ".ejs");
          const docsUrl = dataFiles["docs-urls"]?.[templateName] || "";
```

Then add `docsUrl` to the template variables object passed to `ejs.render()` (after the `version` line):

```javascript
            // Documentation URL for this action (empty string if not mapped)
            docsUrl,
```

And add it to the `locals` object too:

```javascript
            locals: {
              data: dataFiles,
              version: version || "unknown",
              docsUrl,
            },
```

- [ ] **Step 2: Commit**

```bash
git add packages/stream-deck-plugin/src/build/pi-template-plugin.mjs
git commit -m "feat(pi): inject docsUrl template variable from docs-urls.json"
```

---

### Task 4: Add docs-link include to all 33 PI templates

**Files:**
- Modify: All 33 files in `packages/stream-deck-plugin/src/pi/*.ejs`

- [ ] **Step 1: Add the include line to every template**

In each of the 33 `.ejs` files, add `<%- include('docs-link') %>` on a new line immediately before the existing `<%- include('version') %>` line, with a blank line between them.

The pattern to find and replace in every file:

Find:
```ejs
		<%- include('version') %>
```

Replace with:
```ejs
		<%- include('docs-link') %>

		<%- include('version') %>
```

All 33 files use tab indentation with two tabs before the include.

Complete file list:
- `ai-spotter-controls.ejs`
- `audio-controls.ejs`
- `black-box-selector.ejs`
- `camera-editor-adjustments.ejs`
- `camera-editor-controls.ejs`
- `camera-focus.ejs`
- `car-control.ejs`
- `chat.ejs`
- `cockpit-misc.ejs`
- `fuel-service.ejs`
- `look-direction.ejs`
- `media-capture.ejs`
- `pit-quick-actions.ejs`
- `race-admin.ejs`
- `replay-control.ejs`
- `replay-navigation.ejs`
- `replay-speed.ejs`
- `replay-transport.ejs`
- `session-info.ejs`
- `settings.ejs`
- `setup-aero.ejs`
- `setup-brakes.ejs`
- `setup-chassis.ejs`
- `setup-engine.ejs`
- `setup-fuel.ejs`
- `setup-hybrid.ejs`
- `setup-traction.ejs`
- `splits-delta-cycle.ejs`
- `telemetry-control.ejs`
- `telemetry-display.ejs`
- `tire-service.ejs`
- `toggle-ui-elements.ejs`
- `view-adjustment.ejs`

- [ ] **Step 2: Commit**

```bash
git add packages/stream-deck-plugin/src/pi/
git commit -m "feat(pi): add docs-link include to all PI templates"
```

---

### Task 5: Build and verify

- [ ] **Step 1: Run lint and format**

```bash
pnpm lint:fix && pnpm format:fix
```

- [ ] **Step 2: Run tests**

```bash
pnpm test
```

Expected: All tests pass.

- [ ] **Step 3: Run build**

```bash
pnpm build
```

Expected: Build succeeds with no errors.

- [ ] **Step 4: Verify docs link present in action HTML**

Check that a template with a docs URL has the link:

```bash
grep -c "ird-docs-link" packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/ui/black-box-selector.html
```

Expected: `1`

```bash
grep "iracedeck.com/docs" packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/ui/black-box-selector.html
```

Expected: Line containing `https://iracedeck.com/docs/actions/driving/black-box-selector/`

- [ ] **Step 5: Verify docs link absent for excluded templates**

```bash
grep -c "ird-docs-link" packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/ui/settings.html
```

Expected: `0`

```bash
grep -c "ird-docs-link" packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/ui/replay-navigation.html
```

Expected: `0`

- [ ] **Step 6: Verify Mirabox build also has the link**

```bash
grep -c "ird-docs-link" packages/mirabox-plugin/com.iracedeck.sd.core.sdPlugin/ui/black-box-selector.html
```

Expected: `1`

- [ ] **Step 7: Commit any lint/format fixes if needed**

```bash
git add -A && git commit -m "style: fix lint and formatting"
```

Only if there were changes from lint/format.

---

### Task 6: Update documentation

**Files:**
- Modify: `.claude/rules/pi-templates.md`
- Modify: `packages/stream-deck-plugin/CLAUDE.md`

- [ ] **Step 1: Update pi-templates.md — add docs-link to available partials**

In `.claude/rules/pi-templates.md`, in the "Available Partials" section (after the `global-settings.ejs` bullet), add:

```markdown
- **docs-link.ejs** - Documentation link to the action's page on iracedeck.com (conditional, hidden when no URL mapped)
- **version.ejs** - Version footer with downloads link
```

The `version.ejs` entry is new too (it was added in #190 but the partials list was not updated).

- [ ] **Step 2: Update pi-templates.md — add docs-urls.json section**

After the "Key Bindings JSON Format" section, add:

```markdown
## Documentation URLs JSON Format

`src/pi/data/docs-urls.json` maps PI template names (without `.ejs`) to their documentation page URLs:

```json
{
  "action-name": "https://iracedeck.com/docs/actions/{category}/{action-name}/"
}
```

Templates not in the map (e.g., `settings`, hidden sub-actions) will not show a documentation link.

**Maintenance:** When adding a new action, add its entry to `docs-urls.json` with the correct category and action name.
```

- [ ] **Step 3: Update stream-deck-plugin CLAUDE.md — add docs-urls.json to new action checklist**

In `packages/stream-deck-plugin/CLAUDE.md`, in the "Files to modify" section under step 9 ("Add key bindings"), add a new step 10:

```markdown
#### 10. Add documentation URL — `src/pi/data/docs-urls.json`

Add an entry mapping the template name to its documentation page:

```json
"{action-name}": "https://iracedeck.com/docs/actions/{category}/{action-name}/"
```

The `{category}` must match the website docs directory (e.g., `driving`, `cockpit`, `pit-service`, `car-setup`, `view-camera`, `communication`, `media`, `display-session`).
```

- [ ] **Step 4: Commit**

```bash
git add .claude/rules/pi-templates.md packages/stream-deck-plugin/CLAUDE.md
git commit -m "docs: add docs-urls.json maintenance notes to rules and CLAUDE.md"
```
