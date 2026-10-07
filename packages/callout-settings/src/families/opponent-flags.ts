import { defineCalloutFamily } from "../define.js";

export const OPPONENT_FLAG_CALLOUTS = defineCalloutFamily({
  id: "opponent-flag",
  callouts: {
    // Opponent-flag callout opt-ins (issue #936). Four subjects — penalty
    // flags on cars that matter to us (standings neighbours + slow traffic
    // ahead). Canonical id↔key mapping in this family.
    furled: { key: "calloutEnabledOpponentFlagFurled", label: "Slowdown (furled black flag)" },
    black: { key: "calloutEnabledOpponentFlagBlack", label: "Black flag" },
    meatball: { key: "calloutEnabledOpponentFlagMeatball", label: "Meatball (repairs)" },
    disqualify: { key: "calloutEnabledOpponentFlagDisqualify", label: "Disqualified" },
  },
});
