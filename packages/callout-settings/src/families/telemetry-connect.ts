import { defineCalloutFamily } from "../define.js";

export const TELEMETRY_CONNECT_CALLOUTS = defineCalloutFamily({
  id: "telemetry-connect",
  callouts: {
    /**
     * Opt-in for the Race Engineer radio check fired when iRacing telemetry
     * starts flowing (issue #554 follow-up). On a false→true transition of
     * the SDK controller's connection state, the Pit Crew action plays the
     * driver-name clip followed by `toggle/radio-check-01` — "<name>, …
     * radio check. Standing by." — so the user has audible confirmation
     * that the plugin is talking to iRacing. Gated on Race Engineer being
     * enabled (master gate) AND this opt-in. UI-side, no scenario engine.
     * Read live so a mid-session PI toggle takes effect on the next
     * connect. Default `true`.
     */
    "radio-check": {
      key: "calloutEnabledTelemetryConnectRadioCheck",
      label: "Confirm Race Engineer on telemetry connect",
    },
  },
});
