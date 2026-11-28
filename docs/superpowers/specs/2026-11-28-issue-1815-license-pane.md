# A License pane in the Settings window

> **Issue:** [#1815](https://github.com/iracedeck/iracedeck/issues/1815) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

Every plugin build ships the repo-root `LICENSE` and `THIRD-PARTY-LICENSES.md` at the plugin root (#905, the `copy-license-files` step in `@iracedeck/plugin-build`), where nobody reads them. #1815 puts both in a License pane of the Settings window, on Stream Deck, Mirabox and Ulanzi, rendered from those same two files so the pane and the shipped files cannot disagree, and offline like Getting Started (#1061) and What's New (#1011). This spec records how the files become the pane and what was refused.

What the two files actually contain decides most of it:

- `LICENSE` is plain text, 96 lines hard-wrapped at 80 columns, its structure carried by numbered lines and `- ` items that are prose, not Markdown.
- `THIRD-PARTY-LICENSES.md` is 363 lines using exactly five constructs: an H1, H2 per component, paragraphs, one GFM pipe table (component, license, where it ships, with links and code spans in the cells), and twelve `text` code fences holding verbatim license texts. No lists, block quotes or HTML outside the fences; every link is an absolute `https://` URL; a few bare URLs sit in prose.

## Approaches

1. **Generate a data artifact from the two root files at build time, render it with a partial (picked).** The pipeline #1011 and #1061 already use: a generator under `scripts/`, a JSON in `iracing-actions/src/actions/data/`, a `pi-components` partial that `require`s it. The pane reads the same two paths the copy step copies, in the same build, so a disagreement needs two builds to happen at once.
2. **Serve the shipped files from the plugin folder at runtime.** The settings server confines static paths to `ui/`; widening that guard (an `xhigh` surface, `code-review.md`) to reach two files at the plugin root, and then rendering Markdown in the browser, buys nothing approach 1 does not have. Refused.
3. **A Markdown library (plus a sanitizer) at build time.** Refused for the reason #1061 refused it: a new dependency and a rendering surface far larger than five constructs need, where a construct nobody expected would render silently instead of failing the build.

## Design

### Rendering: verbatim where the text is verbatim, a strict five-construct grammar for the notices

- **`LICENSE` is one preformatted block**, the file's text exactly (CRLF normalised to LF, trailing newline trimmed). Its hard wraps and numbering are its layout; reflowing it as Markdown would merge lines and read the `- ` items as a list, which would be the pane disagreeing with the file in exactly the way #1815 forbids.
- **`THIRD-PARTY-LICENSES.md` gets its own small block parser**, `scripts/lib/license-notices-parse.mjs`, in the style of `getting-started-parse.mjs`: line-oriented, strict, throwing with a line number on anything outside the five constructs (a list, a quote, a deeper heading, a fence in another language, a table row whose cell count differs from its header). Fences become preformatted blocks, verbatim. Headings are shifted down (H1 to `h3`, H2 to `h4`) under the pane's own `h2`. Paragraphs, headings and table cells go through `changelog-inline-html.mjs`'s `renderInlineMarkdown`, reused verbatim as #1061 did: code spans, bold, emphasis and links, escaped before any markup is produced, and a link that is not `http(s)` or site-absolute throws. A relative link such as `[LICENSE](LICENSE)` would therefore fail the build rather than ship a link the window cannot open, which is the wanted behaviour.
- **Bare URLs stay text.** Autolinking is another grammar for a handful of pointers the reader can select; the table's links, which matter, are already Markdown links.

The artifact carries escaped HTML in an `html` field for inline-rendered text (emitted raw with `<%-`, as Getting Started does) and raw text in a `text` field for preformatted blocks (emitted with `<%=`, so EJS escapes it). Keeping verbatim text unescaped in the data is what lets the test compare it with the file byte for byte.

```json
{
  "_meta": { "generatedFrom": "LICENSE, THIRD-PARTY-LICENSES.md", "generatedBy": "pnpm generate:license-data", "note": "…" },
  "license": { "text": "iRaceDeck Non-Commercial License (v1.1)\n\n…" },
  "notices": [
    { "type": "heading", "level": 3, "html": "Third-Party Licenses" },
    { "type": "paragraph", "html": "…" },
    { "type": "table", "head": ["Component", "License", "Where it ships"], "rows": [["<a …>iRacing SDK</a>", "BSD-3-Clause", "compiled into <code>iracing_native.node</code>"]] },
    { "type": "pre", "text": "Copyright (c) 2013, iRacing.com …" }
  ]
}
```

### The artifact is gitignored and generated before every plugin build

`packages/iracing-actions/src/actions/data/license.json` follows `changelog.json` (#1386), not `getting-started.json`: gitignored, written by `pnpm generate:license-data` (`scripts/generate-license-data.mjs` over `scripts/lib/license-data.mjs`), run by a root turbo task before every plugin build and by each plugin's `watch` script beside the changelog generator. A committed copy would be a third copy of 460 lines of legal text that lags the files in any working tree until someone regenerates it, and `third-party-licenses.test.mjs` already forces an edit of `THIRD-PARTY-LICENSES.md` with every new shipped dependency, so each such PR would carry a regenerated artifact as well. Generated in the build that also copies the files, the two cannot drift; a committed artifact could only be held to them by a freshness test.

The generator reads `SOURCES.licensePath` and `SOURCES.thirdPartyLicensesPath` from `@iracedeck/plugin-build`, not paths of its own, so "the files the pane renders" and "the files the plugin ships" are one definition.

### Turbo

A new root task beside `//#generate:changelog-data`:

```json
"//#generate:license-data": {
  "inputs": [
    "LICENSE",
    "THIRD-PARTY-LICENSES.md",
    "scripts/generate-license-data.mjs",
    "scripts/lib/license-*.mjs",
    "!scripts/lib/license-*.test.mjs",
    "scripts/lib/changelog-inline-html.mjs",
    "packages/plugin-build/src/plugin-rollup.mjs",
    "package.json"
  ],
  "outputs": ["packages/iracing-actions/src/actions/data/license.json"]
}
```

and `"//#generate:license-data"` in the `dependsOn` of all three plugin `#build` entries, which `turbo-inputs.test.mjs` requires to stay identical. The plugin builds already hash `$TURBO_ROOT$/LICENSE` and `$TURBO_ROOT$/THIRD-PARTY-LICENSES.md` for the copy step, so no plugin input changes. A package whose `allowJs` test imports `scripts/lib/license-*.mjs` gets that glob in its `#typecheck` inputs, as `pi-components` has for `changelog-*.mjs`; the inputs test names any it misses, and its `--dry=json` check is the proof the model holds.

### The pane, and where License and Privacy sit

A `license` pane in `settings-window.ejs`, holding `<%- include('settings-window-license') %>` with the `h2` and a one-line sub in the partial: the terms iRaceDeck is used under and the notices for what it includes, the same files that ship in the plugin folder. The preformatted blocks and the table get a horizontal-scroll wrapper, since a pane that is narrower than an 80-column license line must scroll the block, not the window.

Nav order: `… What's New, Diagnostics, License, Privacy, Support iRaceDeck`. Both are reference panes nobody opens to change a setting, so they sit below every settings tab and together; Support stays last, which `settings-window-page.test.ts` pins. #1814 takes the slot after License and designs its own pane. `SETTINGS_WINDOW_TABS` gains `{ pane: "license", label: "License", file: "license.png", elgatoOnly: false }` before `support`.

### Website and docs

No License page on the website. The site already links `LICENSE` on GitHub from the development page, and the pane's subject is what this build ships, which the website cannot show for a user's installed version. The website gets what every new tab gets: a `### License` section on `docs/getting-started/settings.mdx` with `<SettingsShot file="license.png" … />`, pending until the next stable release captures it (`website-screenshots.md`), and a `Features` changelog fragment. `plugin-structure.md` (*License and Third-Party Notices*) records the pane as the second reader of the two files, and that a construct outside the five fails the plugin build.

## Out of scope

- The Privacy pane (#1814), beyond reserving its nav slot.
- Changing the text or structure of `LICENSE` or `THIRD-PARTY-LICENSES.md`. The pane renders them as they are; the notices' "see the `LICENSE` file next to this document" stays true in the plugin folder, and the pane shows that license directly above.
- The per-package license files that ship in `bin/node_modules/` and `assets/fonts/OFL.txt`; the notices already point at them.
- A plain-English summary (`USAGE.md`), a search box, or a deep link to a single component.
- A website page rendering the two files.
- A post-edit hook run for the two files. The plugin build and `pnpm test` both parse the real files, which is where `third-party-licenses.test.mjs` already sends whoever edits them.

## Testing

Unit tests:

- **Parser** (`license-notices-parse.test.mjs`): each construct; a throw with the line number for a list, a quote, an H3, a non-`text` fence, an unclosed fence and a ragged table row; and the real `THIRD-PARTY-LICENSES.md` parses, accounting for every non-blank line, with one table and as many `pre` blocks as the file has fences.
- **The pane matches the files** (`license-data.test.mjs` plus a render through the real partial in `iracing-actions`' `template-data.test.ts`, built in-process from the real files since the artifact is gitignored): the rendered `LICENSE` block, HTML-decoded, equals the file exactly; every fence's text appears decoded and verbatim, in order; every heading appears, in order; the table has one row per component; and no Markdown syntax (`](`, `**`, a backtick, a `|` row) survives in the rendered non-preformatted HTML. The generator's two source paths equal `SOURCES.licensePath` and `SOURCES.thirdPartyLicensesPath`.
- **Partial** (`pi-components`, against a fixture): headings, paragraphs, table and `pre` blocks render; a `pre` block's `<script>` comes out escaped.
- **Existing guards, extended:** `tabs.test.mjs` (the nav list matches `SETTINGS_WINDOW_TABS`), `settings-window-page.test.ts` (Support still last; the License pane sits before it), `settings-window-no-third-party.test.ts` (the notices' links are anchors, the only element allowed an absolute URL), `turbo-inputs.test.mjs`, `website-settings-shot.test.mjs`.

Manual, on each host (Stream Deck, Mirabox, Ulanzi), with the network off: open the Settings window, choose License. The license text reads with its original line breaks and numbering; the notices show the component table and every component's section; a table link opens in the browser once the network is back; the long license blocks scroll inside the pane, not the window; and the text matches the `LICENSE` and `THIRD-PARTY-LICENSES.md` in that host's installed plugin folder.
