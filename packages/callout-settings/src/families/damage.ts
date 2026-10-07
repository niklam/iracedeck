import { defineCalloutFamily } from "../define.js";

export const DAMAGE_CALLOUTS = defineCalloutFamily({
  id: "damage",
  callouts: {
    /**
     * Damage callout opt-in (issue #489). Fires after the rising-edge
     * debounce on `EngineWarnings & (MandRepNeeded | OptRepNeeded)`. Same
     * forward-compat semantics as the flag callouts (`FLAG_CALLOUTS`). Canonical
     * id↔key mapping in this family.
     */
    "repair-needed": { key: "calloutEnabledDamageRepairNeeded", label: "Repair needed" },
  },
});
