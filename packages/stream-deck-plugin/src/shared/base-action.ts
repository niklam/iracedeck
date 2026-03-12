/**
 * Base Action for Stream Deck
 *
 * Abstract base class that extends SingletonAction with:
 * - SVG image management
 * - Per-instance active/inactive state tracking
 * - Flag overlay support (flashes flag colors when race flags are active)
 */
import {
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type KeyUpEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { type FlagInfo, resolveAllActiveFlags } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";

import { getGlobalSettings, onGlobalSettingsChange } from "./global-settings.js";
import { applyInactiveOverlay, svgToDataUri } from "./overlay-utils.js";
import { getController } from "./sdk-singleton.js";

/**
 * Union of event types that have an action property supporting isKey()
 * Note: WillDisappearEvent is excluded as its action is ActionContext, not KeyAction/DialAction
 */
type KeyCompatibleEvent<T extends JsonObject> =
  | WillAppearEvent<T>
  | KeyDownEvent<T>
  | KeyUpEvent<T>
  | DidReceiveSettingsEvent<T>;

/**
 * Stored context info for refreshing images
 */
interface ContextEntry<T extends JsonObject> {
  action: KeyAction<T>;
  svg: string;
}

/**
 * Abstract base class for Stream Deck actions.
 *
 * Features:
 * - Provides `setKeyImage(ev, svg)` for setting images
 * - Provides `setActive(isActive)` to track active state
 * - Subclasses should handle inactive appearance in their SVG generation
 *
 * @template T - The settings type for this action
 *
 * @example
 * ```typescript
 * @action({ UUID: "com.example.my-action" })
 * export class MyAction extends BaseAction<MySettings> {
 *   override async onWillAppear(ev: WillAppearEvent<MySettings>): Promise<void> {
 *     await super.onWillAppear(ev);
 *     await this.setKeyImage(ev, generateMySvg(this.getIsActive()));
 *   }
 * }
 *
 * // In plugin.ts:
 * const myAction = new MyAction();
 * streamDeck.actions.registerAction(myAction);
 * controller.on('connectionChange', (isConnected) => myAction.setActive(isConnected));
 * ```
 */
export abstract class BaseAction<T extends JsonObject = JsonObject> extends SingletonAction<T> {
  /**
   * Logger instance - subclasses can override with a scoped logger
   */
  protected logger: ILogger = silentLogger;

  /**
   * Per-instance active state
   */
  private _isActive = true;

  /**
   * Per-instance storage: contextId -> { action, svg }
   * Used to refresh images when active state changes
   */
  private contexts = new Map<string, ContextEntry<T>>();

  /** Contexts with flag overlay enabled (settings.flagsOverlay === true) */
  protected flagOverlayContexts = new Set<string>();

  /** Contexts currently displaying a flag color (image output gated) */
  protected flagOverlayActive = new Set<string>();

  /** Shared flash timer for all overlay contexts */
  private flagFlashTimer: ReturnType<typeof setInterval> | null = null;

  /** Current active flags from telemetry */
  private currentFlags: FlagInfo[] = [];

  /** Rotation index for multi-flag alternation */
  private flagFlashIndex = 0;

  /** Shared telemetry subscription ID */
  private flagTelemetrySubId: string | null = null;

  /** Last flag state key for change detection */
  private lastFlagStateKey = "";

  private static readonly FLAG_FLASH_INTERVAL_MS = 500;
  private static readonly FLAG_SUBSCRIPTION_PREFIX = "__flag_overlay__";

  constructor() {
    super();

    // Subscribe to global settings changes to refresh overlays
    onGlobalSettingsChange(() => {
      this.refreshAllImages();
    });
  }

  /**
   * Refresh all context images with current overlay state.
   * Called when global settings change.
   */
  private refreshAllImages(): void {
    for (const [contextId, { action, svg }] of this.contexts) {
      // Skip contexts with active flag overlay
      if (this.flagOverlayActive.has(contextId)) continue;

      const finalImage = this.applyOverlayIfNeeded(svg);
      action.setImage(finalImage).catch((err) => {
        this.logger.warn(`Failed to refresh image for context ${contextId}: ${err}`);
      });
    }
  }

  /**
   * Check if overlay should be applied based on active state and global settings.
   * @returns true if overlay should be applied (inactive AND disableWhenDisconnected is true)
   */
  private shouldApplyOverlay(): boolean {
    if (this._isActive) return false;

    const globalSettings = getGlobalSettings();

    return globalSettings.disableWhenDisconnected;
  }

  /**
   * Apply the appropriate image based on active state and global settings.
   * @param svg - The original SVG
   * @returns The final image (with or without overlay)
   */
  private applyOverlayIfNeeded(svg: string): string {
    return this.shouldApplyOverlay() ? applyInactiveOverlay(svg) : svg;
  }

  /**
   * Toggle active state for this action instance.
   * When inactive and disableWhenDisconnected is enabled, all stored images will have an overlay applied.
   *
   * @param isActive - Whether this action should appear active
   */
  setActive(isActive: boolean): void {
    if (this._isActive === isActive) return;

    this.logger.info(`setActive: ${this._isActive} -> ${isActive}`);
    this._isActive = isActive;

    const applyOverlay = this.shouldApplyOverlay();
    this.logger.info(`Refreshing ${this.contexts.size} contexts with overlay=${applyOverlay}`);

    for (const [contextId, { action, svg }] of this.contexts) {
      const finalImage = this.applyOverlayIfNeeded(svg);
      this.logger.trace(`Updating context ${contextId} image`);
      // Fire and forget - we don't want to block
      action.setImage(finalImage).catch((err) => {
        this.logger.warn(`Failed to update image for context ${contextId}: ${err}`);
      });
    }
  }

  /**
   * Get the current active state for this action
   */
  getIsActive(): boolean {
    return this._isActive;
  }

  /**
   * Set the key image for an action. The image is stored for later reference.
   * If inactive, the grayscale overlay is applied automatically.
   *
   * @param ev - The event containing the action reference
   * @param svg - Raw SVG string or base64 data URI
   */
  protected async setKeyImage(ev: KeyCompatibleEvent<T>, svg: string): Promise<void> {
    if (!ev.action.isKey()) {
      this.logger.debug(`setKeyImage: skipping non-key action ${ev.action.id}`);

      return;
    }

    const keyAction = ev.action as KeyAction<T>;

    // Store original SVG for later refresh (always, even during flag overlay)
    this.contexts.set(ev.action.id, { action: keyAction, svg });
    this.logger.debug(`setKeyImage: stored context ${ev.action.id}, isActive=${this._isActive}`);

    // Skip visual update if flag overlay is active for this context
    if (this.flagOverlayActive.has(ev.action.id)) {
      this.logger.trace(`setKeyImage: skipped visual update (flag overlay active) for ${ev.action.id}`);

      return;
    }

    // Apply overlay if inactive and global setting is enabled
    const finalImage = this.applyOverlayIfNeeded(svg);
    await keyAction.setImage(finalImage);
    this.logger.trace(`setKeyImage: image set for ${ev.action.id}`);
  }

  /**
   * Get the stored original SVG for a context
   */
  protected getKeyImage(contextId: string): string | undefined {
    return this.contexts.get(contextId)?.svg;
  }

  /**
   * Update the key image for a context using a new SVG.
   * Uses the stored action reference from a previous setKeyImage call.
   * If inactive, the grayscale overlay is applied automatically.
   *
   * @param contextId - The context ID to update
   * @param svg - Raw SVG string or base64 data URI
   * @returns true if the context was found and updated, false otherwise
   */
  protected async updateKeyImage(contextId: string, svg: string): Promise<boolean> {
    const entry = this.contexts.get(contextId);

    if (!entry) {
      this.logger.debug(`updateKeyImage: context ${contextId} not found`);

      return false;
    }

    // Store original SVG for later refresh (always, even during flag overlay)
    entry.svg = svg;

    // Skip visual update if flag overlay is active for this context
    if (this.flagOverlayActive.has(contextId)) {
      this.logger.trace(`updateKeyImage: skipped visual update (flag overlay active) for ${contextId}`);

      return true;
    }

    // Apply overlay if inactive and global setting is enabled
    const finalImage = this.applyOverlayIfNeeded(svg);
    await entry.action.setImage(finalImage);
    this.logger.trace(`updateKeyImage: updated ${contextId}, isActive=${this._isActive}`);

    return true;
  }

  /**
   * Called when the action appears on the Stream Deck.
   * Tracks flag overlay opt-in from settings.
   *
   * Subclasses should call `super.onWillAppear(ev)` if they override this.
   */
  override async onWillAppear(ev: WillAppearEvent<T>): Promise<void> {
    const settings = ev.payload.settings as Record<string, unknown>;

    if (settings.flagsOverlay === true || settings.flagsOverlay === "true") {
      this.flagOverlayContexts.add(ev.action.id);
      this.ensureFlagTelemetrySubscription();
      this.logger.debug(`Flag overlay enabled for context ${ev.action.id}`);
    }
  }

  /**
   * Called when action settings change from the Property Inspector.
   * Updates flag overlay opt-in.
   *
   * Subclasses should call `super.onDidReceiveSettings(ev)` if they override this.
   */
  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<T>): Promise<void> {
    const settings = ev.payload.settings as Record<string, unknown>;

    if (settings.flagsOverlay === true || settings.flagsOverlay === "true") {
      this.flagOverlayContexts.add(ev.action.id);
      this.ensureFlagTelemetrySubscription();
    } else {
      this.flagOverlayContexts.delete(ev.action.id);

      // Restore original image if flag overlay was active
      if (this.flagOverlayActive.delete(ev.action.id)) {
        this.restoreFlagOverlayImage(ev.action.id);
      }

      this.cleanupFlagSubscriptionIfUnneeded();
    }
  }

  /**
   * Called when the action disappears from the Stream Deck.
   * Cleans up stored context.
   *
   * Subclasses should call `super.onWillDisappear(ev)` if they override this.
   */
  override async onWillDisappear(ev: WillDisappearEvent<T>): Promise<void> {
    this.flagOverlayContexts.delete(ev.action.id);
    this.flagOverlayActive.delete(ev.action.id);
    this.cleanupFlagSubscriptionIfUnneeded();
    this.contexts.delete(ev.action.id);
    this.logger.debug(`onWillDisappear: removed context ${ev.action.id}, remaining=${this.contexts.size}`);
  }

  /**
   * Generate a solid-color SVG for a flag overlay.
   */
  protected generateFlagOverlaySvg(flagInfo: FlagInfo): string {
    return svgToDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><rect width="72" height="72" rx="8" fill="${flagInfo.color}"/></svg>`,
    );
  }

  /**
   * Ensure a single telemetry subscription exists for flag overlay.
   */
  private ensureFlagTelemetrySubscription(): void {
    if (this.flagTelemetrySubId) return;

    try {
      const controller = getController();
      const subId = `${BaseAction.FLAG_SUBSCRIPTION_PREFIX}${Date.now()}`;
      this.flagTelemetrySubId = subId;

      controller.subscribe(subId, (telemetry, isConnected) => {
        if (!isConnected) {
          this.onFlagTelemetryUpdate(undefined);

          return;
        }

        this.onFlagTelemetryUpdate(telemetry?.SessionFlags);
      });

      this.logger.debug("Flag overlay telemetry subscription started");
    } catch {
      this.logger.debug("Flag overlay: SDK not initialized, skipping telemetry subscription");
    }
  }

  /**
   * Process telemetry update for flag detection.
   */
  private onFlagTelemetryUpdate(sessionFlags: number | undefined): void {
    const flags = resolveAllActiveFlags(sessionFlags);
    const stateKey = flags.map((f) => f.label).join(",");

    if (stateKey === this.lastFlagStateKey) return;

    this.lastFlagStateKey = stateKey;
    this.currentFlags = flags;
    this.flagFlashIndex = 0;

    if (flags.length > 0) {
      this.startFlagFlash();
    } else {
      this.stopFlagFlash();
    }
  }

  /**
   * Start or restart the flag flash timer.
   */
  private startFlagFlash(): void {
    // Clear existing timer to prevent leaks
    if (this.flagFlashTimer) {
      clearInterval(this.flagFlashTimer);
    }

    // Immediately show first flag
    this.applyFlagOverlayToContexts();

    this.flagFlashTimer = setInterval(() => {
      this.flagFlashIndex++;
      this.applyFlagOverlayToContexts();
    }, BaseAction.FLAG_FLASH_INTERVAL_MS);
  }

  /**
   * Stop the flag flash timer and restore original images.
   */
  private stopFlagFlash(): void {
    if (this.flagFlashTimer) {
      clearInterval(this.flagFlashTimer);
      this.flagFlashTimer = null;
    }

    // Restore all overlay-active contexts
    for (const contextId of this.flagOverlayActive) {
      this.restoreFlagOverlayImage(contextId);
    }

    this.flagOverlayActive.clear();
  }

  /**
   * Apply the current flag color to all overlay-enabled contexts.
   */
  private applyFlagOverlayToContexts(): void {
    if (this.currentFlags.length === 0) return;

    const flagInfo = this.currentFlags[this.flagFlashIndex % this.currentFlags.length];
    const flagSvg = this.generateFlagOverlaySvg(flagInfo);

    for (const contextId of this.flagOverlayContexts) {
      const entry = this.contexts.get(contextId);

      if (!entry) continue;

      this.flagOverlayActive.add(contextId);
      entry.action.setImage(flagSvg).catch((err) => {
        this.logger.warn(`Failed to set flag overlay for context ${contextId}: ${err}`);
      });
    }
  }

  /**
   * Restore the original image for a context after flag overlay ends.
   */
  private restoreFlagOverlayImage(contextId: string): void {
    const entry = this.contexts.get(contextId);

    if (!entry) return;

    const finalImage = this.applyOverlayIfNeeded(entry.svg);
    entry.action.setImage(finalImage).catch((err) => {
      this.logger.warn(`Failed to restore image for context ${contextId}: ${err}`);
    });
  }

  /**
   * Unsubscribe from telemetry if no contexts need flag overlay.
   */
  private cleanupFlagSubscriptionIfUnneeded(): void {
    if (this.flagOverlayContexts.size > 0 || !this.flagTelemetrySubId) return;

    try {
      const controller = getController();
      controller.unsubscribe(this.flagTelemetrySubId);
    } catch {
      // SDK may not be initialized
    }

    this.flagTelemetrySubId = null;
    this.stopFlagFlash();
    this.logger.debug("Flag overlay telemetry subscription stopped");
  }
}
