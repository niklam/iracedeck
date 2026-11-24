/**
 * Black Box Selector — the dial's rotation vocabulary (#1585, #1662).
 *
 * What a turn of the dial can do, and where Switch Select / Adjust takes each
 * rotation. The surface (`black-box-selector-dial-surface.ts`) builds its
 * schema, key map and gesture dispatch on these, and the renderers
 * (`black-box-selector-dial-render.ts`) pick a drawing by them, so they live
 * here, below both: the render module imports nothing from its surface, and
 * this module imports nothing at all.
 */

/**
 * What a turn of the dial does (#1585): step through the boxes, walk the open
 * box's controls, or change the selected control. `boxes` is first and the
 * default, so a dial stored before the choice existed keeps cycling boxes.
 */
export const ROTATIONS = ["boxes", "select-control", "adjust-control"] as const;
export type DialRotation = (typeof ROTATIONS)[number];

/** The rotations Switch Select / Adjust moves between: every rotation but `boxes`. */
export type SwitchableRotation = Exclude<DialRotation, "boxes">;

/**
 * The rotation `switch-rotation` takes each rotation to (#1585): Select Control
 * and Adjust Control swap. `boxes` has no entry, so the gesture does nothing on
 * a dial that cycles boxes — it never takes a dial to or from `boxes`.
 */
export const SWITCHED_ROTATION: Partial<Record<DialRotation, SwitchableRotation>> = {
  "select-control": "adjust-control",
  "adjust-control": "select-control",
};
