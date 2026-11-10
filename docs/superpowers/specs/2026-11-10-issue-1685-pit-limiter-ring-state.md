# The Pit Speed Limiter's ring shows the limiter state

> **Issue:** [#1685](https://github.com/niklam/iracedeck/issues/1685) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Decision

The ring of the circle that holds the pit speed limit number takes its colour from the limiter's tri-state. This is Niklas's choice (2026-11-10): the old blue and red come back, with grey added for N/A.

| State | Ring | Status bar (unchanged) |
| --- | --- | --- |
| On (limiter engaged) | blue `#3498db` | green ON |
| Off | red `#e74c3c` | red OFF |
| N/A (car has no limiter) | grey `#888888` | grey N/A |

`pitLimiterSpeedGraphic(speed, compact)` gains the state as a parameter, and the caller passes the same `toggleState` it already gives the status bar and `borderColorForState`. Nothing else about the graphic moves: the white fill, the stroke width, the two size presets (title hidden, title shown) and the number's colour and placement stay as #1476 leaves them.

The ring stays a fixed semantic colour, not a user colour slot. The blue and red are the icon set's semantic data colours (`icons.md`), the same values the pre-#638 icons used, so no new colour enters the palette and no settings key is added.

## Why blue for on, when the status bar says green

Niklas chose between matching the status bar (green on, red off, grey N/A) and restoring the pre-#638 blue on / red off. He picked the old colours because that is the look users knew before 1.21.0. Blue also keeps the ring from repeating the bar: the bar says on/off, and the ring says "this key is the limiter", in its own colour. Red for off matches the bar, and grey for N/A matches the bar and the dimmed look of a key with nothing to do.

## Alternatives rejected

- **Match the status bar (green / red / grey).** Consistent with the other tri-state buttons, but not the look Niklas remembers and asked for back.
- **A user colour slot for the ring.** No user asked for one, and it would add a settings key (a persisted contract) for a decoration with a fixed meaning.
- **Two separate icons again, as before #638.** #638 merged them into one graphic so the N/A state could exist; a parameter on that one graphic restores the colour without undoing it.

## Out of scope

- The status bar, the key border, the title and the number (#1476's units) are unchanged.
- No other tri-state Car Control mode gets a coloured graphic.
- Mirabox and Ulanzi get the change through the shared action code, with no separate work.

## Testing

- Unit: `pitLimiterSpeedGraphic` draws the ring in blue, red and grey for on, off and N/A, at both size presets. The existing assertion that the graphic contains neither blue nor red (from #638) is replaced by these, and a positive control fails if the state is ignored.
- Icon previews regenerate if a preview covers the mode, and the freshness test passes.
- Manual, Stream Deck: one Car Control key in Pit Speed Limiter mode. Toggle the limiter in a car that has one and watch the ring go blue then red, with the status bar still green/red. In a car without a limiter, the ring is grey with the N/A bar. With Show title on, the smaller circle shows the same colours.
