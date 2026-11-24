# @iracedeck/website

The Astro + Starlight site at iracedeck.com. Its conventions, page layout and deployment are in the `website` skill; action pages follow `.claude/rules/website-action-docs.md`.

## Generated data

- `build`, `dev` and `typecheck` regenerate the gitignored artifacts first: the icon gallery (`generate:gallery`), and for `build` and `dev` also the changelog (`generate:changelog-json`) and the voice catalog (`generate:voice-catalog-json`).
- `src/data/pack-reference.json` is the exception: it is committed and freshness-tested, built by `pnpm generate:pack-reference`. Its shape is mirrored by hand in `src/pack-reference-types.ts`, because the site imports nothing from the engine.
- The website is sim-neutral (`SIM_NEUTRAL_PACKAGES` in `eslint.config.js`), and so must be everything the gallery generator (`scripts/generate-icon-gallery.mts`) loads by relative path from `iracing-actions`: the dial surfaces' sim-free `*-dial-render.ts` modules and the shared drawing they reach, never a `*-dial-surface.ts` or anything that imports `deck-iracing` or `iracing-sdk`. The lint block refuses every package outside that list by name, but cannot see a relative path, nor an `.mdx` page, which ESLint never reads; `scripts/cross-package-reach.test.mjs` walks the runtime imports of the generator and of every `.mdx` page (an `.astro` component read by its frontmatter and `<script>` bodies, an `.mdx` page by its import and export blocks) and fails on any workspace package outside that list (#1662).
