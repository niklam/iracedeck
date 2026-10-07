import { defineCalloutFamily } from "../define.js";

export const PIT_SERVICE_REQUEST_CALLOUTS = defineCalloutFamily({
  id: "pit-service-requests",
  callouts: {
    /**
     * Family-wide gate for the per-toggle pit-service request
     * confirmations (issue #468). One boolean covers fuel, tire-set,
     * compound, windshield-tearoff, and fast-repair on/off acks — the
     * driver either wants the engineer chiming in on every checkbox flip
     * or they don't, no per-service granularity needed.
     *
     * Read live when the request arrives, so a mid-session toggle takes
     * effect on the next event arrival without cutting an in-flight clip. Default `true` so existing users keep
     * the acks they have today.
     */
    requests: { key: "calloutEnabledPitServiceRequests", label: "Pit service requests" },
  },
});
