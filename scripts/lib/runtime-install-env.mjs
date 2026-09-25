/**
 * The environment a plugin's `bin/` folder runs `npm install` in (#1205).
 *
 * The plugin builds run under `pnpm run`, which exports its own settings as
 * `npm_config_*` variables. A few of those are pnpm's alone, and npm warns once
 * per key per invocation that it does not recognise them — eighteen identical
 * warnings on every full build, burying the ones that matter.
 *
 * Only the keys npm rejects are removed. The rest stay because they are what the
 * install has always run with: `bin/` has no `.npmrc` of its own, so settings such
 * as `globalconfig` and `registry` reach npm only through the environment pnpm
 * passes down. A new
 * pnpm-only key is therefore not stripped until it is added here — it shows up
 * as a fresh warning, which is the loud failure wanted, rather than an install
 * that silently changed.
 */

/**
 * The pnpm-exported keys npm warns about as "Unknown env config", in env-var
 * spelling. `reporter` is exported only when the script is run with `pnpm run
 * --silent` / `--reporter`; the other three on every `pnpm run`. (pnpm also
 * exports keys with an empty value, such as `frozen_lockfile`; npm ignores those
 * without a warning, so they need no entry.)
 */
export const PNPM_ONLY_NPM_CONFIG_KEYS = [
  "npm_config__jsr_registry",
  "npm_config_npm_globalconfig",
  "npm_config_reporter",
  "npm_config_verify_deps_before_run",
];

/**
 * A copy of `env` without the pnpm-only keys. Matched case-insensitively, since
 * Windows environment names are.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function runtimeInstallEnv(env) {
  const stripped = new Set(PNPM_ONLY_NPM_CONFIG_KEYS);
  return Object.fromEntries(Object.entries(env).filter(([key]) => !stripped.has(key.toLowerCase())));
}
