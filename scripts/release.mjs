import { execSync } from "node:child_process";

// Set GITHUB_TOKEN from gh CLI if not already set
if (!process.env.GITHUB_TOKEN) {
  try {
    process.env.GITHUB_TOKEN = execSync("gh auth token", { encoding: "utf-8" }).trim();
  } catch {
    console.warn("Warning: Could not get GitHub token from gh CLI. GitHub Releases may fail.");
  }
}

// Forward all args to release-it
const args = process.argv.slice(2).join(" ");
execSync(`npx release-it ${args}`, { stdio: "inherit", env: process.env });
