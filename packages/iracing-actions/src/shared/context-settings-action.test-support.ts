/**
 * The settings half of `BaseAction` for an action test's fake base class
 * (#1761): the REAL `ContextSettings` record from `@iracedeck/deck-core/testing`,
 * driven from the lifecycle handlers as `BaseAction` drives it, so an action
 * that writes through `updateSettings` runs the real semantics in its test —
 * the write merges onto the newest record, a superseded event parks its
 * updater for the next `didReceiveSettings`, an unchanged updater writes
 * nothing, a disappeared context writes nothing, and a rejected write is
 * warned and never thrown.
 *
 * A test file that mocks `@iracedeck/deck-core` extends it from inside the
 * factory, by dynamic import, since the factory is hoisted above the file's
 * imports:
 *
 * ```ts
 * vi.mock("@iracedeck/deck-core", async () => {
 *   const { ContextSettingsActionBase } = await import("../../shared/context-settings-action.test-support.js");
 *
 *   return {
 *     ConnectionStateAwareAction: class extends ContextSettingsActionBase {
 *       logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
 *     },
 *   };
 * });
 * ```
 *
 * `BaseAction`'s first-appearance `addedWithVersion` stamp is off by default,
 * so a test's write assertions see only the action's own writes; a test of the
 * stamp's interplay with those writes turns it on with
 * {@link ContextSettingsActionBase.stampVersion} and turns it off afterwards.
 */
import type { IDeckEvent } from "@iracedeck/deck-core";
import { ContextSettings, type ContextSettingsUpdater } from "@iracedeck/deck-core/testing";
import type { ILogger } from "@iracedeck/logger";

export class ContextSettingsActionBase {
  /**
   * The `addedWithVersion` the fake stamps on a context's appearance, as
   * `BaseAction.onWillAppear` does with the plugin version, or `undefined`
   * (the default) for no stamp. Set it in a test and reset it after.
   */
  static stampVersion: string | undefined = undefined;

  /**
   * The record, logging to the subclass's `logger` field, read at each line
   * (the field is initialised after this one). `ContextSettings` writes only
   * `debug` and `warn`, which every fake's logger carries.
   */
  private readonly contextSettings = new ContextSettings(() => (this as unknown as { logger: ILogger }).logger);

  /** As `BaseAction.getContextSettings`: the newest settings the plugin holds for the context. */
  protected getContextSettings(contextId: string): Readonly<Record<string, unknown>> | undefined {
    return this.contextSettings.get(contextId);
  }

  /** As `BaseAction.updateSettings`: a write computed from the context's newest settings. */
  protected updateSettings(ev: IDeckEvent<unknown>, update: ContextSettingsUpdater): Promise<boolean> {
    return this.contextSettings.update(ev, update);
  }

  /**
   * As `BaseAction.onWillAppear`: records the delivered settings, then starts
   * the stamp (when {@link stampVersion} is set) synchronously and awaits it last.
   */
  async onWillAppear(ev: IDeckEvent<unknown>): Promise<void> {
    this.contextSettings.appear(ev);

    const version = ContextSettingsActionBase.stampVersion;

    if (version === undefined) return;

    await this.updateSettings(ev, (current) =>
      current.addedWithVersion ? undefined : { ...current, addedWithVersion: version },
    );
  }

  /** As `BaseAction.onDidReceiveSettings`: records the new settings and re-runs any parked write. */
  async onDidReceiveSettings(ev: IDeckEvent<unknown>): Promise<void> {
    await this.contextSettings.receive(ev);
  }

  /** As `BaseAction.onWillDisappear`: drops the context's record and any parked write. */
  async onWillDisappear(ev: IDeckEvent<unknown>): Promise<void> {
    this.contextSettings.disappear(ev.action.id);
  }
}
