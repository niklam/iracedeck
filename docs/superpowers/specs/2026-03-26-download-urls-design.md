# Plugin Download URLs from iracedeck.com

**Issue:** #196
**Date:** 2026-03-26
**Status:** Approved

## Problem

Plugin downloads are only available via Elgato Marketplace, Mirabox Space, or GitHub Releases. There are no direct download links on iracedeck.com, and the three release workflows (Stream Deck build, Mirabox build, website deploy) run independently with no coordination.

## Decisions

The following decisions narrow the scope from the original issue:

- **Latest only** — only `/downloads/plugin/latest/{platform}` URLs are implemented. Versioned URLs (e.g., `/downloads/plugin/v1.7.0/streamdeck`) are deferred.
- **Firebase redirects** — `/latest/` URLs are 302 redirects in `firebase.json`, not static HTML redirect pages.
- **Standalone downloads page** — a new Starlight `.mdx` page at `/downloads/`, not inline on the landing page.
- **Landing page** — replace the GitHub button with "Download Directly" linking to `/downloads/`.

## Design

### 1. Firebase Redirects

Two 302 redirects in `packages/website/firebase.json`:

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

GitHub's `/releases/latest/download/{filename}` pattern automatically resolves to the asset from the most recent release.

### 2. Orchestrator Workflow

New `.github/workflows/release.yml` replaces the three independent tag-triggered workflows:

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

- `build-streamdeck` and `build-mirabox` run in parallel
- `deploy-website` waits for both to complete, ensuring download URLs resolve before the site goes live
- The orchestrator passes the tag name (e.g., `v1.7.0`) as the `version` input
- `secrets: inherit` is required so child workflows can access `FIREBASE_SERVICE_ACCOUNT_IRACEDECK` and `GITHUB_TOKEN`
- If either build job fails, the website deploy is skipped — this is acceptable since the GitHub Release assets are uploaded independently by each build job

### 3. Child Workflow Trigger Changes

All three child workflows change their triggers:

**Remove:**
```yaml
on:
  push:
    tags: ["v*"]
```

**Replace with:**
```yaml
on:
  workflow_dispatch:
  workflow_call:
```

The `firebase-hosting-release.yml` workflow additionally accepts a `version` input:

```yaml
on:
  workflow_dispatch:
  workflow_call:
    inputs:
      version:
        description: "Release version tag (e.g., v1.7.0)"
        type: string
```

The website build step uses this input as an environment variable:

```yaml
- name: Build website
  run: pnpm --filter @iracedeck/website build
  env:
    PUBLIC_IRACEDECK_VERSION: ${{ inputs.version || '' }}
```

### 4. Downloads Page

New Starlight page at `packages/website/src/content/docs/downloads.mdx` (renders at `/downloads/`).

Content:
- Heading: "Download iRaceDeck"
- Version badge displaying the build-time version (e.g., "v1.7.0"), read from `import.meta.env.PUBLIC_IRACEDECK_VERSION`
- Falls back gracefully when no version is set (manual/dispatch builds)
- Two download sections:
  - **Stream Deck** — button to `/downloads/plugin/latest/streamdeck`, note about Stream Deck software 7.1+ requirement
  - **Mirabox** — button to `/downloads/plugin/latest/mirabox`, note about Mirabox Space app
- Links to marketplace alternatives as secondary options
- Link to installation docs for setup instructions after download

### 5. Landing Page Change

In `packages/website/src/content/docs/index.mdx`, replace the GitHub hero button:

**Before:**
```
GitHub → https://github.com/niklam/iracedeck
```

**After:**
```
Download Directly → /downloads/
```

The other three buttons (Elgato Marketplace, Mirabox Space, View Documentation) remain unchanged.

### 6. Installation Docs Update

In `packages/website/src/content/docs/docs/getting-started/installation.md`, add a reference to the downloads page as an alternative download option.

## Deferred

- Versioned download URLs (`/downloads/plugin/v1.7.0/streamdeck`) — can be added later with additional Firebase rewrites or a catch-all redirect page
- Download analytics/tracking
