import z from "zod";

/**
 * Common settings shared by all actions.
 * All action settings schemas should extend this.
 *
 * @example
 * ```typescript
 * const MyActionSettings = CommonSettings.extend({
 *   direction: z.enum(["next", "previous"]).default("next"),
 * });
 * ```
 */
export const CommonSettings = z.object({
  flagsOverlay: z
    .union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .optional(),
});

export type CommonSettings = z.infer<typeof CommonSettings>;
