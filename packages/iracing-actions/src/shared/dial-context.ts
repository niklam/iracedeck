/**
 * The one gate a dial surface puts in front of its INPUT events (#1329).
 *
 * A surface keeps per-context state in a map. Lifecycle events (`willAppear`,
 * `didReceiveSettings`) create the entry; `willDisappear` removes it. Input
 * events (`rotate`, `down`, `touchTap`) must only act on an entry that is
 * already there: a late event the host delivers after `willDisappear` would
 * otherwise bring the entry back — a leaked context, possibly an armed
 * hold-preview timer, and a frame pushed at a context that is gone. The rule
 * is in `.claude/rules/encoders-and-touchscreen.md` (rule 11).
 */

/** The dial input events that act on an existing context and never create one. */
export type DialInputEvent = "rotate" | "down" | "touchTap";

/**
 * Whether `actionId` still has a context for an input event to act on. When it
 * has none the event is dropped, logged at debug with the one wording the whole
 * dial family uses, and the caller must return before any side effect.
 */
export function hasDialInputContext(
  contexts: ReadonlyMap<string, unknown>,
  actionId: string,
  event: DialInputEvent,
  logger: { debug(message: string): void },
): boolean {
  if (contexts.has(actionId)) return true;

  logger.debug(`Dial ${event} dropped: no context for ${actionId} (it has disappeared)`);

  return false;
}
