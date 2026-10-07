import { ConnectionStateAwareAction } from "@iracedeck/deck-core";
import type { SDKController } from "@iracedeck/iracing-sdk";

import { getController } from "./sdk-singleton.js";

/**
 * Base for actions that read iRacing directly (#1351): `ConnectionStateAwareAction`
 * plus the typed SDK controller, for telemetry, session info and the template
 * context. The deck layer itself sees only the sim-neutral `SimConnection`;
 * this class is where an action's direct dependency on iRacing is named, so
 * the leak is one import away from being found.
 */
export abstract class IRacingAction<T = Record<string, unknown>> extends ConnectionStateAwareAction<T> {
  protected get sdkController(): SDKController {
    return getController();
  }
}
