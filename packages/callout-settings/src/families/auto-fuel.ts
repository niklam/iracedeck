import { defineCalloutFamily } from "../define.js";

export const AUTO_FUEL_CALLOUTS = defineCalloutFamily({
  id: "auto-fuel",
  callouts: {
    /**
     * Auto-fuel callout opt-in (issue #474). Gates the four lines spoken
     * when the sim's auto-fuel is switched on or off, each naming the fuel
     * request the change leaves behind (`pitService.autoFuelSwitched`), and
     * said without the acknowledgment prefix a driver's own toggle gets. A
     * fuel-bit flip made while auto-fuel is armed is announced by nobody —
     * telemetry cannot tell the sim's write from the driver's press — so
     * this key has nothing to do with attributing one. Independent of
     * `calloutEnabledPitServiceRequests`, since the two preferences are
     * independent in both directions. Default `true` per the callout
     * baseline.
     */
    changed: { key: "calloutEnabledPitServiceAutoFuel", label: "Autofuel changes" },
  },
});
