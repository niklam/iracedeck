/**
 * Template Resolver
 *
 * General-purpose template resolution with two placeholder kinds:
 *
 * - `{{dot.notation}}` — variable lookup against the context's display map
 *   (display-formatted strings). Unresolved variables become empty strings.
 * - `{{= expression }}` — safe expression evaluated against the context's raw
 *   map (full-precision values).
 *
 * Expression error behavior is hybrid: a parse error (typo in the expression)
 * leaves the `{{= ... }}` placeholder verbatim in the output so the mistake is
 * visible; a runtime error (e.g. unknown variable) renders an empty string.
 *
 * Limitation: `}}` cannot appear inside an expression's string literal — the
 * placeholder ends at the first `}}`.
 *
 * Pure string processing — no SDK or telemetry dependency.
 */
import { resolveExpression } from "./expression-evaluator.js";
import type { TemplateContext } from "./template-context.js";

const TEMPLATE_PATTERN = /\{\{=([\s\S]*?)\}\}|\{\{([a-zA-Z0-9_.]+)\}\}/g;

/**
 * Resolves {{dot.notation}} and {{= expression }} placeholders in a template string.
 *
 * @param template - String with {{variable}} and/or {{= expression }} placeholders
 * @param context - Combined template context (display strings + raw values)
 * @returns Resolved string with all placeholders replaced
 */
export function resolveTemplate(template: string, context: TemplateContext): string {
  return template.replace(TEMPLATE_PATTERN, (match, expr: string | undefined, path: string | undefined) => {
    if (expr !== undefined) {
      const result = resolveExpression(expr, context.raw);

      return result === null ? match : result;
    }

    const value = context.display[path as string];

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
