/**
 * The `npm install` a plugin's `bin/` folder runs at build time, in an
 * environment npm does not warn about (#1205).
 *
 * The plugin builds run under `pnpm run`, which exports its settings as
 * `npm_config_*` variables: its own (`verify-deps-before-run`, `_jsr-registry`,
 * `npm-globalconfig`, `reporter` under `--silent`) and every key of any `.npmrc`
 * it read, pnpm-only ones such as `auto-install-peers` included. npm warns once
 * per key it does not define, on every install — eighteen identical lines per
 * full build on a stock machine, burying the warnings that matter.
 *
 * So the install keeps only the keys npm itself defines, and asks npm for that
 * list (`npm config ls -l --json`) rather than carrying one: a hand-kept list
 * missed whatever a contributor's own `.npmrc` held, and would drift with every
 * npm release. Keys npm defines stay exactly as pnpm passed them — `bin/` has no
 * `.npmrc` of its own, so settings such as `registry` or a proxy reach npm only
 * through this environment, and the install is otherwise the one it always was.
 */

/** Credential keys npm accepts but leaves out of `npm config ls`. */
const CREDENTIAL_KEYS = new Set(["_auth", "_authtoken", "_password", "username", "email", "certfile", "keyfile"]);

const NPM_CONFIG_PREFIX = "npm_config_";

/**
 * The npm config key an environment variable sets, spelled the way npm spells
 * it (`npm_config__jsr_registry` → `_jsr-registry`), or `null` for any other
 * variable. Mirrors `@npmcli/config`: the prefix is case-insensitive, and every
 * underscore but a leading one becomes a hyphen.
 *
 * @param {string} name
 * @returns {string | null}
 */
export function npmConfigKey(name) {
  if (name.slice(0, NPM_CONFIG_PREFIX.length).toLowerCase() !== NPM_CONFIG_PREFIX) return null;
  return name
    .slice(NPM_CONFIG_PREFIX.length)
    .replace(/(?!^)_/g, "-")
    .toLowerCase();
}

/**
 * A copy of `env` with no `npm_config_*` variable at all — what `npm config ls`
 * runs in, so listing the defined keys prints no warning of its own.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function withoutNpmConfig(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => npmConfigKey(name) === null));
}

/**
 * A copy of `env` keeping only the `npm_config_*` variables npm defines — the
 * keys in `definedKeys`, the credential keys, and scoped keys (anything with a
 * `:`, such as `//registry.example/:_authToken`), which npm never warns about.
 *
 * @param {Record<string, string | undefined>} env
 * @param {Set<string>} definedKeys npm's config keys, as `npm config ls` spells them.
 * @returns {Record<string, string | undefined>}
 */
export function runtimeInstallEnv(env, definedKeys) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => {
      const key = npmConfigKey(name);
      return key === null || definedKeys.has(key) || CREDENTIAL_KEYS.has(key) || key.includes(":");
    }),
  );
}

/**
 * Runs `npm install` in `binDir`. Returns an exit code rather than exiting.
 *
 * @param {string | undefined} binDir
 * @param {{
 *   env: Record<string, string | undefined>,
 *   exists: (path: string) => boolean,
 *   run: (command: string, options: { cwd?: string, env: Record<string, string | undefined>, capture: boolean }) => { status: number | null, stdout?: string, error?: Error },
 *   log: (message: string) => void,
 * }} io `run` spawns through a shell, since npm is `npm.cmd` on Windows; the
 *   commands are constants, so nothing is interpolated into one.
 * @returns {number}
 */
export function installRuntimeDeps(binDir, { env, exists, run, log }) {
  if (!binDir) {
    log("usage: node scripts/install-runtime-deps.mjs <bin folder>");
    return 2;
  }
  if (!exists(binDir)) {
    log(`install-runtime-deps: ${binDir} does not exist — did the rollup build emit it?`);
    return 1;
  }

  const listed = run("npm config ls -l --json", { env: withoutNpmConfig(env), capture: true });
  if (listed.error || listed.status !== 0) {
    log(`install-runtime-deps: \`npm config ls -l --json\` failed${listed.error ? `: ${listed.error.message}` : ""}`);
    return 1;
  }
  let definedKeys;
  try {
    definedKeys = new Set(Object.keys(JSON.parse(listed.stdout ?? "")));
  } catch (error) {
    log(`install-runtime-deps: could not parse \`npm config ls -l --json\`: ${error.message}`);
    return 1;
  }

  const installed = run("npm install", { cwd: binDir, env: runtimeInstallEnv(env, definedKeys), capture: false });
  if (installed.error) {
    log(`install-runtime-deps: \`npm install\` in ${binDir} failed: ${installed.error.message}`);
    return 1;
  }
  return installed.status ?? 1;
}
