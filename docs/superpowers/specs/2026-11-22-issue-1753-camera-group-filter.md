> **Issue:** [#1753](https://github.com/niklam/iracedeck/issues/1753) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Filter the camera group lists by name

## Context

#1653 ([spec](2026-11-08-issue-1653-custom-camera-groups.md)) remembers every camera group name it has seen, so a broadcaster with hundreds of camera files can have hundreds of names in three lists: the Change Camera picker (`ird-camera-group-select`, a native `<select>` with one `<optgroup>` per section), the Cycle Camera grids' Remembered groups section (keypad `cameraGroupSubset` and the dial's global set), and the settings window's Camera Groups card (`ird-camera-catalog-list`). Each name appears once however many tracks use it, so the lists grow with distinct names, not with tracks. #1653's spec named a filter field as the follow-up once the lists prove long; Niklas asked for it on 2026-11-22, after his test of #1653.

## Decisions

1. **One reusable component, `ird-filter-field`, in `@iracedeck/pi-components`.** A text field with a placeholder ("Filter groups") and a clear button. It emits an `input` event carrying the trimmed text and stores nothing: it is not bound to a setting. A raw `<input>` is not allowed in a PI, which is why it is a component; it is written generically so any long list can use it later.
2. **Where it appears.** Above the Change Camera picker, above each Cycle Camera grid (keypad and dial), and at the top of the settings window's Camera Groups card. In the picker and the grids it appears only once the list holds remembered groups beyond the 25 standard ones and this track's, since below that there is nothing to look for; the settings card always has it once it lists more than ten names.
3. **Matching.** Case-insensitive substring match on the group name, after #1653's name normalisation, so `tv` finds `DynamicTV` and `TV Mixed`. Track names are not searched. An empty field shows everything.
4. **What filtering hides.** Every section is filtered, standard groups included, so typing `pit` finds Pit Lane and a custom `PitExit` together. A section with no match loses its heading. Two entries are never hidden:
   - in the picker, the key's own saved group, so the select never shows a value it does not list;
   - in the grids, nothing is unticked by filtering: a ticked group that does not match is hidden from view, and the line under the grid says how many ticked groups are hidden ("3 selected groups hidden by the filter").
5. **Select All and Clear Selection keep acting on the whole list,** filtered or not. A user who filters and then presses Select All gets the same result as without the filter. Acting on the shown rows only was considered (see Rejected); it is the subject of the one question this spec puts to Niklas, below, and the decision here stands until he answers.
6. **The filter text is not saved.** It starts empty each time a Property Inspector or the settings window opens, and changing the key's settings does not clear it while the PI stays open.

## Question for Niklas

With a filter active, should Select All and Clear Selection act on the shown rows only (labelled "Select shown" / "Clear shown" while filtered), or on the whole list as decided above?

## Rejected

- **A searchable combobox replacing the native select.** It would replace the platform control every PI uses for its dropdowns, on three hosts, for one field; a filter above the existing select keeps the select's keyboard and host behaviour.
- **Matching track names too.** `Spa` would then list every group seen at Spa, which is a different question (what does this track have) that "On this track" already answers for the track you are on.
- **Select All acting on shown rows by default.** Useful after filtering, but it gives the same button two meanings depending on a field the user may have forgotten is filled; held for Niklas's answer above.
- **Saving the filter per key.** A filter is a search, not a setting; a saved one would hide groups the next time the PI opens with no sign why.

## Out of scope

- Fuzzy or ranked matching; the list order stays #1653's.
- Filters on any other PI list (the component allows it; each use is its own change).
- Changing what `cameras.json` remembers or how names are pruned.
- #1656's automation list, which reuses the grid and gets the filter with it if it ships after this.

## Testing

- **Unit (`pi-components`):** `ird-filter-field` emits trimmed text and clears; the picker filters options and drops empty optgroups, keeps the saved group, and shows everything when empty; the grids hide non-matching rows without changing the stored subset and report the hidden ticked count; Select All / Clear Selection act on the whole list while filtered; the field appears only above the threshold in decision 2.
- **Manual (Stream Deck, Mirabox):** with a `cameras.json` of a few hundred names (a generated fixture is fine), filter the picker, both grids and the settings card; pick a group from a filtered picker and confirm the key switches to it; tick groups under a filter, clear the filter and confirm the ticks are all there; reopen the PI and confirm the field is empty.
