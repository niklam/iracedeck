/**
 * When the "what's new" changelog opens after an update: the
 * `changelogNotification` policy vocabulary and its default (issues #742,
 * #1061).
 */

/**
 * The `changelogNotification` global-setting values (issue #742). Defined in
 * the `app-constants` leaf (not in `global-settings.ts`) so the Zod schema,
 * app-updates' `version-check.ts` decision logic and the settings window share
 * one source of truth without a dependency cycle (spec #1351).
 */
export const CHANGELOG_NOTIFICATION_POLICIES = ["always", "features", "monthly", "never"] as const;

/** User preference for when the changelog opens after an update. */
export type ChangelogNotificationPolicy = (typeof CHANGELOG_NOTIFICATION_POLICIES)[number];

/**
 * Default `changelogNotification` policy: `never` — nothing opens itself unless
 * the user asks for it (issue #1061). Shared by the `GlobalSettingsSchema` field
 * and `runVersionCheck` so the two can never disagree.
 *
 * This REVERSES #901, which set `features` on Ulanzi's RCA recommendation, and
 * the reversal is deliberate rather than a drift. Two things to know before
 * moving it back:
 *
 * What #901 inherited was a DIRECTION, not a value — the RCA's heading said
 * `features` while the code beneath it said `monthly`, so "not `always`" is all
 * it actually recommended, and `features` was a judgement made on top of that.
 * And the judgement rested on the default being the only lever there was:
 * nobody was ever asked, so the question was purely which setting annoys the
 * fewest people who never chose. The Getting Started page (#1061) asks directly
 * at first run and offers one-press opt-in, so the default's job stops being
 * "guess what most people want" and becomes "do nothing surprising until
 * asked" — the same principle that keeps the Race Engineer off by default.
 *
 * `never` is quiet, not lossy or hiding: it still persists `_lastSeenVersion`
 * via `track-silently`, so switching to another policy later never replays an
 * old release; the notes are compiled into the build and always on the What's
 * New tab; and the #1016 update banner rides the separate `updateCheck`
 * setting. Changing this reaches NEW INSTALLS ONLY — every write persists the
 * whole parsed cache, so existing users keep whatever they already have, and
 * there is deliberately no migration (a persisted value cannot be told apart
 * from a deliberate choice).
 */
export const DEFAULT_CHANGELOG_NOTIFICATION_POLICY: ChangelogNotificationPolicy = "never";
