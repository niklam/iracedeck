// @iracedeck/app-updates: the plugin's own release notes and update checks, moved out
// of deck-core (issue #1367).

// Version-check / changelog opener (issues #680, #742, #870, #901)
export {
  buildChangelogUrl,
  CHANGELOG_BASE_URL,
  type ChangelogDecision,
  MONTHLY_WINDOW_MS,
  resolveChangelogDecision,
  runVersionCheck,
  shouldOpenChangelog,
  VERSION_CHECK_STARTUP_GRACE_MS,
} from "./version-check.js";

// Upstream update check for the settings window's What's New tab (issue #1016)
export { sanitizeChangelogHtml } from "./changelog-html-sanitize.js";
export {
  parsePublishedChangelog,
  PUBLISHED_CHANGELOG_MAX_CATEGORIES,
  PUBLISHED_CHANGELOG_MAX_ITEMS,
  PUBLISHED_CHANGELOG_MAX_RELEASES,
  type PublishedRelease,
  type PublishedReleaseCategory,
} from "./published-changelog.js";
export {
  CHANGELOG_FETCH_TIMEOUT_MS,
  CHANGELOG_MAX_BYTES,
  fetchPublishedChangelog,
  PUBLISHED_CHANGELOG_URL,
} from "./changelog-feed-client.js";
export { selectAvailableUpdates } from "./update-check.js";
export {
  createUpdateCheckService,
  UPDATE_CHECK_FAILURE_TTL_MS,
  UPDATE_CHECK_SUCCESS_TTL_MS,
  type UpdateCheckService,
  type UpdateCheckServiceDeps,
  type UpdateStatus,
} from "./update-check-service.js";
