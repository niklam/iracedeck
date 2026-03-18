---
name: website
description: Use when modifying the iRaceDeck website, updating site content, changing styles, adding pages, or working with Firebase deployment. Also use when updating action counts, feature lists, or any public-facing content on iracedeck.com.
---

# iRaceDeck Website

## Overview

Astro + Starlight documentation site deployed via Firebase Hosting. Dark theme by default with the iRaceDeck brand.

## Key Files

| File | Purpose |
|------|---------|
| `packages/website/astro.config.mjs` | Starlight config: sidebar, logo, social links, GA |
| `packages/website/src/styles/custom.css` | Brand overrides (accent color, font, dark bg) |
| `packages/website/src/content.config.ts` | Content collection config with Starlight loader |
| `packages/website/src/content/docs/index.mdx` | Landing page (splash template) |
| `packages/website/src/content/docs/` | All documentation pages (markdown) |
| `packages/website/src/assets/` | Logo image |
| `packages/website/public/` | Static assets (favicons, webmanifest) |
| `packages/website/firebase.json` | Hosting config (serves `dist/`) |

## Brand

| Token | Value |
|-------|-------|
| Accent color | `#ce2128` |
| Dark background | `#0a0a0c` |
| Font | Exo (Google Fonts) |
| Theme | Dark default, light toggle available |

Colors are set as Starlight CSS custom properties in `src/styles/custom.css`.

## Content Structure

All docs pages live under `src/content/docs/docs/` and are served at `/docs/...`.

```text
src/content/docs/
├── index.mdx                        # Landing page at / (splash template)
└── docs/
    ├── index.md                     # Docs landing page at /docs/
    ├── getting-started/
    │   ├── installation.md
    │   └── troubleshooting.md
    ├── features/
    │   ├── key-bindings.md
    │   ├── flags-overlay.md
    │   ├── focus-iracing-window.md
    │   └── template-variables.md    # Source of truth for telemetry template vars
    ├── actions/
    │   ├── overview.md
    │   ├── display-session/         # 2 actions
    │   ├── driving/                 # 5 actions
    │   ├── cockpit/                 # 4 actions
    │   ├── view-camera/             # 6 actions
    │   ├── media/                   # 1 action
    │   ├── pit-service/             # 3 actions
    │   ├── car-setup/               # 7 actions
    │   └── communication/           # 1 action
    └── reference/
        ├── action-types.md
        └── keyboard-shortcuts.md
```

## Sidebar

Defined in `astro.config.mjs` under `starlight.sidebar`. Uses `{ slug: "..." }` entries pointing to content files. Categories match `docs/reference/actions.json`.

## Adding/Editing Pages

1. Create or edit a `.md` file in `src/content/docs/docs/`
2. Add Starlight frontmatter (`title`, `description`, optional `sidebar` badge)
3. If new, add the slug to the sidebar in `astro.config.mjs`
4. Run `pnpm dev` to preview, `pnpm build` to verify

## Action Doc Template

```md
---
title: {Action Name}
description: {Brief description}
sidebar:
  badge:
    text: "{N} modes"
    variant: tip
---

{Intro paragraph}

## Modes

| Mode | Description |
|------|-------------|
| {label} | {description} |

## Encoder Support

{Yes/No — what rotation does}
```

## Deployment

```bash
cd packages/website
pnpm dev                  # Local dev server (http://localhost:4321)
pnpm build                # Build to dist/
pnpm preview              # Preview built site
pnpm deploy               # Build + deploy to Firebase
```

Domain: **iracedeck.com** (Firebase Hosting with custom domain).

## Common Changes

**Update action count on landing page**: Edit the stats row and category cards in `src/content/docs/index.mdx`
**Add an action page**: Create `.md` in the right category folder, add slug to sidebar in `astro.config.mjs`, update `docs/reference/actions.json`, and update `.claude/skills/iracedeck-actions/SKILL.md`
**Change brand color**: Update `--sl-color-accent` in `src/styles/custom.css`
**Update favicon**: Replace files in `public/`, source from `assets/favicon/`
**Add sidebar section**: Edit `sidebar` array in `astro.config.mjs`
