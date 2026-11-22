# No position calls on pit road

> **Issue:** [#1722](https://github.com/niklam/iracedeck/issues/1722) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

In Niklas's in-game test on 2026-11-18, a lap that ended in the pit lane after a tow announced "We're currently P20" from P5. It played as he left the box, behind the pit-exit call. On pit road the race order is in flux. Places lost to a stop are mostly won back after it, and the driver is busy with the limiter, the box and the exit. His decision: "no position calls when on pitlane, and if such is queued, drop them."

## Decisions

1. **The position family is silent on pit road.** Every Race Engineer line that announces the player's position (the position change after a lap, the periodic position status and the overtake gained/lost lines) gets a `speakGate` that refuses while the player is on pit road. "On pit road" means the player's car is in the pit lane or in its stall: `OnPitRoad`, or the player's track surface reading pit stall or approaching pits. The gate also refuses while the player is out of the car.
2. **A queued one is dropped, not held.** The gate runs when the line starts, so a position line queued before pit entry and still waiting when the car reaches pit road is dropped there. A line fired on pit road is dropped at once. Nothing is replayed after the stop.
3. **No catch-up line after the stop.** Once back on track, the next position call is the ordinary one: the position change at the next lap completed on track, or the next periodic status. The stop's lost places are not announced on their own; the next ordinary call states the position as it then is. *Amended 2026-11-22:* places lost in the player's own stop get their own line after the stop, decided in [#1756's spec](2026-11-22-issue-1756-pit-stop-losses.md), which supersedes this decision and the second Rejected entry below for that case; this issue's pit-road silence stands.

## Rejected

- **Holding the line until pit exit.** It would announce a position that is still settling, the "P20" of the test, at the busiest moment.
- **A dedicated "after your stop you're P8" line.** It is a new call with new clips; #943 (a pit-lane pass callout) owns pit-stop position news.

## Out of scope

- The pit-lane pass callout (#943).
- Gap callouts and opponent pit callouts, which already have their own gates.
- Position keys and displays on the deck, which keep showing the live order.

## Testing

- **Unit:** each position contract refuses on pit road and with the player out of the car, and plays on track. A line queued while on track, still waiting when `OnPitRoad` turns true, is dropped and never plays after the stop. The first lap completed on track after the stop announces the position normally.
- **Manual (Stream Deck, AI race):** pit and lose places, and hear no position call between pit entry and the end of the exit lane. The next lap on track announces the new position once.
