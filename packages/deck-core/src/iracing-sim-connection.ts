import {
  resolveAllActiveFlags,
  resolveTemplate,
  type SDKController,
  type TelemetryData,
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
  /**
   * The telemetry the latest tick carried (null for a disconnected tick);
   * undefined until the first tick. `activeFlags()` reads it so the flag
   * overlay costs no telemetry read of its own: `getCurrentTelemetry()` is a
   * fresh full read of every variable, and the tick already did one.
   */
  private tickTelemetry: TelemetryData | null | undefined = undefined;

  constructor(private readonly controller: SDKController) {}

  isConnected(): boolean {
    return this.controller.getConnectionStatus();
  }

  subscribe(id: string, onTick: (isConnected: boolean) => void): void {
    this.controller.subscribe(id, (telemetry, isConnected) => {
      this.tickTelemetry = isConnected ? telemetry : null;
      onTick(isConnected);
    });
  }

  unsubscribe(id: string): void {
    this.controller.unsubscribe(id);
  }

  activeFlags(): readonly OverlayFlag[] {
    if (!this.controller.getConnectionStatus()) return [];

    // Before the first tick there is nothing recorded: read once directly.
    const telemetry = this.tickTelemetry === undefined ? this.controller.getCurrentTelemetry() : this.tickTelemetry;

    return resolveAllActiveFlags(telemetry?.SessionFlags);
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
