import { defineCalloutFamily } from "../define.js";

export const SETUP_WARNING_CALLOUTS = defineCalloutFamily({
  id: "setup-warning",
  callouts: {
    /**
     * Setup-name mismatch warning opt-in (issue #625). When on, the Race
     * Engineer appends a "double-check your setup" nudge after the session-start
     * (qualifying) and race-start intros when the loaded setup name looks wrong
     * for the session type. Default true — the family's natural baseline.
     */
    warning: { key: "calloutEnabledSetupWarning", label: "Setup looks wrong for session" },
  },
});
