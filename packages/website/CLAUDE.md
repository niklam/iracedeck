# @iracedeck/website

The Astro + Starlight site at iracedeck.com. Its conventions, page layout and deployment are in the `website` skill; action pages follow `.claude/rules/website-action-docs.md`.

## Generated data

- `build`, `dev` and `typecheck` regenerate the gitignored artifacts first: the icon gallery (`generate:gallery`), and for `build` and `dev` also the changelog (`generate:changelog-json`) and the voice catalog (`generate:voice-catalog-json`).
- `src/data/pack-reference.json` is the exception: it is committed and freshness-tested, built by `pnpm generate:pack-reference`. Its shape is mirrored by hand in `src/pack-reference-types.ts`, because the site imports nothing from the engine.
