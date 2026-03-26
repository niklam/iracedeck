# Download URLs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve plugin downloads from iracedeck.com via Firebase redirects to GitHub Release assets, coordinated by an orchestrator workflow, with a dedicated downloads page showing the current version.

**Architecture:** Firebase Hosting 302 redirects point `/downloads/plugin/latest/{platform}` to GitHub's `/releases/latest/download/{filename}` URLs. A new orchestrator workflow (`release.yml`) calls the existing build workflows in parallel, then deploys the website with the version baked in. A new Starlight `.mdx` page provides download buttons and a version badge.

**Tech Stack:** GitHub Actions (workflow_call), Firebase Hosting (redirects), Astro/Starlight (.mdx), CSS

**Spec:** `docs/superpowers/specs/2026-03-26-download-urls-design.md`

---

### Task 1: Firebase Redirects

**Files:**
- Modify: `packages/website/firebase.json`

- [ ] **Step 1: Add redirects array to firebase.json**

Replace the entire file with:

```json
{
  "hosting": {
    "public": "dist",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "redirects": [
      {
        "source": "/downloads/plugin/latest/streamdeck",
        "destination": "https://github.com/niklam/iracedeck/releases/latest/download/com.iracedeck.sd.core.streamDeckPlugin",
        "type": 302
      },
      {
        "source": "/downloads/plugin/latest/mirabox",
        "destination": "https://github.com/niklam/iracedeck/releases/latest/download/com.iracedeck.sd.core.sdPlugin",
        "type": 302
      }
    ]
  }
}
```

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('packages/website/firebase.json','utf8')); console.log('Valid JSON')"`
Expected: `Valid JSON`

- [ ] **Step 3: Commit**

```bash
git add packages/website/firebase.json
git commit -m "feat(website): add Firebase redirects for download URLs"
```

---

### Task 2: Child Workflow Trigger Changes

**Files:**
- Modify: `.github/workflows/release-pack.yml`
- Modify: `.github/workflows/release-pack-dock.yml`
- Modify: `.github/workflows/firebase-hosting-release.yml`

- [ ] **Step 1: Update release-pack.yml triggers**

Replace the `on:` block (lines 3-6):

```yaml
on:
  workflow_dispatch:
  push:
    tags: ["v*"]
```

With:

```yaml
on:
  workflow_dispatch:
  workflow_call:
```

- [ ] **Step 2: Update release-pack-dock.yml triggers**

Same change — replace:

```yaml
on:
  workflow_dispatch:
  push:
    tags: ["v*"]
```

With:

```yaml
on:
  workflow_dispatch:
  workflow_call:
```

- [ ] **Step 3: Update firebase-hosting-release.yml**

Replace the entire `on:` block:

```yaml
on:
  workflow_dispatch:
  push:
    tags: ["v*"]
```

With:

```yaml
on:
  workflow_dispatch:
    inputs:
      version:
        description: "Release version tag (e.g., v1.7.0) — optional for manual runs"
        type: string
  workflow_call:
    inputs:
      version:
        description: "Release version tag (e.g., v1.7.0)"
        type: string
```

Also update the build step (line 21) from:

```yaml
      - run: pnpm --filter @iracedeck/website build
```

To:

```yaml
      - name: Build website
        run: pnpm --filter @iracedeck/website build
        env:
          PUBLIC_IRACEDECK_VERSION: ${{ inputs.version || '' }}
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release-pack.yml .github/workflows/release-pack-dock.yml .github/workflows/firebase-hosting-release.yml
git commit -m "chore(ci): switch child workflows to workflow_call triggers"
```

---

### Task 3: Orchestrator Workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create the orchestrator workflow**

```yaml
name: Release

on:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  build-streamdeck:
    uses: ./.github/workflows/release-pack.yml
    secrets: inherit
  build-mirabox:
    uses: ./.github/workflows/release-pack-dock.yml
    secrets: inherit
  deploy-website:
    needs: [build-streamdeck, build-mirabox]
    uses: ./.github/workflows/firebase-hosting-release.yml
    secrets: inherit
    with:
      version: ${{ github.ref_name }}
```

- [ ] **Step 2: Verify YAML syntax**

Run: `node -e "const yaml = require('yaml'); yaml.parse(require('fs').readFileSync('.github/workflows/release.yml','utf8')); console.log('Valid YAML')"`
Expected: `Valid YAML`

If `yaml` is not available, use: `npx yaml-lint .github/workflows/release.yml` or validate manually.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat(ci): add release orchestrator workflow"
```

---

### Task 4: Downloads Page

**Files:**
- Create: `packages/website/src/content/docs/downloads.mdx`
- Modify: `packages/website/src/styles/custom.css`
- Modify: `packages/website/astro.config.mjs` (sidebar)

- [ ] **Step 1: Create downloads.mdx**

```mdx
---
title: Download iRaceDeck
description: Download the latest iRaceDeck plugin for Elgato Stream Deck or Mirabox devices.
template: splash
prev: false
next: false
hero:
  title: Download iRaceDeck
  tagline: Get the latest plugin for your device.
---

export const version = import.meta.env.PUBLIC_IRACEDECK_VERSION;

{version && <p class="version-badge">Latest release: <strong>{version}</strong></p>}

<div class="download-grid">
  <div class="download-card">
    <span class="download-title">Elgato Stream Deck</span>
    <span class="download-desc">For Stream Deck, Stream Deck Mini, Stream Deck XL, and Stream Deck+. Requires Stream Deck software version 7.1 or newer.</span>
    <a class="download-button" href="/downloads/plugin/latest/streamdeck">Download for Stream Deck</a>
    <span class="download-alt">Or install from <a href="https://marketplace.elgato.com/product/iracedeck-042a0efb-58aa-428c-b1de-8b6169edd21d">Elgato Marketplace</a></span>
  </div>
  <div class="download-card">
    <span class="download-title">Mirabox Ecosystem</span>
    <span class="download-desc">For Stream Dock, SOOMFON, VAPOURD, KILOGOGRAPH, HALCONTORNO, VSDinside, Nouvolo, and other Mirabox devices.</span>
    <a class="download-button" href="/downloads/plugin/latest/mirabox">Download for Mirabox</a>
    <span class="download-alt">Or install from <a href="https://space.key123.vip/product?id=20260322000598">Mirabox Space</a></span>
  </div>
</div>

<p class="download-help">After downloading, double-click the file to install. See the <a href="/docs/getting-started/installation/">installation guide</a> for detailed instructions.</p>
```

- [ ] **Step 2: Add download page styles to custom.css**

Append to `packages/website/src/styles/custom.css`:

```css
/* ── Downloads page ── */

.version-badge {
  text-align: center;
  font-size: 0.95rem;
  color: var(--sl-color-gray-2);
  margin-bottom: 2rem;
}

.download-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1.5rem;
  margin: 2rem 0;
}

@media (max-width: 600px) {
  .download-grid {
    grid-template-columns: 1fr;
  }
}

.download-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 2rem 1.5rem;
  border: 1px solid var(--sl-color-gray-5);
  border-radius: 0.75rem;
  text-align: center;
}

.download-title {
  display: block;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--sl-color-text-accent);
  margin-bottom: 0.75rem;
}

.download-desc {
  display: block;
  font-size: 0.875rem;
  color: var(--sl-color-gray-2);
  line-height: 1.5;
  margin-bottom: 1.5rem;
}

[data-theme="light"] .download-desc {
  color: var(--sl-color-gray-3);
}

.download-button {
  display: inline-block;
  padding: 0.75rem 1.5rem;
  background: var(--sl-color-accent);
  color: var(--sl-color-white) !important;
  border-radius: 0.5rem;
  text-decoration: none;
  font-weight: 600;
  font-size: 1rem;
  transition: opacity 0.2s;
  margin-bottom: 1rem;
}

.download-button:hover {
  opacity: 0.85;
}

.download-alt {
  font-size: 0.8rem;
  color: var(--sl-color-gray-3);
}

.download-help {
  text-align: center;
  font-size: 0.9rem;
  color: var(--sl-color-gray-3);
  margin-top: 2rem;
}
```

- [ ] **Step 3: Add downloads page to sidebar**

In `packages/website/astro.config.mjs`, add a "Downloads" entry to the sidebar array. Insert it as the first item (before the "Home" entry at line 77):

```javascript
{ label: "Downloads", link: "/downloads/" },
```

- [ ] **Step 4: Build the website to verify**

Run: `pnpm --filter @iracedeck/website build`
Expected: Build succeeds without errors. The downloads page should be in the output.

- [ ] **Step 5: Commit**

```bash
git add packages/website/src/content/docs/downloads.mdx packages/website/src/styles/custom.css packages/website/astro.config.mjs
git commit -m "feat(website): add downloads page with version badge"
```

---

### Task 5: Landing Page Change

**Files:**
- Modify: `packages/website/src/content/docs/index.mdx`

- [ ] **Step 1: Replace GitHub button with Download Directly**

In `index.mdx`, replace the GitHub hero action (lines 27-29):

```yaml
    - text: GitHub
      link: https://github.com/niklam/iracedeck
      icon: external
      variant: secondary
```

With:

```yaml
    - text: Download Directly
      link: /downloads/
      icon: right-arrow
      variant: secondary
```

- [ ] **Step 2: Build to verify**

Run: `pnpm --filter @iracedeck/website build`
Expected: Build succeeds. Landing page hero should show the new button.

- [ ] **Step 3: Commit**

```bash
git add packages/website/src/content/docs/index.mdx
git commit -m "feat(website): replace GitHub hero button with download link"
```

---

### Task 6: Installation Docs Update

**Files:**
- Modify: `packages/website/src/content/docs/docs/getting-started/installation.md`

- [ ] **Step 1: Add direct download options for both platforms**

**Stream Deck section:** After "Option 1: Install from Elgato Marketplace" (line 22) and before "Option 2: Install from GitHub Releases", add:

```markdown
### Option 2: Direct Download from iRaceDeck

Download the latest version directly from iRaceDeck:

1. Go to the [iRaceDeck Downloads page](/downloads/)
2. Click **Download for Stream Deck**
3. Double-click the downloaded `.streamDeckPlugin` file
4. The Stream Deck software will open and install the plugin automatically
5. Look for the **iRaceDeck** category in the Stream Deck action list
```

Rename the existing "Option 2: Install from GitHub Releases" to "Option 3: Install from GitHub Releases".

**Mirabox section:** After "Install from Mirabox Space" (line 49), add:

```markdown
### Direct Download from iRaceDeck

You can also download the Mirabox plugin directly from the [iRaceDeck Downloads page](/downloads/). After downloading, extract the `.sdPlugin` file and import it via the Mirabox Space app.
```

- [ ] **Step 2: Build to verify**

Run: `pnpm --filter @iracedeck/website build`
Expected: Build succeeds without errors.

- [ ] **Step 3: Commit**

```bash
git add packages/website/src/content/docs/docs/getting-started/installation.md
git commit -m "docs(website): add direct download option to installation guide"
```
