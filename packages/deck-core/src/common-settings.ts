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
/**
 * Schema for per-action color overrides.
 * Only set fields override; unset fields fall through to global → icon default.
 */
export const ColorOverridesSchema = z
  .object({
    backgroundColor: z.string().optional(),
    textColor: z.string().optional(),
    graphic1Color: z.string().optional(),
    graphic2Color: z.string().optional(),
  })
  .optional();

export type ColorOverrides = z.infer<typeof ColorOverridesSchema>;

export const CommonSettings = z.object({
  flagsOverlay: z
    .union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .optional(),
  colorOverrides: ColorOverridesSchema,
});

export type CommonSettings = z.infer<typeof CommonSettings>;
