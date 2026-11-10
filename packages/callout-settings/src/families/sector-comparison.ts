import { defineCalloutFamily } from "../define.js";

export const SECTOR_COMPARISON_CALLOUTS = defineCalloutFamily({
  id: "sector-comparison",
  callouts: {
    /**
     * Opt-ins for the sector comparison (issue #1572): at the player's line in
     * a race, where on the lap the time goes against the class leader (the
     * pace gap and the sector the most is lost in), the sector where the car
     * ahead is slower (attack), and the sector where the car behind is
     * quicker (defence). One per target, so each can be silenced alone; all
     * three ship on. Rendered under Gaps, beside the gap calls about the same
     * neighbours.
     */
    leader: { key: "calloutEnabledSectorComparisonLeader", label: "Sector pace against the class leader" },
    ahead: { key: "calloutEnabledSectorComparisonAhead", label: "Where we're quicker than the car ahead" },
    behind: { key: "calloutEnabledSectorComparisonBehind", label: "Where the car behind is quicker" },
  },
});
