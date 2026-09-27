> **Issue:** [#1265](https://github.com/niklam/iracedeck/issues/1265) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Session Info: a grouped, alphabetical Mode list

## The decision

Session Info's **Mode** dropdown is split into three `<optgroup>`s, and the items inside each group are sorted alphabetically. The maintainer chose both at once: grouping makes a 13-item list scannable by topic, and alphabetical order inside a group makes the position of any one item predictable without learning a second, hand-made order.

| Group | Items, in order |
| --- | --- |
| **Race** | Gaps (Ahead/Behind) · Incident Points · iRating Gain/Loss · Laps · Position · Race Flags · Time / Laps Remaining |
| **Fuel** | Fuel · Laps to Empty |
| **Conditions** | Air Temperature · Track Temperature · Track Wetness · Wind |

- **Alphabetical means case-insensitive on the displayed label**, so "Incident Points" sorts before "iRating Gain/Loss" (`inc` < `ira`), and a label that starts with a lowercase letter is not pushed to the end.
- **The groups themselves are ordered Race, Fuel, Conditions** — by how often a driver reaches for them — not alphabetically. Three groups are read at a glance; the order that matters for finding an item is the one inside a group.
- **A new item joins the group it belongs to at its alphabetical place.** A new topic that fits none of the three gets its own group, placed where it reads best; that is the only judgement call the order leaves.

## What does not change

The stored `mode` values (`incidents`, `time-remaining`, `laps`, `position`, `irating`, `gaps`, `fuel`, `laps-to-empty`, `flags`, `track-wetness`, `track-temp`, `air-temp`, `wind`) and the schema default (`incidents`) stay exactly as they are, so every existing key keeps its item and nothing migrates. Only the order and grouping of the `<option>` elements in `session-info.ejs` change. The conditional-visibility script reads the select's value, not its position, so it is unaffected.

`<optgroup>` inside `<sdpi-select>` is established in this repo (`.claude/rules/sdpi-components.md`; used by Audio Controls, Camera Focus, Force Feedback, Race Admin and Camera Editor Adjustments), and all three hosts render the shared Property Inspector.

## Artifacts beyond the template

- Website `docs/actions/display-session/session-info.md`: the per-item sections follow the new order, under the same three group names as `##`-level or bold separators, matching how other grouped action pages present theirs.
- `docs/reference/actions.json` and the `iracedeck-actions` skill, where they list Session Info's items, follow the same order.
- Changelog: one **Improvements** line.

## Out of scope

- Renaming any item's label, or changing a stored `mode` value.
- Reordering other actions' Mode lists; each has its own history and a grouping of its own where one exists.
- The Session Info fuel sub-options (Now / Used last lap / Average per lap), which follow the order a stint unfolds in, not the alphabet.

## Testing

- A unit test that parses the Mode `<sdpi-select>` in `session-info.ejs` and asserts: the three group labels in order; within each group, the options are sorted case-insensitively by label; every value of the settings schema's `mode` enum appears exactly once, so a new item cannot be added to the schema and forgotten in the list (or the reverse).
- Manual: the dropdown shows the three groups in each host that renders a Property Inspector, and an existing key keeps its selected item after the update.
