---
name: review-page
description: Use when a branch adds or changes voice clips or key icons and Niklas must approve them: build a disposable private Artifact that plays each clip or shows each icon before and after.
---

# Review page

A review page is **disposable**: built for one review, private, never updated afterwards. Niklas gives his verdict in chat (all approved, or the entries to redo with a note); the page has no controls beyond play. The `qa` agent builds it; the issue lead passes the link to the PO.

Load the `artifact-design` skill before writing the page. Build everything in your scratchpad, never in the worktree.

## Which files

Diff the working tree (committed and uncommitted) against the branch point, so clips and icons that are not committed yet are included:

```bash
base=$(git -C <tree> merge-base origin/master HEAD)
git -C <tree> diff --name-status --no-renames "$base" -- <paths>
git -C <tree> ls-files --others --exclude-standard -- <paths>
```

`<paths>` is `packages/audio-assets/voice` for audio, `packages/icons ':!packages/icons/preview' packages/iracing-actions/icons 'packages/iracing-actions/src/actions/*/*.svg'` for icons (`preview/` is generated from the sources). Three kinds come back, each shown its own way below: standalone icons (`packages/icons/`), dynamic templates (`packages/iracing-actions/icons/`), and the static manifest images in each action folder (`key.svg` 72x72, `icon.svg` 20x20 category icon, `dial.svg`). `A` and untracked files are new, `M` changed; ignore deletions. `--no-renames` makes a renamed or copied file come back as a deletion plus an `A`, so its new path is always listed. An empty list means there is no page to build: say so.

## Audio

For each `.mp3` under `packages/audio-assets/voice/<voice>/<group>/<entry>.mp3`:

- **Text.** Read `packages/audio-assets/configs/<voice>.voice.json` from the tree, `groups[<group>]`, the item whose `name` is `<entry>`; show its `text` with each `<break time="Xs" />` written as `[pause Xs]`, HTML-escaped. A clip with no entry is reported on the page as having no text.
- **Clip.** Copy the file to `<scratch>/review/clips/<voice>/<group>/<entry>.mp3`. For a changed clip, also write the base version (`git -C <tree> show "$base":<path>` to a file) as `<entry>.before.mp3`.
- **Row.** One per clip, grouped by voice then group: voice / group / entry / text, a play button (an `<audio controls preload="none">` is enough), and for a changed clip a second one labelled "before". State once at the top that these are the dry TTS clips; the radio filter is applied at build time and is heard in the scenario harness.

Publish `<scratch>/review/index.html` with `Artifact`, passing every clip in `files` (published path = the `clips/…` path the page references; `audio/mpeg` is inferred). One publish takes at most 255 files: publish the rest to the same `url` in further calls.

If the publish refuses the audio files, load the `anthropic-skills:built-in-browser` skill and open the same `index.html` with its `clips/` beside it in the built-in browser instead. If the pane will not open a local file, serve the folder from a few-line Node `http` server bound to `127.0.0.1`, started in the background, and stop it after the verdict.

## Icons

Every kind is rendered through the path the deck uses, so the page shows what the deck shows.

- **Static manifest images** (`src/actions/<action>/*.svg`): already complete SVGs; show before and after as-is, scaled to key size.
- **Dynamic templates** (`packages/iracing-actions/icons/*.svg`): telemetry-driven Mustache templates rendered by the action through `renderIconTemplate()` with its own values and border parts, not by `assembleIcon`. Render each through the action's exported generator (the `@internal` `generate…Svg` its tests call, from the built `packages/iracing-actions/dist`, rebuilt first if stale), with two or three representative settings and telemetry values taken from that action's tests, so the page shows real states rather than raw placeholders.
- **Standalone icons** (`packages/icons/`): compose the key as below.

For each changed standalone icon:

1. Use `packages/icon-composer/dist/index.js` from the tree; rebuild the package first if `dist` is older than `src` (`cd <tree> && pnpm --filter @iracedeck/icon-composer build`).
2. In a Node script in your scratchpad, per side: `resolveIconColors(svg, {}, undefined)` → `resolveTitleSettings(svg, {}, undefined, runtimeTitle)` → `resolveBorderSettings` → `resolveGraphicSettings({}, undefined)` → `assembleIcon(...)`, which returns a base64 data URI for `<img src>`.
3. The after side is the tree's file; the before side is `git -C <tree> show "$base":<path>` (none for a new icon). Take the runtime title from the action's `*_TITLES` map in `packages/iracing-actions/src/actions/<action>/<action>.ts`, the before one from `git show "$base":<that path>`; the maps override the SVG's `<desc>` title.
4. Skip pairs that are identical before and after. Group the cards by action, before beside after, each key on a device-black well. Show every pair on a light and on a dark surround at once, so neither page theme hides a problem.

The data URIs go inline in the page; publish it with `Artifact` and no `files`.

## Report

Return the artifact URL, the number of clips or icons on it, and anything you could not place (a clip without text, an icon without a title).
