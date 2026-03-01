---
name: website
description: Use when modifying the iRaceDeck website, updating site content, changing styles, adding pages, or working with Firebase deployment. Also use when updating action counts, feature lists, or any public-facing content on iracedeck.com.
---

# iRaceDeck Website

## Overview

Static HTML+CSS site deployed via Firebase Hosting. No framework, no build tools. Two files contain the entire site.

## Files

| File | Purpose |
|------|---------|
| `packages/website/public_html/index.html` | Single-page HTML (all content) |
| `packages/website/public_html/styles.css` | All styling (CSS variables, components, responsive) |
| `packages/website/public_html/site.webmanifest` | PWA manifest |
| `packages/website/public_html/images/` | Logo assets |
| `packages/website/firebase.json` | Hosting config (serves `public_html/`) |

## Design Tokens (CSS Variables)

All colors come from `:root` in `styles.css`. Never hardcode hex values in components.

| Variable | Value | Usage |
|----------|-------|-------|
| `--primary` | `#CD2227` | Brand red, CTAs, links, accents |
| `--primary-hover` | `#A11B1F` | Button hover |
| `--primary-pressed` | `#7E1518` | Button active |
| `--primary-tint` | `#E14B4F` | Large heading highlights only (fails AA for small text) |
| `--bg` | `#FFFFFF` | Page background |
| `--surface` | `#F7F7F8` | Alternating section backgrounds |
| `--border` | `#E6E6E6` | Card/section borders |
| `--text` | `#111111` | Primary text |
| `--text-muted` | `#555555` | Secondary text |
| `--radius-card` | `12px` | Card corners |
| `--radius-control` | `10px` | Buttons, badges, icons |

## Typography

Font: **Exo** (Google Fonts, weights 400/500/600/700). Single font for everything.

- Headings: weight 700
- Section labels: weight 600, uppercase, letter-spacing
- Body: weight 400, 1.125rem

## Logo Assets

| File | Use case |
|------|----------|
| `iracedeck-logo-full-white.png` | Header (white background) — "white" = background color |
| `iracedeck-logo-full-black.png` | Dark backgrounds — "black" = background color |
| `iracedeck-logo-288x288-white.png` | Favicon source, square icon |

**Naming convention**: The color in the filename refers to the intended **background color**, not the logo color.

## Site Sections (in order)

1. **Nav** — Fixed white header, logo image left, nav links right
2. **Hero** — Full-height, headline + 2 CTAs, subtle dot grid pattern
3. **Features** (`#features`) — 8 category cards on surface background
4. **Stats** — 4 metric items with separators (200+ Controls, 8 Categories, 100% Free, iRating Gain)
5. **Support** (`#support`) — GitHub issue CTA on surface background
6. **Contributing** (`#contributing`) — GitHub links
7. **CTA** (`#install`) — Final install call-to-action box
8. **Footer** — Links + copyright on surface background

## Category Cards

8 cards with color-coded icons. Each has: icon, title, description, action count badge. Colors are hardcoded per-category (not tokens) — intentional for variety.

**When action counts change**, update the `<span class="category-count">` text in `index.html`. Use the `iracedeck-actions` skill to get current counts.

## Deployment

```bash
cd packages/website
npx serve public_html        # Local preview
pnpm deploy                  # Deploy to Firebase (iracedeck.com)
```

Domain: **iracedeck.com** (Firebase Hosting with custom domain).

## OG/Social Tags

Meta tags in `<head>` of `index.html`. OG image points to `https://iracedeck.com/images/iracedeck-logo-full-white.png`.

## Visual Depth Elements

The site uses CSS-only decorative effects (no images):
- Hero dot grid pattern with radial mask fade
- Hero radial gradient wash (faint brand color)
- Nav red gradient accent stripe
- Card hover: red gradient top accent line
- Stat item vertical separators
- CTA box red gradient top line
- Section gradient transitions (white to surface)

## Responsive Breakpoints

- **1024px**: Stats grid → 2 columns
- **768px**: Nav links hidden, cards → 1 column, sections compact padding

## Common Changes

**Update action count**: Edit `category-count` span in `index.html`
**Add a section**: Add HTML section + CSS class, follow existing pattern
**Change brand color**: Update `--primary` and related variables in `:root`
**Update favicon**: Replace files in `public_html/`, source from `assets/favicon/`
