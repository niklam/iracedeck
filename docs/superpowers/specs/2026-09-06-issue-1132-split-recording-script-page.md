> **Issue:** [#1132](https://github.com/niklam/iracedeck/issues/1132) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Splitting the recording-script reference page

## The page is complete and that is the problem

#1066 rendered the whole recording script — every bundled clip group, every line, every take's text, its consumers — on one generated page, by ruling: an MVP whose reference had to be complete rather than sketched. Complete it is: 46 groups, 1465 lines, 1544 texts, 1.4 MB of HTML. It loads slowly, the browser's find-in-page is the only navigation, and the callouts page (358 KB) is on the same path.

## One page per group, an index that carries the map

Split by clip group. Groups are the unit a pack author records by (a folder of clips), the unit the vocabulary and the callouts reference by name, and the unit whose size is bounded (the largest, `corner-names`, is a few hundred lines; most are under thirty). So:

- `reference/recording-script/` becomes an index: one row per group with its line count, take count, and the callouts and vars that draw from it — the same data the per-group page opens with, so a reader can decide which folders their pack needs without opening any.
- `reference/recording-script/<group>/` renders that group's lines exactly as the single page did (texts, takes, direct consumers, via-var consumers, `playedBy`).
- Anchors move from `#line-<group>-<base>` to `<group>/#line-<base>`. The one helper that builds them (`pack-reference-view.ts`) changes; the existing sweep test that every generated cross-link resolves to an id on its target page is the proof, extended to walk the group pages.

The alternative — one page with every group collapsed by default — was rejected: it lowers the first paint's DOM but not the bytes, and the bytes are the complaint.

## The callouts page stays whole, for now

At 358 KB it is large but usable, and its natural split (by family) would put nineteen `No family` callouts on a page of their own. Leave it; if it grows past the recording script's old weight, split it by family in a follow-up with the same anchor rule.

## What does not change

Everything on every page is still generated from `pack-reference.json` with nothing hand-typed; the artifact's shape does not change; the index page's sidebar entry stays, group pages are reachable from it and are not listed in the sidebar (46 entries would drown it). URL of the index page unchanged, so the concept, format and tutorial pages' links survive; the changelog gets no entry unless a URL a user could have bookmarked changes.
