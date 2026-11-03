/**
 * Test helpers shared with the deck adapters' tests (#1597); never imported by
 * production code. Reached as `@iracedeck/deck-core/testing`.
 *
 * It carries the per-context ordering contract suite every adapter runs
 * (`CONTEXT_EVENT_ORDER_SCENARIOS`) and the harness types an adapter's test
 * implements to run it. Nothing here imports `vitest`, so deck-core's published
 * code takes no test dependency; the main barrel (`index.ts`) carries what
 * production imports and none of this.
 */
export {
  CONTEXT_EVENT_ORDER_ACTION_UUID,
  CONTEXT_EVENT_ORDER_HOST_EVENTS,
  CONTEXT_EVENT_ORDER_INPUT_EVENTS,
  CONTEXT_EVENT_ORDER_SCENARIOS,
  type ContextEventOrderAdapter,
  type ContextEventOrderHarness,
  type ContextEventOrderHostEvent,
  type ContextEventOrderPayload,
  type ContextEventOrderScenario,
} from "./context-event-order-scenarios.js";
