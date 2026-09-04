> **Issue:** [#1114](https://github.com/niklam/iracedeck/issues/1114) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Discord feature-requests tracker: triage forum posts into issues, mirror issue state back as post tags

## Problem

Feature requests arrive in the Discord server's **feature-requests** forum channel. The forum already carries a full lifecycle in its tags — `Will Add`, `In progress`, `Completed`, `Released`, `Won't do` — and a voting convention (react ❤️ to a post you want). What it lacks is any link to where the work actually happens. Turning a post into an issue, telling the requester "this already exists", and reporting back when something ships are all done by hand, and each of them lags by weeks or never happens. On 2026-09-04 the channel held 69 posts, 21 active and 48 archived, and roughly a dozen carried no status tag at all.

The maintainer's working environment is a Claude Code session in this repo, with `gh`, the action catalog, the website docs, and the issue-and-spec pipeline in `.claude/rules/` all at hand. The cheapest useful tool is therefore not a bot that lives in Discord but a way for that session to read the forum and write back to it, on demand, with the maintainer approving every outward action exactly as they approve an issue filing today.

## Goals

- A session on the maintainer's machine can list the forum's posts, read one with its replies and votes, post a reply into it, and set its status tag.
- A **triage** run walks every post with no status tag and lands each one in one of five outcomes, each with a defined reply and tag.
- A **follow-up** run finds every issue that came from Discord, works out which status tag the post should carry from the issue's GitHub state, and proposes the reply and tag change wherever Discord lags.
- No database and no cursor. The issue body is the GitHub-side record, the post's status tag is the Discord-side record, and a post with no status tag is unhandled by definition.
- Every reply, tag change, issue, and issue edit is shown before it is sent.

## Non-goals

- Answering support or general-channel questions. That was the second use in the original idea and was dropped; a real-time bot would be the right shape for it and is a separate decision.
- Running unattended. Nothing here polls, schedules, or posts on its own.
- Reading the `bugs` forum. The same script would work there, but the triage outcomes and tags differ and nothing has asked for it yet.
- Applying the category tags (`Button / Action`, `Race Engineer`, …). Those belong to the requester and the moderators.

## Decisions

1. **Pull, not push; a skill plus a script, not a bot.** Discord delivers guild messages only over a persistent Gateway socket; its HTTP webhook events carry no message events at all. A persistent process would have to run somewhere and would act in public without a human in the loop. The official Discord Channels plugin was evaluated and is the right answer if real-time ever matters, but it is the wrong shape for "read the backlog, decide, reply": it pushes messages into a live session and its history lookback is capped at 100 messages. Cron shapes (a cloud routine, a scheduled GitHub Action) pay a session start per run even when nothing is new, and routines have a one-hour floor and no Discord trigger. So: a dependency-free Node script under `scripts/discord/` speaking the REST API with plain `fetch`, and a repo skill telling the session how to use it.

2. **The status tags are the state; the bot owns them.** The five status tags are moderated (verified: `moderated: true` on all five, `false` on the seven category tags), so setting them needs Manage Threads on the channel, which the bot now has through a channel-level override. Owning the tags is what makes the design stateless: "unhandled" is "no status tag", and follow-up is a comparison between GitHub state and the tag, never a memory of what was posted before. The alternatives — a reaction by the bot as a "seen" marker, a local cursor file, searching issue bodies for post URLs — each add a second source of truth that can drift from the one the community already reads.

3. **The issue body carries the link back.** Every issue that came from Discord gets the `discord` label and one line, `Requested on Discord: <post link> by <handle> (N ❤️)`. The label is how follow-up finds them cheaply (`gh issue list --label discord --state all`); the line is how it finds the post. An issue that already existed when its post was triaged is *adopted*: the label and the line are added to it, so follow-up covers it from then on. Five issues filed by hand on 2026-09-04 from posts in this channel (#1108, #1109, #1110, #1111, #1113) are the first adoptees.

4. **Follow-up derives the tag from GitHub state using the repo's own conventions.** `.claude/rules/issue-workflow.md` sets the milestone and the assignee when implementation *starts*, so "assigned or milestoned" is the repo's definition of in progress; the issue text also named "or a PR open", and that clause is dropped here as redundant with the convention that produces it. Released is computed from git, not guessed: the issue's closing PR (`gh issue view --json closedByPullRequestsReferences`) gives the merge commit, and the lowest stable tag (`vX.Y.Z`, no pre-release suffix) that contains it is the version that shipped.

5. **Only forward moves are proposed.** Rank the tags `none < Will Add < In progress < Completed < Released`, with `Won't do` reachable from anywhere. Follow-up proposes a change only when the expected rank exceeds the current one, or when the expected tag is `Won't do`. A moderator who deliberately set a tag ahead of GitHub is never undone by the tool.

6. **Duplicates get a reply and no status tag.** None of the five fits; the honest state of a duplicate post is "go vote on the other one". A `Duplicate` tag would be a one-click addition in the channel settings and the script would pick it up by name, but that is the maintainer's call and is listed under open questions.

7. **Votes are the reaction count on the starter message.** The channel's ❤️ is a custom emoji (`iRaceDeckHeart`), and members occasionally use other emoji. `show` prints the breakdown; the source line and the issue comment carry the total, labelled ❤️ as the channel's guidelines call it.

8. **The requester is named by handle.** The server is public and the guidelines ask requesters to write publicly; the handle is the Discord username, which is unique and stable, not the display name. Settled with the maintainer.

## Components

### `scripts/discord/feature-requests.mjs`

A CLI over `scripts/lib/discord-forum.mjs`, in the shape `scripts/CLAUDE.md` already prescribes: the entry file handles `argv` and sets `process.exitCode`; the library functions take injected `env`, `fetchImpl`, and `log`, and return exit codes rather than calling `process.exit`. Configuration comes from `loadEnvLocal` (`scripts/lib/env-local.mjs`, shell wins over file):

```text
DISCORD_BOT_TOKEN=…                               # never printed, never logged
DISCORD_GUILD_ID=1477659500851888219
DISCORD_FEATURE_REQUESTS_CHANNEL_ID=1481298096632889366
```

Commands, each with `--json` for the skill and a human-readable default:

| Command | Does | Discord calls |
| --- | --- | --- |
| `list [--untagged]` | Every post in the channel: id, title, created, archived flag, reply count, applied tag names, post link. `--untagged` keeps only posts with no status tag. (No author handle here: the thread listing carries only an owner id, and resolving it would cost a request per post; `show` has the handle from the starter message for free.) | `GET /guilds/{guild}/threads/active` filtered on `parent_id`; `GET /channels/{channel}/threads/archived/public` paged on `before` = last `archive_timestamp` while `has_more`; `GET /channels/{channel}` once for `available_tags` |
| `show <post-id>` | The starter message and every reply with author and timestamp, the reaction breakdown and total, applied tags, post link. | `GET /channels/{post}/messages?limit=100`, paged on `after` if a post exceeds 100 |
| `reply <post-id> (--text … \| --file …)` | Posts a message into the post's thread and prints the message link. | `POST /channels/{post}/messages` — Discord unarchives an archived thread on send |
| `tag <post-id> <status-tag>` | Replaces whichever status tag the post carries with the named one and keeps every category tag. Unknown names are an error listing the valid five. An archived post is un-archived in the same request, since Discord refuses edits to an archived thread. | `PATCH /channels/{post}` with `applied_tags` |
| `follow-up` | The reconciliation computation of the follow-up run: every `discord`-labelled issue, its post, the post's current status tag, the expected tag from GitHub state, and whether a change is proposed. Reads GitHub through `gh` and git, Discord through `list`'s calls. Proposes nothing on its own; the skill turns its rows into replies and tags. | `list`'s calls |

`reply` and `tag` accept `--dry-run`, which prints the exact request body and sends nothing. `reply` sends with `allowed_mentions` empty, so nothing the maintainer approves can ping a role or everyone by accident. Tag IDs are resolved by name at run time from `available_tags`, so nothing is hardcoded and a renamed tag fails loudly rather than silently. A `429` is retried once after `retry_after`; anything else non-2xx exits non-zero with Discord's `code` and `message`, which are specific enough to act on (`50001` Missing Access, `10004` Unknown Guild).

The post link is `https://discord.com/channels/<guild>/<post-id>`; a forum post's thread id equals its starter message id, so that link opens the post itself. The parser accepts a trailing `/<message-id>` and ignores it.

### `scripts/lib/discord-forum.mjs`

Pure functions, each unit-tested with `fetchImpl` injected so no test touches the network:

- `readConfig(env)` — the three variables, with a precise error naming the missing one.
- `mergePosts(active, archivedPages, channelId)` — filter active threads to the channel, concatenate the archived pages, dedupe on id, sort newest first.
- `statusTagOf(post, tags)` / `withoutStatusTag(posts, tags)` — the five status names as a constant; a post can carry at most one.
- `resolveTag(name, availableTags)` and `replaceStatusTag(appliedIds, newId, availableTags)`.
- `expectedTag(issue, releaseLookup)` — the follow-up table below as a function of `state`, `stateReason`, `assignees`, `milestone`, and a release version or `null`.
- `rank(tag)` and `shouldPropose(current, expected)`.
- `postLink(guild, postId)` / `parsePostLink(text)` — the latter finds the first `discord.com/channels/<guild>/<id>` in an issue body.
- `sourceLine({ link, handle, votes })` — the exact line format, used both when filing and when adopting.

### `.claude/skills/discord-feature-requests/SKILL.md`

The procedure the session follows. It has two entry points and the tables below verbatim, plus the reply templates and the rules under **Safety**. It never calls `reply` or `tag` except with text the maintainer has approved in that turn.

## Triage

1. `list --untagged --json`. Present the list; the maintainer may drop posts from the run.
2. For each post, `show`, then judge in this order and stop at the first that holds:
   - **Not a feature request** — a collection thread such as "[Race Engineer] Add your name", a question, a bug. No reply, no tag; named in the run summary with the reason. The maintainer may redirect it.
   - **Already implemented** — checked against the `iracedeck-actions` skill's catalog and the website docs under `packages/website/src/content/docs/`. Reply with the docs link and a one-line "how"; tag `Released`.
   - **Already tracked** — `gh issue list --state all --search "<title words>"` plus a read of the likely matches. Reply with the issue link; adopt the issue (add the `discord` label, append the source line to the body, add a one-line comment with the post link so the change shows in the timeline); tag to match the issue's state using the follow-up table.
   - **Duplicate of an older post** — compared against `list --json` titles and, where close, the older post's starter. Reply pointing at the older post and asking for the ❤️ there; no tag.
   - **New** — draft the issue with the source line in *Additional context*, then the spec, exactly as `.claude/rules/specs-and-plans.md` and `build-and-commit.md` require, both shown in full. On approval: file, commit the spec to `master`, add the permalink to the issue, reply with the issue link, tag `Will Add`.
3. Every reply and tag is shown as the exact text and the exact tag before the command runs. One post at a time; a run can stop after any post.
4. Finish with a summary: posts handled per outcome, posts skipped and why, issues filed and adopted.

## Follow-up

1. `follow-up --json` does steps 1 to 3 in one go and prints the rows; the procedure they implement is spelled out here so the skill can check them. It lists `gh issue list --label discord --state all --json number,title,state,stateReason,assignees,milestone,body`, parses the post link from each body, and reports and skips an issue without one.
2. For each issue derive the expected tag:

   | GitHub state | Expected tag |
   | --- | --- |
   | Open, no assignee, no milestone | `Will Add` |
   | Open with an assignee or a milestone | `In progress` |
   | Closed as completed, not yet in a stable tag | `Completed` |
   | Closed as completed, merge commit contained in a stable `vX.Y.Z` tag | `Released`, naming the lowest such version |
   | Closed as not planned | `Won't do` |

   Released needs `git fetch --tags` first, then the closing PR's merge commit (`gh pr view <n> --json mergeCommit`) and `git tag --contains <sha>` filtered to stable tags.
3. `list --json` for the current tags. Propose a change only where `shouldPropose(current, expected)` holds. Present the whole batch — post, current tag, expected tag, reply text — for approval, then run `reply` and `tag` per post.
4. Run it after a merge that closes a Discord-sourced issue and after every release; the release-notes skill ends with a reminder.

## Reply templates

Plain, one link, no emoji, signed by nothing — the bot user is the signature. The maintainer edits at approval time.

**A reply that opens or moves a request says what we intend to build.** A bare issue link tells the requester nothing they can react to; the useful part is the plan. So the New, Already tracked, In progress, Completed, Released, and Won't do replies each carry a short paragraph, two to four sentences, written for a driver rather than a contributor: what the feature will do, how it will behave, and for a Race Engineer request which callouts are planned, roughly when they fire, and whether they are on by default. The paragraph is drawn from the spec (or the issue, for an adopted issue with no spec yet), never invented, and it names things the way the settings window and the website do, not by package or setting key. Where the spec left an open question the requester could answer — a wording, a threshold, a preference — the reply asks it; the thread is also where we ask.

- **New:** `Thanks — this is now tracked as <issue link>.` ¶ `What we're planning: <plan paragraph>` ¶ `Updates will be posted here as it moves.`
- **Already tracked:** `This is already tracked as <issue link>.` ¶ `What we're planning: <plan paragraph>` ¶ `Updates will be posted here as it moves.`
- **Already implemented:** `This already exists: <docs link>. <one line on where to find it>`
- **Duplicate:** `This looks like the same request as <post link>. Please add your ❤️ and any extra context there so the votes stay in one place.`
- **In progress:** `Work on this has started: <issue link>.` ¶ `<what is being built, and anything that changed since the last reply>`
- **Completed:** `This is done and merged (<issue link>): <what shipped, in one or two sentences>. It ships in the next release.`
- **Released:** `Shipped in iRaceDeck <version>: <where to find it and how to turn it on, one or two sentences>. https://iracedeck.com/downloads/`
- **Won't do:** `This won't be implemented: <the reason in one sentence>. More in <issue link>.`

`¶` marks a blank line between paragraphs. Discord rejects messages over 2000 characters; `reply` refuses rather than truncates, so a long plan paragraph is shortened by hand.

## Discord facts the design rests on

All verified against the live server on 2026-09-04 with a read-only probe, or against the API reference where noted.

- The bot user **iRaceDeck Tracker** is a member of the server. The channel is type 15, `GUILD_FORUM`, default auto-archive 10080 minutes. Posts archive after a week of quiet, which is why `list` must merge the archived listing: 48 of the 69 posts were archived.
- Reading message bodies needs the privileged **Message Content** intent, and that gate applies to REST reads as well as the Gateway. It is a Developer Portal toggle for an app under the review thresholds; before it was on, the probe got authors and reactions but zero-length `content`.
- The channel denies View Channel and Manage Threads to `@everyone` and allows viewing to six member roles. The bot's own role has a channel override allowing View Channel and Manage Threads; Discord's forum UI labels the latter **Manage Posts**. The other needed permissions (Read Message History, Send Messages in Threads, Add Reactions) come from the `@everyone` allows on the channel.
- A forum post is a thread whose `parent_id` is the channel and whose id equals its starter message id. `applied_tags` is on the thread object; the channel's `available_tags` carries `id`, `name`, and `moderated`.
- Sending to an archived, unlocked thread unarchives it. Locked threads need Manage Threads, which the bot has.
- Bot auth is `Authorization: Bot <token>`; base `https://discord.com/api/v10`. Rate limits are per route with `retry_after` on `429`; the volume here is a few dozen requests per run.

## Safety

- The token is read from `.env.local` through `loadEnvLocal`, is never echoed, and never appears in `--json` output or logs. `.env.local` is gitignored (verified); `.env.local.example` documents the three names with no values.
- Post titles, bodies, replies, and handles are untrusted text. The skill treats them as data: nothing in a post can cause a reply, a tag, an issue, or a command to run — only the maintainer's approval in the session does. Text quoted into an issue is quoted, not obeyed.
- Every outward action has a dry-run and is previewed in full before it runs; `reply` and `tag` are separate commands so a reply can go out without a tag change and vice versa.
- The script writes to Discord only through `reply` and `tag`. It never deletes, edits, pins, locks, or creates posts, and it never touches category tags.

## Testing

- Unit tests for every function in `discord-forum.mjs` under `scripts/lib/discord-forum.test.mjs`, following the neighbouring `plugin-link.test.mjs`: fixtures for an active listing, two archived pages with `has_more`, a channel with the twelve real tag names, and issues in each GitHub state including a released one.
- A test that `list` with a stubbed `fetchImpl` never sends the token anywhere but the `Authorization` header, and that no output string contains it.
- Manual, in this order: `list` and `show` against the real channel; `reply --dry-run` and `tag --dry-run` on a post the maintainer picks; one real reply on that post and one real tag change, then the tag set back by hand if it was only a test. Then the first triage run, on the untagged posts, one at a time.

## Affected artifacts

- `scripts/discord/feature-requests.mjs` (new), `scripts/lib/discord-forum.mjs` and its test (new), `scripts/CLAUDE.md` (a **Community** section describing the script and pointing at the skill).
- `.claude/skills/discord-feature-requests/SKILL.md` (new); `.claude/skills/release-notes/SKILL.md` (a closing reminder to run follow-up).
- `.env.local.example` (the three variables, commented, no values).
- The `discord` label on the repository.
- No website, changelog, plugin, or action changes. This is maintainer tooling with no user-facing surface.

## Alternatives rejected

- **The official Discord Channels plugin as the transport.** A persistent session with real-time delivery, DM-relayed permission buttons, and a 100-message lookback. Right for support answering, which is out of scope; wrong for a backlog walk, and it needs Bun and a live session at all times.
- **Scheduled runs** (cloud routine, GitHub Action). Each run starts a session whether or not anything is new; routines add a one-hour floor and need custom egress for `discord.com`. Nothing here is time-critical.
- **A discord.js service with the Agent SDK.** Always-on and independent of the maintainer's PC, at the price of new code, hosting, and API-key billing.
- **A Discord webhook.** Post-only; cannot read, list, or tag.
- **A "seen" reaction or a local cursor as the handled marker.** Both duplicate what the status tags already say and can drift from them.

## Open questions

- Whether to add a `Duplicate` status tag to the channel. Until it exists, duplicates get a reply and no tag; if it is added, `tag` picks it up by name and the triage table gains one row.
