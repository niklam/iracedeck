/**
 * Title Template Resolution (issue #899)
 *
 * Resolves Mustache template placeholders ({{variable}} and {{= expression }})
 * in user-entered key title text through the sim connection — against the same
 * context Telemetry Display values use.
 *
 * Lives in deck-core (not @iracedeck/icon-composer) so the icon assembly
 * package stays zero-dependency: title text is resolved before it flows into
 * resolveTitleSettings/assembleIcon.
 */
import type { TemplateContext } from "@iracedeck/iracing-sdk";

import { getSimConnection } from "./sim-connection.js";

/**
 * Empty context used when the sim is disconnected: {{variable}} placeholders
 * render empty and {{= expression }} parse errors stay visible — the same rules
 * Telemetry Display values follow. Exported so other display paths that read
 * a template context (Chat's key text, #1337) fall back the same way instead
 * of defining their own. Moves to `@iracedeck/deck-iracing` with
 * `IRacingSimConnection` in the next commit.
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
 * Resolves {{…}} placeholders in user-entered title text through the sim
 * connection (#899, #1351). Text without `{{` is returned without consulting
 * the connection, and a connection that throws leaves the text as the user
 * typed it.
 *
 * Never throws: `BaseAction`'s title tick runs inside the sim's subscriber
 * fan-out, where a throw would skip every later subscriber, every frame.
 */
export function resolveTitleTemplate(text: string): string {
  if (!text.includes("{{")) return text;

  try {
    return getSimConnection().resolveTitleTemplate(text);
  } catch {
    return text;
  }
}
