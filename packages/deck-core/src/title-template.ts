/**
 * Title Template Resolution (issue #899)
 *
 * Resolves Mustache template placeholders ({{variable}} and {{= expression }})
 * in user-entered key title text against the live telemetry template context —
 * the same context Telemetry Display values use.
 *
 * Lives in deck-core (not @iracedeck/icon-composer) so the icon assembly
 * package stays zero-dependency: title text is resolved before it flows into
 * resolveTitleSettings/assembleIcon.
 */
import { resolveTemplate, type TemplateContext } from "@iracedeck/iracing-sdk";

import { getController } from "./sdk-singleton.js";

/**
 * Empty context used when the sim is disconnected or the SDK singleton is not
 * initialized: {{variable}} placeholders render empty and {{= expression }}
 * parse errors stay visible — the same rules Telemetry Display values follow.
 * Exported so other display paths that read `getCurrentTemplateContext()`
 * (Chat's key text, #1337) fall back the same way instead of defining their own.
 */
export const EMPTY_TEMPLATE_CONTEXT: TemplateContext = Object.freeze({
  // Inline rather than templateContextFromMaps({}): a module-scope call into
  // iracing-sdk would break every test that mocks that package without it.
  display: () => undefined,
  raw: () => ({ found: false }),
});

/**
 * True when user-entered title text contains a template placeholder.
 * The cheap gate that keeps titles without templates at zero overhead.
 */
export function titleHasTemplate(text: string | undefined): boolean {
  return typeof text === "string" && text.includes("{{");
}

/**
 * Resolves {{…}} placeholders in user-entered title text against the current
 * telemetry template context. Text without placeholders is returned unchanged
 * without consulting the SDK.
 *
 * Never throws. The context builds its namespaces lazily, on the first lookup
 * of a path in them (#1339), so a builder that throws (a malformed driver
 * entry, the live-order provider) does so inside `resolveTemplate`, not inside
 * `getCurrentTemplateContext()`. Such a throw resolves the title against the
 * empty context, as a throw from the eager build did before. It must not
 * escape: `BaseAction`'s title tick runs inside the SDK's subscriber fan-out,
 * where a throw would skip every later subscriber, every frame.
 */
export function resolveTitleTemplate(text: string): string {
  if (!text.includes("{{")) return text;

  let context: TemplateContext | null = null;

  try {
    context = getController().getCurrentTemplateContext();
  } catch {
    // SDK singleton not initialized (e.g. tests) — resolve against the empty context
  }

  if (context) {
    try {
      return resolveTemplate(text, context);
    } catch {
      // A namespace builder threw — fall through to the empty context
    }
  }

  return resolveTemplate(text, EMPTY_TEMPLATE_CONTEXT);
}
