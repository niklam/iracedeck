# Race Engineer callouts: sections and descriptions in the settings window

> **Issue:** [#1700](https://github.com/niklam/iracedeck/issues/1700) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Where it stands

Measured on `master` at `bf7b1cc4b`:

- `CALLOUT_PI_GROUPS` (`packages/callout-settings/src/pi-groups.ts`) holds 29 headings over 38 families and 107 entries. `CALLOUT_FAMILIES`, `CalloutSettingKey`, `RegisteredCalloutFamily` and `CALLOUT_SETTING_KEYS` are all derived from it in `index.ts`.
- `race-engineer-callouts.ejs` renders each heading as `<sdpi-item label="<title>">` holding a two-column grid of `sdpi-checkbox` rows (`grid-template-rows: repeat(ceil(N/2))`, column flow), and places the 29 headings by hand, in its own order, with the non-callout items (the opponent flag range, three gap sliders, the spotter interval, the fuel text and margin, the corner-names text with its attribution and the lead slider) between them.
- `sdpi-item` draws a fixed `95px 241px` grid in its shadow DOM (`browser/sdpi-components.js`). The rows therefore sit in a 241 px control column, two sub-columns of about 114 px each, however wide the window is: the Callouts card spans the pane (`.sw-grid.single`), the rows do not.
- The partial concatenates titles and labels into attributes with no escaping (`label="' + r.label + '"`).
- `head-common.ejs`, which the settings window loads, binds every `.ird-collapsible[data-accordion-id]` on the page to the `_accordionState` global setting.
- The settings window is served from `127.0.0.1` on an ephemeral port chosen at each plugin start (`settings-window.md`), so its origin, and with it any browser storage, changes every time the plugin restarts.

## Decision

### 1. Sections own their headings; the flat list is derived

`pi-groups.ts` gains a section level, and the sections hold the groups:

```typescript
export interface CalloutPiGroup {
  readonly id: string;
  readonly title: string;
  /** One sentence for the driver: when the engineer speaks under this heading and what he tells you. */
  readonly description: string;
  readonly families: readonly CalloutFamily[];
}

export interface CalloutPiSection {
  readonly id: string;
  /** The collapsible sub-header in the settings window's Callouts card. */
  readonly title: string;
  /** Rendered in this order. */
  readonly groups: readonly CalloutPiGroup[];
}

export const CALLOUT_PI_SECTIONS = [
  { id: "session-and-start", title: "Session & start", groups: [/* … */] },
  // …
] as const satisfies readonly CalloutPiSection[];

export type RegisteredCalloutPiGroup = (typeof CALLOUT_PI_SECTIONS)[number]["groups"][number];

/** Every heading, in render order: the sections' groups concatenated. */
export const CALLOUT_PI_GROUPS: readonly RegisteredCalloutPiGroup[] = CALLOUT_PI_SECTIONS.flatMap(
  (section): readonly RegisteredCalloutPiGroup[] => section.groups,
);
```

`RegisteredCalloutFamily` becomes `RegisteredCalloutPiGroup["families"][number]`, so the literal key types survive the extra level; `CALLOUT_FAMILIES` stays derived from `CALLOUT_PI_GROUPS`, so the chain is sections → groups → families → entries, and placing a family in a group inside a section is still the one act that registers it. `index.ts` exports `CALLOUT_PI_SECTIONS`, `CalloutPiSection` and `RegisteredCalloutPiGroup` beside what it exports today. The package stays dependency-free.

Nesting makes "every heading belongs to a section" structural: a group cannot be declared outside one. "Exactly one" is the test that group ids are unique across all sections, since the only way to place a heading twice is to write it twice.

The render order changes, so `CALLOUT_SETTING_KEYS` and the schema's field order follow it. Nothing reads that order as a contract: the baseline (`callout-settings-baseline.test.ts`) looks every key up by name, and the settings file is JSON whose key order carries no meaning (it may come out in the new order at the next save, same content). The baseline is not touched.

### 2. The sections and their headings

Seven sections, in this order. Headings keep their ids, titles and family lists; no heading is split and no entry moves.

| Section (`id`) | Headings, in order | Entries |
| --- | --- | --- |
| Session & start (`session-and-start`) | Telemetry Connect, Session Start, Setup Warning, Start Lights, Rolling Start | 8 |
| Flags & incidents (`flags-and-incidents`) | Flags, Caution, Opponent Flags, Incidents, Qualifying | 43 |
| Racing (`racing`) | Race, Position, Overtakes, Gaps, Spotter, Lap Time | 13 |
| Pit stops (`pit-stops`) | Pit Window, Pit Limiter, No Pit Limiter, Pit Speeding, Pit Box, Pit Service, Pit Service Status, Opponent Pits | 25 |
| Car & conditions (`car-and-conditions`) | Fuel, Damage, Track Conditions | 14 |
| Track guide (`track-guide`) | Corner Names and Sectors | 3 |
| Key acknowledgments (`key-acknowledgments`) | Race Engineer Toggle | 1 |

Changes from the issue's starting proposal, each for what the call does:

- **Setup Warning moves to Session & start.** Its nudge is appended to the session-start and race-start intros (`setup-warning.ts`); it is heard at the start, never mid-stint, so a driver looking for it thinks of the start.
- **The second section is "Flags & incidents", not "Flags & cautions".** It holds Incidents (off track, contact) and Qualifying (the lap-invalidated call), which are not cautions; a full-course caution is a flag. The collapsed summary lists every heading title (section 4), so "Caution" stays visible.
- **Headings within a section run in the order the calls come in a session or a stop**: Pit Window, then the limiter and speeding calls of the pit lane, the box count-in, the service and its status, then the opponents.

Two single-heading sections remain. Track guide is its own feature with its own key and a licence attribution; Key acknowledgments is the one call made in answer to a key press rather than to the sim. The Corner Names toggle acknowledgment stays in its heading, Corner Names and Sectors, because a driver who uses that key looks for it there; the two rows labelled "Toggle on/off acknowledgment" therefore sit in different sections, each under the heading that names its key.

**No section description.** A section title is a category ("Pit stops"); the explanation lives on its headings. Instead the collapsed summary lists the section's heading titles (section 4), derived, nothing to author.

### 3. Descriptions

- **Every heading carries a required `description`** on `CalloutPiGroup`. Required in the type, so a new heading without one does not compile.
- **An entry may carry an optional `description`** on `CalloutEntry`, for an entry whose label says neither what is spoken nor when. "Green" needs none; "Crossed flags", "Green held", "Two to green", "Can't fix that", "Pit service requests", "Autofuel changes" and "Position on the last lap" are the kind that do. Which entries get one is decided while drafting them, by that test.

The style, for both:

- One sentence, ending in a full stop, on one line; a heading's at most 160 characters, an entry's at most 120.
- Says **when** the engineer speaks and **what he tells you**, in the driver's terms: "When iRacing connects, the engineer does a short radio check so you know he is listening." "On pit road, the engineer counts down the distance to your pit box so you stop on your marks."
- Plain words, second person, US spelling as the website writes. No internal names: no settings key, family or callout id, event name, "telemetry", "SDK" or issue number.
- Describes the call, never quotes a line: a voice pack scripts its own wording, so the Default voice's sentence is not what every user hears.
- Never restates the heading title or the label as its opening words.

Where an existing supporting text under a heading already says what the heading description now says, that sentence moves into the description and the rest stays where it is. That applies to two today: Fuel ("Estimated laps of fuel left, announced mid-lap once each count is reached.") and Corner Names ("Announces the upcoming corner's name, and each sector start after the first, in practice and test sessions."). The corner data attribution stays word for word, as its own supporting text, beside the Corner Names heading (`track-data/CLAUDE.md`: never removed).

**Who writes them.** The implementation drafts all 29 heading descriptions and the entry ones, each checked against what the call does (the family's comment and the scenario it gates). Niklas approves every sentence at the manual test, as user-facing text. Heading titles and entry labels are not changed by this issue.

### 4. Rendering

**Sections are native `<details>` elements, closed on every open of the window.**

```html
<details class="ird-callout-section" data-callout-section="pit-stops">
  <summary class="ird-callout-section-summary">
    <span class="ird-callout-section-title">Pit stops</span>
    <ird-callout-count>24 of 25 on</ird-callout-count>
    <span class="ird-callout-section-headings">Pit Window · Pit Limiter · … · Opponent Pits</span>
  </summary>
  <!-- the section's headings -->
</details>
```

- `<details>` gives keyboard toggling (Tab, Enter, Space) and needs no script to open or close. Chromium opens a closed `<details>` when find-in-page matches inside it, so Ctrl+F still reaches every label and description while all sections are closed.
- **It must not carry `ird-collapsible` or `data-accordion-id`.** `head-common.ejs` would otherwise bind it to `_accordionState` and write every open and close into the user's global settings. Its classes are its own, styled in `settings-window.ejs` beside `.ird-sw-card`.
- **Closed by default, and not remembered.** The card opens as seven summary lines, each with its count and its heading titles: the whole list in one screen, which is what lets a driver find the call they are thinking of. Remembering would need browser storage, and the window's origin includes a port chosen at each plugin start, so `localStorage` would remember until the next restart of the deck software and then forget: memory that works only some of the time is worse than none. It is not a setting either (the issue). Within one open window, the panes are hidden rather than rebuilt, so a section stays open across tab switches.
- **The heading-title line shows only while the section is closed** (`details:not([open]) .ird-callout-section-headings`); open, the headings themselves are on screen.

**The count, "N of M on".** M is the number of callout checkboxes in the section; sliders do not count. The partial renders the initial text from the defaults, so nothing is blank before the components load. A new component, `ird-callout-count` in `pi-components/src/components/callout-count.ts`, then keeps it true: it finds every `sdpi-checkbox[setting^="calloutEnabled"]` inside its closest `[data-callout-section]`, reads each as `keep-one-checked.ts`' `isTicked` does (`value ?? default`, imported, not copied), and recounts on each box's `valuechange`, which sdpi dispatches for the user's click, a push from the plugin (the Corner Names key writing its opt-in) and the initial load alike, as `ird-auto-switch-note` relies on. It re-watches once at `DOMContentLoaded`, because the boxes are parsed after the summary that holds it, and removes its listeners on disconnect. Settings window only; it renders text only, never markup.

**Headings leave `sdpi-item`.** Inside a section each heading is a block of its own, the full width of the card:

```html
<div class="ird-callout-heading" data-callout-group="pit-box">
  <div class="ird-callout-heading-title">Pit Box</div>
  <div class="ird-callout-heading-description">On pit road, …</div>
  <div class="ird-callout-rows">
    <div class="ird-callout-row">
      <sdpi-checkbox setting="calloutEnabledPitBoxCountIn" label="Count-in to pit box" global default="true"></sdpi-checkbox>
      <div class="ird-callout-row-description">…</div><!-- only when the entry has one -->
    </div>
  </div>
  <!-- this heading's non-callout items, if any -->
</div>
```

- The 241 px control column of `sdpi-item` has no room for a second line under a label, let alone a button; out of it, the rows get the card's width.
- `.ird-callout-rows` uses CSS columns (`column-width` about 280 px, `break-inside: avoid` on a row): two columns at the window's minimum width, three on a wide one, read top to bottom then across, as the column-flow grid reads today. This replaces the row count computed from N; there is still no hardcoded count.
- **An entry description is a second line under its label, never a tooltip.** A tooltip shows only to a pointer resting on the right label, so it cannot answer "which of these is the one I mean" for a driver scanning the list, and find-in-page does not search it. The second line is indented to the label text and set in the muted supporting-text colour.
- **Each row is a two-column grid, `1fr auto`.** This issue fills the first cell only and renders no placeholder in the second; #1701 puts its per-row button there without re-laying the row.
- The sliders keep their `<sdpi-item>` and `.ird-supporting-text` exactly as today, and render inside their heading's block, after its rows: the opponent flag range after Opponent Flags, the three gap sliders after Gaps, the reminder interval after Spotter, the fuel text and margin after Fuel, the attribution and lead slider after Corner Names and Sectors. `race-engineer-callouts-sliders.test.ts` holds them to the schema unchanged.

**The partial walks the data instead of placing headings by hand.** It loops sections → headings → rows, and appends a heading's non-callout items from one map in the partial keyed by group id (`opponent-flags`, `gaps`, `spotter`, `fuel`, `corner-names`). The order is declared once, in `CALLOUT_PI_SECTIONS`; the hand-written list of 29 `calloutGroupItem(...)` calls, a second order to keep in step, goes. The partial throws at build time on a map key that names no heading, so a renamed group cannot drop a slider without a red build.

**Render data.** `callout-pi-groups.mjs` builds `calloutPiSections` — `[{ id, title, groups: [{ id, title, description, rows: [{ setting, label, description?, on }] }] }]` — in place of `calloutPiGroups`, still in a fresh process per build and with the same watch list; `pi-template-plugin.mjs` passes it under the new name, and the partial's missing-data error names it.

### 5. Escaping

Every title, label and description is free text from the registry and goes through one `escapeHtml` in the partial (`&`, `<`, `>`, `"`, `'`) whether it lands in an attribute (`label="…"`) or in element text. That also closes the raw concatenation of labels and titles today ("Lights & go" and "Can't fix that" render the same in the browser, escaped). Setting keys are not escaped, since `registry.test.ts` holds them to `^calloutEnabled[A-Z]\w*$`. The count component writes `textContent` only.

### 6. What a callout author now supplies

`race-engineer-callouts.md` (the registry row and step 5's new-family paragraph), `callout-settings/CLAUDE.md`, `global-settings.md` (step 5, UI) and `pi-templates.md` (the partial's entry) are updated in the same change:

- **A new entry** in an existing family: as today, plus a `description` when its label says neither what is spoken nor when.
- **A new heading**: a group, with its `description`, inside one section of `CALLOUT_PI_SECTIONS`, at the place in that section where its calls come. No partial edit, unless the heading carries a slider or a supporting text, which goes in the partial's map under its group id.
- **A new section** is a design decision, not a step of adding a callout: it is proposed with the issue that needs it.

## Alternatives rejected

- **Re-order the 29 headings in one flat list, no sections.** Puts the pit calls next to each other but leaves a list of 107 rows to scroll, and gives nothing to collapse or count.
- **Descriptions as tooltips only.** Invisible until a pointer rests on the right label, and not searched by find-in-page. Discovery is the point of the issue.
- **A required description on all 107 entries.** Most labels already say the call ("Green", "Blue", "5 laps of fuel left", "Gained position"); a sentence under each would restate them, double the card's height and bury the dozen or so that need one. The heading description carries the context every row shares; an entry description is kept for the label that does not explain itself.
- **A section field on each group (`section: "pit-stops"`), or a separate section list naming group ids.** Either leaves two orders (groups, and sections) to keep in step and needs a test for membership; nesting makes membership structural and the declared order the rendered order.
- **Reusing `accordion.ejs` or `.ird-collapsible` for sections.** In the settings window `accordion.ejs` renders a flat card by design, and `.ird-collapsible[data-accordion-id]` is persisted to the `_accordionState` global setting by `head-common.ejs`.
- **Remembering open sections in `localStorage` or `sessionStorage`.** The origin changes at every plugin start, so it would remember inconsistently; `sessionStorage` ends with the window. A setting is ruled out by the issue.
- **Sections open by default.** The card would read as today's long list with headers in it; closed, it is a seven-line index the driver opens where they need.
- **Keeping the rows inside `sdpi-item`, widened with `ird-label-width`.** That widens the label column only; the control column stays 241 px, too narrow for a second line and a per-row button.
- **A search box over the callouts.** The window's key-binding filter is a precedent, but with sections listing their headings and find-in-page reaching closed sections, a driver can already find a call by name. Revisit if the manual test shows otherwise.

## Out of scope

- The "Hear example" button per row (#1701). This issue only leaves the row's second cell free for it.
- The Stream Deck Property Inspector: the callouts left it in #1003 and are rendered by the settings window alone.
- Any settings key, default or migration; the baseline record is untouched.
- Renaming heading titles or entry labels, and moving an entry to another family or heading.
- Generating the website's callout lists from the registry. The website's Settings page is described by hand; the voice-pack Callouts reference is a list for pack authors, generated from the scenario catalog, and unchanged.
- Expand-all / collapse-all, per-heading counts and a search box.
- Recapturing the settings-window screenshots: the stable release does that (`website-screenshots.md`).

## Testing

Unit tests, each added or changed in the same change:

- `callout-settings` `registry.test.ts`: section ids unique; group ids unique across all sections (a heading in exactly one section); no section id equals a group id; no empty section; every section and group title non-empty; every group `description` and every entry `description` present follows the text rules (trimmed, one line, ends with a full stop, within its length cap, and free of `calloutEnabled`); the entry known-fields list adds `description`; `CALLOUT_PI_GROUPS` equals the sections' groups concatenated, and `CALLOUT_FAMILIES` the groups' families in that order. The existing type tests (`CalloutSettingKey` the union of literal keys, the generic `keyOf` over `RegisteredCalloutFamily`) must still pass, which proves the extra level kept the literal types.
- `pi-components` `callout-pi-groups.test.ts`: the build data has the sections, headings and descriptions in registry order, and its rows flattened equal `CALLOUT_SETTING_KEYS`.
- The partial's tests (moved from `accordion-partial.test.ts` into a `race-engineer-callouts-partial.test.ts` beside it): every key rendered exactly once; one closed `<details class="ird-callout-section">` per section, in order, and none carrying `ird-collapsible` or `data-accordion-id` (this replaces today's "no `<details`" assertion); each heading inside its section, its description directly under its title; an entry description rendered exactly where the entry has one; the initial count text equals the on-defaults over the entries for each section; each slider and supporting text inside its heading's block after the rows (the #1274 opponent-flag test adapted), the attribution text present word for word; a map key naming no heading throws; missing `calloutPiSections` throws; the `default="true"` / no-`default` rule unchanged. Escaping: a fixture section whose title, heading description, label and entry description contain `<`, `>`, `&`, `"` and `'` renders each escaped, in the attribute and in text, and the fixture's markup never appears raw.
- `callout-count.test.ts`: counts `value ?? default`; recounts on `valuechange`; counts only the boxes of its own section; picks up boxes parsed after it at `DOMContentLoaded`; drops its listeners on disconnect.
- `race-engineer-callouts-sliders.test.ts`, the settings-window page test and the baseline test pass unchanged.

Manual test, in the settings window on Stream Deck with the plugin built from the branch:

1. Open Settings > Race Engineer. The Callouts card shows seven closed sections, each with its count and heading titles, and the counts match the boxes inside.
2. Open Pit stops; untick and tick a box; the count follows at once. Close and reopen the section: it keeps state while the window is open; switch tabs and back: unchanged.
3. With Track guide open, press a Corner Names key on the deck: the corner-names box and the section count change without a reload.
4. Close the window and open it again: every section is closed.
5. Ctrl+F for a label inside a closed section ("Can't fix that"): the section opens on the match. If the app window offers no find bar, record that, since the search-box decision above leans on it.
6. Read every heading and entry description; Niklas approves the text, and any sentence he changes is changed before the PR.
7. Resize the window from its minimum width to full screen: rows reflow between two and three columns, no row is clipped, the sliders and the corner-data attribution sit under their headings.
8. Tab to a section summary and toggle it with Enter and Space.
9. Spot-check the same card in the Mirabox or Ulanzi settings window, which renders the same partial.
