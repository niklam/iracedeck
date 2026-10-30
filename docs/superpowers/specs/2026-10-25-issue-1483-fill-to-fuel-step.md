# Fuel Service dial: Target Amount rounds its add up to the car's fuel step

> **Issue:** [#1483](https://github.com/niklam/iracedeck/issues/1483) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

A bug, but the fix involves a design choice, so it gets a spec. The issue carries the report. This spec builds on the #1314 one (`2026-10-18-issue-1314-fuel-step-per-car.md`), which left Fill To out of scope.

## The model

As in #1314: iRacing banks a `pit.fuel` request on a car-specific grid (whole US gallons on the MX-5, whole liters on the Porsche 911 GT3) by rounding to the **nearest** grid point, and publishes the grid nowhere. The banked amounts are absolute multiples of the step (the #1314 log reads 0, 3.78, 7.57, 11.35 L on the MX-5).

Target Amount computes `need = target − current`, rounds it up to a whole display unit and sends it. On a gallon car:

- the bank only changes when `need` crosses a gallon boundary, roughly every 3.8 L of target, so most detents seem to do nothing;
- nearest-rounding can round the add down by up to half a gallon, so a stop can finish up to about 1.9 L below the target. That breaks the mode's promise that "you never finish under target".

## Decision

- **The add is a floor.** What Target Amount must bank is the smallest grid amount at or above `need`. "Rounded up so you never finish under target" stays true on every car.
- **Check what was banked, and step up when it falls short.** After a Fill To send, read `PitSvFuel` back, as the #1314 check does. If it is below `need`, send the next whole liter up and check again, bounded like #1314 (8 L past the first request). This is a "reach at least" condition, where #1314 checks for "moved in this direction"; it is a second completion rule on the same `FuelStepper`, not a second mechanism. It needs no knowledge of the step, so a car that is only ever driven in Fill To still works on its first stop.
- **Learn the step itself, per car.** #1314 learns a minimum *move* (about half a step). Fill To needs the step: the bank move of a press that landed exactly one grid point away (3.785 L on the MX-5, 1 L on a liter car). Keep the smallest such move per `CarPath` for the plugin's lifetime. With the step known, the first send already targets the whole-liter value that rounds to `ceil(need / step) × step`, so the check confirms on the first read instead of probing.
- **The continuous monitor re-sends only when it must.** As fuel burns, `need` grows. A re-send is due only when the banked amount falls below `need`, and a request that fell short is re-sent on the next update rather than waiting for `need` to move by a whole unit. It is also due when the bank is a whole step or more above `need`, for example after the user lowers the target. While a car's step is unknown it counts as 1 L, which keeps whole-liter cars behaving exactly as today (amended 2026-10-30 from the implementation). Re-sending for every whole liter, as today, would on a gallon car send requests that round back to the same gallon. The monitor's existing pauses (fueling off, active pit service, #831) are unchanged.
- **The dial keeps its configured step per detent.** The target stays a round number in the display unit, and only the fuel request follows the car's step. Niklas decided this on 2026-10-25, over snapping each detent to the next total the car can reach: that total drifts as fuel burns, and the readout would show odd numbers.
- **Cars that bank whole liters are unchanged.** Their first send already banks at least `need`, because it is rounded up to a whole liter.

## Out of scope

- Snapping the dialed target to the car's grid (decided against, above).
- Add Amount, the keypad Add / Reduce Fuel and Set Fuel Amount. #1314 covers the first two, and Set Fuel Amount banks the grid point nearest an absolute amount, which is correct.
- Autofuel and its lap margin.
- A per-car table of fuel steps, and persisting the learned step across plugin restarts.
- Showing the car's step on the strip or in the Property Inspector.

## Testing

- **Unit tests** on fake timers with a gallon grid and a whole-liter grid:
  - a gallon car whose `need` is 5 L banks 2 gal (7.57 L), never 1 gal, and the total ends at or above the target;
  - a whole-liter car sends `ceil(need)` once and does not step;
  - the step is learned from a one-step landing and used on the next send, which lands on its first read;
  - as fuel burns on a gallon car, the monitor re-sends only when the bank falls short of `need`, not on every whole liter;
  - lowering the target by more than a step lowers the bank once the step is known;
  - the monitor's pause during active pit service still holds.
- **Existing Fill To tests** pass unchanged for whole-liter cars.
- **Manual, in the sim:** in the Global MX-5 Cup with metric units, Target Amount with step size 1: turning one detent at a time, the request moves only when the target crosses a gallon, and a stop finishes at or above the target. The same dial in the Porsche 911 GT3 behaves as today.
