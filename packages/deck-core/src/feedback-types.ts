/**
 * Platform-Agnostic Encoder Touch-Strip Feedback
 *
 * Models the Stream Deck+ encoder touchscreen ("touch strip") feedback payload
 * without importing any vendor SDK, keeping deck-core platform-neutral. Values
 * are keyed by the layout item's `key`; each value is either a primitive
 * (`number` for bar/gbar fill, `string` for text/pixmap source) or a partial
 * object overriding the item's mutable visual properties. Platforms without a
 * plugin-drawable touch strip (e.g. Mirabox) ignore these payloads.
 */

/** Mutable properties of a bar/gbar layout item. */
export interface DeckFeedbackBarItem {
  value?: number;
  enabled?: boolean;
  opacity?: number;
  bar_bg_c?: string;
  bar_fill_c?: string;
  bar_border_c?: string;
  border_w?: number;
  range?: { min: number; max: number };
  subtype?: number;
  background?: string;
}

/** Mutable properties of a text layout item. */
export interface DeckFeedbackTextItem {
  value?: string;
  enabled?: boolean;
  opacity?: number;
  color?: string;
  alignment?: "left" | "center" | "right";
  font?: { size?: number; weight?: number };
  background?: string;
}

/** Mutable properties of a pixmap (image) layout item. */
export interface DeckFeedbackPixmapItem {
  value?: string;
  enabled?: boolean;
  opacity?: number;
  background?: string;
}

/** A single feedback item value: a primitive shorthand or a partial item override. */
export type DeckFeedbackValue = number | string | DeckFeedbackBarItem | DeckFeedbackTextItem | DeckFeedbackPixmapItem;

/** Encoder touch-strip update payload, keyed by layout item `key`. */
export type DeckFeedbackPayload = Record<string, DeckFeedbackValue>;
