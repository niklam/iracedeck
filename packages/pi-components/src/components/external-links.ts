/**
 * Open external Property Inspector links in the user's default browser (issue #243).
 *
 * Links inside a PI — Documentation (`docs-link.ejs`), Downloads (`version.ejs`),
 * the template-variable references in the Chat and Telemetry Display actions, and
 * any future link — otherwise open in the deck app's small built-in browser. No PI
 * link ever wants that, so a single delegated click handler reroutes every external
 * `http(s)` anchor click through sdpi-components' built-in `openUrl` event.
 *
 * That event reaches the OS default browser on every host: Elgato handles it
 * natively, the VSD (Mirabox) host — which speaks the Elgato PI protocol directly —
 * receives it, and the Ulanzi PI bridge translates it to its own `openurl` cmd
 * (`src/ulanzi-bridge/translate.ts`). No plugin-side code is needed.
 */

/** Minimal shape of the sdpi-components client this handler depends on. */
interface StreamDeckClientLike {
  send(event: string, payload?: Record<string, unknown>): unknown;
}

interface SDPIComponentsGlobal {
  SDPIComponents?: { streamDeckClient?: StreamDeckClientLike };
}

/** Read the sdpi-components client off the global scope, if it has loaded. */
function defaultClient(): StreamDeckClientLike | undefined {
  return (globalThis as SDPIComponentsGlobal).SDPIComponents?.streamDeckClient;
}

/**
 * Resolve the absolute URL to open for a clicked element, or `null` when the click
 * should keep its default behavior. Walks up to the nearest `<a>` and reads its
 * resolved `.href`/`.protocol` (so protocol-relative and whitespace-padded hrefs
 * are normalized), accepting only `http(s)` — the SDK can't open other schemes
 * (e.g. `mailto:`, `app://`) or in-PI/relative targets.
 */
export function resolveExternalUrl(target: EventTarget | null): string | null {
  const anchor = target instanceof Element ? target.closest("a") : null;

  if (!anchor) return null;

  // `.protocol` is normalized + lowercased; `.href` is the resolved absolute URL.
  return anchor.protocol === "http:" || anchor.protocol === "https:" ? anchor.href : null;
}

/** Documents that already have the click handler installed (idempotency guard). */
const installedDocs = new WeakSet<Document>();

/**
 * Install a single delegated click handler that reroutes external `http(s)` link
 * clicks through sdpi-components' `openUrl` event. Idempotent per document, so the
 * bundle being evaluated more than once never registers duplicate listeners.
 *
 * We only intercept (call `preventDefault`) when the sdpi-components client is
 * present, so if the library failed to load the link keeps working through the
 * built-in browser rather than silently doing nothing. `doc`/`getClient` are
 * injectable for testing; in the browser they default to the document and the
 * global sdpi-components client resolved at click time.
 */
export function installExternalLinkHandler(
  doc: Document = document,
  getClient: () => StreamDeckClientLike | undefined = defaultClient,
): void {
  if (installedDocs.has(doc)) return;

  installedDocs.add(doc);

  doc.addEventListener("click", (ev) => {
    const url = resolveExternalUrl(ev.target);

    if (!url) return;

    const client = getClient();

    // No client (sdpi-components unavailable): fall back to default link behavior.
    if (!client) return;

    ev.preventDefault();
    // Fire-and-forget; swallow rejections (e.g. the PI socket isn't ready yet) so a
    // failed send never surfaces as an unhandled promise rejection.
    void Promise.resolve(client.send("openUrl", { url })).catch(() => {});
  });
}
