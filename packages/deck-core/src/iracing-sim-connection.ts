import {
  resolveAllActiveFlags,
  resolveTemplate,
  type SDKController,
  type TemplateContext,
} from "@iracedeck/iracing-sdk";

import type { OverlayFlag, SimConnection } from "./sim-connection.js";
import { EMPTY_TEMPLATE_CONTEXT } from "./title-template.js";

/**
 * iRacing's {@link SimConnection}: the SDK controller behind the deck layer's
 * sim-neutral interface (#1351). Flags come from `SessionFlags`, title
 * templates from the controller's per-tick template context.
 */
export class IRacingSimConnection implements SimConnection {
  constructor(private readonly controller: SDKController) {}

  isConnected(): boolean {
    return this.controller.getConnectionStatus();
  }

  subscribe(id: string, onTick: (isConnected: boolean) => void): void {
    this.controller.subscribe(id, (_telemetry, isConnected) => onTick(isConnected));
  }

  unsubscribe(id: string): void {
    this.controller.unsubscribe(id);
  }

  activeFlags(): readonly OverlayFlag[] {
    if (!this.controller.getConnectionStatus()) return [];

    return resolveAllActiveFlags(this.controller.getCurrentTelemetry()?.SessionFlags);
  }

  resolveTitleTemplate(text: string): string {
    let context: TemplateContext | null = null;

    try {
      context = this.controller.getCurrentTemplateContext();
    } catch {
      // Not initialised / no telemetry yet: fall back to the empty context.
    }

    if (context) {
      try {
        return resolveTemplate(text, context);
      } catch {
        // A context that throws mid-resolve renders like a disconnected one.
      }
    }

    return resolveTemplate(text, EMPTY_TEMPLATE_CONTEXT);
  }
}
