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
 */
const EMPTY_CONTEXT: TemplateContext = { display: {}, raw: {} };

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
 */
export function resolveTitleTemplate(text: string): string {
  if (!text.includes("{{")) return text;

  let context: TemplateContext | null = null;

  try {
    context = getController().getCurrentTemplateContext();
  } catch {
    // SDK singleton not initialized (e.g. tests) — resolve against the empty context
  }

  return resolveTemplate(text, context ?? EMPTY_CONTEXT);
}
