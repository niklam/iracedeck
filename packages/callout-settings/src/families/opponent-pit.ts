import { defineCalloutFamily } from "../define.js";

export const OPPONENT_PIT_CALLOUTS = defineCalloutFamily({
  id: "opponent-pit",
  callouts: {
    // Opponent-pit callout opt-ins (issue #622). Two subjects — the race
    // leader entering the pits, and same-lap competitors within ±2 effective
    // positions (class space in multi-class, incl. the aggregate tail).
    // Canonical id↔key mapping in this family.
    leader: { key: "calloutEnabledOpponentPitLeader", label: "Leader pitting" },
    nearby: { key: "calloutEnabledOpponentPitNearby", label: "Nearby competitor pitting" },
  },
});
