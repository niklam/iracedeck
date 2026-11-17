import { defineCalloutFamily } from "../define.js";

export const SECTOR_START_CALLOUTS = defineCalloutFamily({
  id: "sector-start",
  callouts: {
    /**
     * Opt-in for the sector-start callouts (issue #1573): the engineer says
     * "Sector three." as the car reaches a sector start in practice and test
     * sessions, timed by the same corner call lead as the corner names. Its
     * own family, not `corner-name`, so it is switched on its own: the Pit
     * Crew Corner Names key flips it when a press names `sectors` or `both`
     * (its long press by default, #1699), and this checkbox flips it alone.
     * Defaults `true`.
     */
    "sector-starts": { key: "calloutEnabledSectorStarts", label: "Sector starts (practice/test)" },
  },
});
