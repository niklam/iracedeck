/**
 * Base Action for Stream Deck
 *
 * Abstract base class that extends SingletonAction with:
 * - SVG image management
 * - Per-instance active/inactive state tracking
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
import { type ILogger, silentLogger } from "@iracedeck/logger";

import { applyInactiveOverlay } from "./overlay-utils.js";

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

  /**
   * Toggle active state for this action instance.
   * When inactive, all stored images will have an overlay applied.
   *
   * @param isActive - Whether this action should appear active
   */
  setActive(isActive: boolean): void {
    if (this._isActive === isActive) return;

    this.logger.info(`setActive: ${this._isActive} -> ${isActive}`);
    this._isActive = isActive;

    // Refresh all contexts with new active state
    this.logger.info(`Refreshing ${this.contexts.size} contexts with overlay=${!isActive}`);

    for (const [contextId, { action, svg }] of this.contexts) {
      const finalImage = isActive ? svg : applyInactiveOverlay(svg);
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

    // Store original SVG for later refresh
    this.contexts.set(ev.action.id, { action: keyAction, svg });
    this.logger.debug(`setKeyImage: stored context ${ev.action.id}, isActive=${this._isActive}`);

    // Apply overlay if inactive
    const finalImage = this._isActive ? svg : applyInactiveOverlay(svg);
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

    // Store original SVG for later refresh
    entry.svg = svg;

    // Apply overlay if inactive
    const finalImage = this._isActive ? svg : applyInactiveOverlay(svg);
    await entry.action.setImage(finalImage);
    this.logger.trace(`updateKeyImage: updated ${contextId}, isActive=${this._isActive}`);

    return true;
  }

  /**
   * Called when the action disappears from the Stream Deck.
   * Cleans up stored context.
   *
   * Subclasses should call `super.onWillDisappear(ev)` if they override this.
   */
  override async onWillDisappear(ev: WillDisappearEvent<T>): Promise<void> {
    this.contexts.delete(ev.action.id);
    this.logger.debug(`onWillDisappear: removed context ${ev.action.id}, remaining=${this.contexts.size}`);
  }
}
