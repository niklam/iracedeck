import type { OverlayFlag, SimConnection } from "@iracedeck/deck-core";
import {
  resolveAllActiveFlags,
  resolveTemplate,
  type SDKController,
  type TelemetryData,
  type TemplateContext,
} from "@iracedeck/iracing-sdk";

/**
 * Empty context used when the sim is disconnected: {{variable}} placeholders
 * render empty and {{= expression }} parse errors stay visible — the same rules
 * Telemetry Display values follow. Exported so other display paths that read
 * a template context (Chat's key text, #1337) fall back the same way instead
 * of defining their own.
 */
export const EMPTY_TEMPLATE_CONTEXT: TemplateContext = Object.freeze({
  // Inline rather than templateContextFromMaps({}): a module-scope call into
  // iracing-sdk would break every test that mocks that package without it.
  display: () => undefined,
  raw: () => ({ found: false }),
});

/**
 * iRacing's {@link SimConnection}: the SDK controller behind the deck layer's
 * sim-neutral interface (#1351). Flags come from `SessionFlags`, title
 * templates from the controller's per-tick template context.
 */
export class IRacingSimConnection implements SimConnection {
  /**
   * The telemetry the latest tick carried; null before the first tick and for
   * a disconnected one. Connection-wide, since every subscription sees the
   * same tick. `activeFlags()` reads it so the flag overlay costs no telemetry
   * read of its own: the tick already did one.
   */
  private tickTelemetry: TelemetryData | null = null;

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

  /**
   * The flags of the latest tick's telemetry; empty while disconnected and
   * before any tick has been seen. Meant to be read from inside a tick, where
   * the latest tick is the current one.
   */
  activeFlags(): readonly OverlayFlag[] {
    if (!this.tickTelemetry || !this.controller.getConnectionStatus()) return [];

    return resolveAllActiveFlags(this.tickTelemetry.SessionFlags);
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
