/**
 * Loads a gitignored `.env.local` from the repo root into an environment object.
 *
 * The shell always wins: a variable that is already set is never overwritten,
 * so `MIRABOX_PLUGINS_DIR=... pnpm link:mirabox` overrides the file.
 *
 * Extracted in #1040. `link-mirabox.mjs` and `unlink-mirabox.mjs` each carried
 * their own copy of this; adding the Ulanzi pair would have made it four.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {string} root Repo root containing `.env.local`.
 * @param {Record<string, string | undefined>} env Environment to populate.
 */
export function loadEnvLocal(root, env = process.env) {
  const envPath = join(root, ".env.local");
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && env[match[1]] === undefined) {
      env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}
