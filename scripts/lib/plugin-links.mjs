/**
 * Where each deck host expects the dev plugin to be linked, and what its link
 * currently points at.
 *
 * This lived in `scripts/claude-hooks/lib.mjs` until #1143, where a second
 * caller appeared outside the hooks: `pnpm dev:voices` relinks the hosts that
 * point at the worktree it just rebuilt. The hooks lib re-exports both
 * functions, so its own callers and tests are untouched.
 *
 * Every path is derived from the environment rather than written out literally,
 * so a non-standard Windows install follows along; `MIRABOX_PLUGINS_DIR` and
 * `ULANZI_PLUGINS_DIR` are the same overrides `lib/deck-hosts.mjs` honours (and
 * that `lib/env-local.mjs` loads from a gitignored `.env.local`).
 */
import { existsSync, readlinkSync } from "node:fs";
import path from "node:path";

/**
 * What `linkTargets` reports as the target when something occupies the link
 * path but is not a link at all — a packaged build the host installed itself.
 * Exported so a caller can tell it apart from a path: it is deliberately not
 * one, and comparing it against a directory would read as "linked elsewhere".
 */
export const REAL_DIRECTORY = "(a real directory, not a link)";

/** Where each deck host expects the dev plugin to be linked. */
export function linkLocations(env = process.env) {
  const appdata = env.APPDATA;
  if (!appdata) return [];
  return [
    {
      host: "Stream Deck",
      link: path.join(appdata, "Elgato", "StreamDeck", "Plugins", "com.iracedeck.sd.core.sdPlugin"),
    },
    {
      host: "Mirabox",
      link: path.join(
        env.MIRABOX_PLUGINS_DIR ?? path.join(appdata, "HotSpot", "StreamDock", "plugins"),
        "com.iracedeck.sd.core.sdPlugin",
      ),
    },
    {
      host: "Ulanzi",
      link: path.join(
        env.ULANZI_PLUGINS_DIR ?? path.join(appdata, "Ulanzi", "UlanziDeck", "Plugins"),
        "com.ulanzi.iracedeck.ulanziPlugin",
      ),
    },
  ];
}

/** `[{ host, link, target }]` — the symlink/junction target per host, `undefined` when not linked. */
export function linkTargets(env = process.env) {
  return linkLocations(env).map(({ host, link }) => {
    let target;
    try {
      target = path.resolve(readlinkSync(link));
    } catch {
      target = existsSync(link) ? REAL_DIRECTORY : undefined;
    }
    return { host, link, target };
  });
}
