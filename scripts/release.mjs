import { execSync, spawnSync } from "node:child_process";

if (!process.env.GITHUB_TOKEN) {
  try {
    process.env.GITHUB_TOKEN = execSync("gh auth token", { encoding: "utf-8" }).trim();
  } catch {
    console.warn("Warning: Could not get GitHub token from gh CLI. GitHub Releases may fail.");
  }
}

// Forward args as an array (not a joined string) so flags like
// --preRelease=alpha and --dry-run survive cross-shell quoting on Windows.
// pnpm forwards a literal "--" separator when users invoke
// `pnpm release -- minor --preRelease=alpha`; release-it treats that
// sentinel as a positional arg and silently drops everything after it,
// so strip it before forwarding.
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

// Signal dry-run to the before:bump hook so it skips file writes and `git add`.
// release-it does not stop hooks during dry-run, so without this the hook
// mangles package.json / manifest.json even when the user only wanted a preview.
if (args.some((a) => a === "--dry-run" || a === "-d" || a === "--dry-run=true")) {
  process.env.RELEASE_IT_DRY_RUN = "1";
}

const result = spawnSync("npx", ["release-it", ...args], {
  stdio: "inherit",
  env: process.env,
  shell: true,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
