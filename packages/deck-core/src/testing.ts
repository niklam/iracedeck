/**
 * Test support for other packages' tests; never imported by production code.
 * Reached as `@iracedeck/deck-core/testing`.
 *
 * It carries two things:
 *
 * - The per-context ordering contract suite every deck adapter runs
 *   (`CONTEXT_EVENT_ORDER_SCENARIOS`, #1597) and the harness types an adapter's
 *   test implements to run it.
 * - The REAL dial-gesture helpers and icon throttle, for a test that replaces
 *   the `@iracedeck/deck-core` barrel with `vi.mock` while the hold preview's
 *   timer, the release classifier or the 10/s throttle is what it tests
 *   (#1375). They are re-exported here by relative path, so a mock of the
 *   barrel never reaches them, and the test takes them by package name rather
 *   than by a relative path into this package's `src/`.
 *
 * Nothing here imports `vitest`, so deck-core's published code takes no test
 * dependency; the main barrel (`index.ts`) carries what production imports and
 * none of the contract suite.
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
export { classifyDialRelease, createHoldPreview, NOOP_HOLD_PREVIEW } from "./dial-gesture.js";
export { IconUpdateThrottle } from "./icon-update-throttle.js";
