/**
 * The Ulanzi adapter runs deck-core's per-context ordering contract suite
 * (#1597, decision 6). Each scenario gets a fresh adapter over a mocked client
 * and drives host events the way `UlanziClient.routeEvent` does: the one
 * registration matching the frame is called synchronously, with the frame
 * already normalised and its settings backfilled.
 *
 * UlanziStudio sends input for a context it never sent an `add` for (a plugin
 * process that starts with keys already on the deck; measured on the SDK
 * simulator for #1597), so the harness declares the `appear-first` policy: the
 * adapter appears such a context before the input runs.
 */
import {
  CONTEXT_EVENT_ORDER_ACTION_UUID,
  CONTEXT_EVENT_ORDER_SCENARIOS,
  type ContextEventOrderHarness,
  type ContextEventOrderHostEvent,
} from "@iracedeck/deck-core/testing";
import { describe, it, vi } from "vitest";

import { UlanziPlatformAdapter } from "./adapter.js";
import type { UlanziEvent, UlanziEventHandler } from "./ulanzi-client.js";

type Registration = [uuid: string, event: string, handler: UlanziEventHandler];

const registrations: Registration[] = [];

vi.mock("./ulanzi-client.js", () => ({
  parseConnectionParams: () => ({ address: "127.0.0.1", port: "3906", language: "en" }),
  PLUGIN_UUID: "com.iracedeck.sd.core",
  UlanziClient: class {
    onActionEvent = (uuid: string, event: string, handler: UlanziEventHandler): void => {
      registrations.push([uuid, event, handler]);
    };
    onGlobalEvent = vi.fn();
    connect = vi.fn();
    requestGlobalSettings = vi.fn();
    onHostReady = vi.fn();
    setGlobalSettings = vi.fn();
    openUrl = vi.fn();
    setImage = vi.fn();
    setSettings = vi.fn();
    // No cache: the adapter falls back to the frame's settings, as the client
    // backfills them before routing.
    cachedSettings = vi.fn();
  },
}));

/** The host events UlanziStudio delivers per context; it has no touch strip. */
const ULANZI_HOST_EVENTS: readonly ContextEventOrderHostEvent[] = [
  "willAppear",
  "willDisappear",
  "didReceiveSettings",
  "keyDown",
  "keyUp",
  "dialDown",
  "dialUp",
  "dialRotate",
];

function createHarness(): ContextEventOrderHarness {
  registrations.length = 0;

  const adapter = new UlanziPlatformAdapter();

  return {
    adapter,
    hostEvents: ULANZI_HOST_EVENTS,
    neverAppeared: "appear-first",
    emit(event, context, payload = {}) {
      // The real client's `routeEvent` awaits every registration matching a
      // frame in turn, so only the first is reached synchronously. Each
      // scenario registers once, as production does, so there must be exactly
      // one: anything else is a dispatch this harness would not reproduce.
      const matching = registrations.filter(
        ([uuid, registered]) => uuid === CONTEXT_EVENT_ORDER_ACTION_UUID && registered === event,
      );

      if (matching.length !== 1) {
        throw new Error(
          `expected one "${event}" handler on the client for the suite's action, found ${matching.length}`,
        );
      }

      const registration = matching[0];

      const frame: UlanziEvent = {
        event,
        action: CONTEXT_EVENT_ORDER_ACTION_UUID,
        context,
        payload: {
          settings: payload.settings ?? {},
          ...(payload.controller === undefined ? {} : { controller: payload.controller }),
          ...(payload.ticks === undefined ? {} : { ticks: payload.ticks }),
          ...(payload.pressed === undefined ? {} : { pressed: payload.pressed }),
        },
      };

      // Discarded on purpose, as the client's `void this.routeEvent(ev)` is: the
      // harness returns before anything the dispatch started settles.
      void registration[2](frame);
    },
  };
}

describe("UlanziPlatformAdapter per-context ordering contract (#1597)", () => {
  it.each(CONTEXT_EVENT_ORDER_SCENARIOS)("$name", async ({ run }) => {
    await run(createHarness());
  });
});
