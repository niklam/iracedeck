/**
 * Template Resolver
 *
 * General-purpose template resolution with {{dot.notation}} variable support.
 * Pure string processing — no SDK or telemetry dependency.
 */

/**
 * Resolves {{dot.notation}} placeholders in a template string.
 * Walks nested objects using dot-separated paths.
 * Unresolved variables become empty strings.
 *
 * @param template - String with {{variable}} placeholders
 * @param context - Nested object with values to substitute
 * @returns Resolved string with all placeholders replaced
 */
export function resolveTemplate(template: string, context: object): string {
  return template.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_match, path: string) => {
    const value = resolvePathValue(context as Record<string, unknown>, path);

    return value !== undefined && value !== null ? String(value) : "";
  });
}

/**
 * @internal Exported for testing
 *
 * Looks up a dot-notation key in a flat record.
 */
export function resolvePathValue(obj: Record<string, unknown>, path: string): unknown {
  return obj[path];
}
