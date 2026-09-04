---
name: release-notes
description: Use when preparing public release notes or a release announcement for a new iRaceDeck version. Produces four tailored versions — Discord, Reddit, Elgato Marketplace, and Mirabox Space — from the changelog, the commits/PRs/issues since the previous release, and the actual user-facing value of each change.
---

# Release Notes

Public-facing release announcements for a new iRaceDeck version. The same release ships four different texts:

| Target | Format | Emoji | Length | Ends with |
|--------|--------|-------|--------|-----------|
| **Discord** | Markdown `#`/`##` headers, **bold**, bullets | Discord shortcodes (`:checkered_flag:`) | No hard limit (keep tight) | Download link + `@everyone` |
| **Reddit** | Markdown `#`/`##` headers, **bold**, *italic*, bullets, `[text](url)` links | **Unicode emoji** (🏁 🎥 🎙️) — Reddit does **not** render `:shortcode:` | No hard limit | Download link |
| **Elgato Marketplace** | **bold** labels, *italic*, bullets only — **no headers, no code backticks, no emoji** | none | **≤ 1500 characters** | nothing extra |
| **Mirabox Space** | **plain text only** — no markdown, no headers, no `*`/`**`, no backticks, no links | none | keep tight | nothing extra |

Two format rules carry the most weight:

- **Discord uses `:shortcode:` emoji; Reddit needs actual Unicode emoji characters.** A Reddit post pasted with `:checkered_flag:` shows literal text, not 🏁. Always convert.
- **Mirabox Space renders no markdown.** Any `*`, `**`, `` ` ``, `#`, or `[](…)` shows as literal characters. The Mirabox version is plain prose with hyphen bullets only.

## Process

### 1. Establish the range and the source of truth

- The version is the top `##` heading in `packages/website/src/content/docs/changelog.mdx` (the in-development section, dated `_Unreleased_`). It equals the root `package.json` `version` with any `-dev`/`-rc` suffix stripped.
- The previous release is the latest stable `vX.Y.Z` tag. List what changed:
  ```bash
  git tag --sort=-version:refname | head
  git log --oneline v<prev>..master
  ```
- **The changelog's in-development section is the curated list of user-facing changes** — it already collapses a feature and its follow-up fixes into one line (see `@.claude/rules/changelog.md`). Use it as the spine. Cross-check it against the commit list so nothing user-facing is missing and nothing internal sneaks in.

### 2. Separate user-facing from internal

Release notes describe **what a user can see or do differently**. Drop everything else. Typical non-user-facing commits to exclude:

- `docs(...)` internal docs/architecture, `chore(release: ...)` / `fix(release: ...)` release tooling, `ci(...)`, `chore(deps: ...)` dependency bumps, internal refactors with no visible effect.

Keep: `feat`, `improve`, user-facing `fix`, and user-visible `chore` (e.g. a terminology rename users will notice). Maintenance lines are optional and only if notable.

### 3. Understand what each change really does — read the PRs **and** the issues

Do not paraphrase commit subjects. For each user-facing change, read the PR body and its linked issue to learn (a) what the user gets, (b) **why it matters / what problem it solved**, and (c) concrete specifics worth quoting (exact variable names, driver names, behaviors, examples).

```bash
gh pr view <pr>   --json title,body,closingIssuesReferences,labels
gh issue view <n> --json title,body,labels
```

**Repo numbering gotcha:** the squash-merge commit title carries the **issue** number, not the PR number (e.g. `fix(...): … (#733)` → issue #733, whose PR is #734). To find the PR from an issue, use the issue's timeline/linked PRs or `gh pr list --search "<issue> in:title"`. Confirm you're reading the right PR before quoting it.

For a large release, delegate this PR/issue research to a subagent that returns a structured per-item report (user value + specifics), so the main context stays focused.

### 4. Shape the narrative

- Find the release's **theme** and lead with the headline feature. Group related changes (a new capability + the fixes that hardened it belong together, even across separate PRs).
- Open with a short, racing-flavored lead-in paragraph (Discord/Reddit).
- One user-facing change per bullet, written as a benefit, not a commit subject. **Bold** the feature/action name.
- Quote concrete specifics that make it real: exact template tokens (`{{focused.car_number}}`), the actual new names (Dean, Dylan, Ron, Jakub, Tom), the precise behavior.
- Don't claim "pre-release" for a stable version. Only call it a pre-release if the version carries `-rc`/`-beta`/`-alpha`.

### 5. Write all four versions

Start from the Discord version, then derive Reddit (swap emoji to Unicode, drop `@everyone`), then compress to Marketplace, and adapt that into the plain-text Mirabox Space version.

## Footer — Discord & Reddit only

Both announcement posts end by pointing readers at the download page (and nothing else — no cross-promotion to the stores):

```markdown
**Download:** https://iracedeck.com/downloads/
```

Add `@everyone` as the final line **only** on Discord. The two storefront versions (Elgato Marketplace, Mirabox Space) are product descriptions posted *on* the store, so they carry no footer link.

The download page is the canonical link: `https://iracedeck.com/downloads/`.

## Section emoji (suggested)

| Theme | Discord shortcode | Reddit Unicode |
|-------|-------------------|----------------|
| Title / standings | `:checkered_flag:` | 🏁 |
| Camera / video / focused | `:movie_camera:` | 🎥 |
| Telemetry / positions | `:bar_chart:` | 📊 |
| Race Engineer / voice | `:microphone2:` | 🎙️ |
| Actions / quality-of-life | `:joystick:` | 🕹️ |
| Fixes | `:bug:` | 🐛 |
| Race start | `:vertical_traffic_light:` | 🚦 |
| Spotter / awareness | `:eyes:` | 👀 |

Vary the title vs section emoji so the same glyph isn't repeated.

## Marketplace version — the 1500-character discipline

- Hard cap **1500 characters**. Verify before handing it over: `printf '%s' "$TEXT" | wc -c`.
- No `#` headers, no `` ` `` code backticks, no emoji — Marketplace renders a limited subset. Use **bold** labels (`**New**`, `**Improved**`, `**Fixed**`), *italic* for emphasis/variable names, and `-` bullets.
- Lead with the version name in bold, then the bold-labeled groups. Keep it scannable; drop the lead-in prose and the footer links.

## Mirabox Space version — plain text only

The Mirabox (Stream Dock) store description renders **no markdown**, so anything but plain prose leaks formatting characters into the listing.

- No `#` headers, no `*`/`**` (they print as literal asterisks), no `` ` `` backticks, no `[text](url)` links, no emoji.
- Structure with plain words only: a title line, group labels (`New`, `Improved`, `Fixed`) each on their own line, and `-` hyphen bullets (a hyphen is just punctuation — fine in plain text).
- Write variable tokens and quoted names as plain text — e.g. `focused`, "Your Name" — not in backticks or italics.
- Same content as the Marketplace version, stripped of all formatting. No footer link.

## Store descriptions — drift check (every release)

The permanent product descriptions on the Elgato Marketplace and Mirabox Space listings live only in the store dashboards, so nothing forces them to track the product. **As part of every release's notes preparation, check them for drift** against `docs/reference/store-descriptions.md` — the canonical copies plus a table of the embedded facts that go stale (action counts, dial-capable count, headline features, supported devices, requirements versions). If the release changed any of those facts, propose refreshed description texts alongside the release notes and update the canonical file (and its "Last synced" line) when they're published.

## Reference example

The v1.21.0 Discord post is the canonical style reference. Match its tone (concise, benefit-led, racing-flavored) and its `## :emoji: Section` structure. (Its old closing cross-promoted the stores "in a couple of days" — that line is dropped; announcements now end with just the **Download** link, plus `@everyone` on Discord.)

## Don'ts

- Don't invent or overstate — every claim must trace to a PR/issue.
- Don't list internal churn (CI, deps, release tooling, internal docs).
- Don't repeat a change across "Features" and "Fixes" — collapse a feature and its follow-up fixes into one bullet.
- Don't paste Discord `:shortcode:` emoji into the Reddit version.
- Don't exceed 1500 characters on Marketplace.
- Don't put any markdown (`*`, `**`, `` ` ``, `#`, links) or emoji in the Mirabox Space version — plain text only.

## After posting

Run the `discord-feature-requests` skill's **follow-up** (`pnpm discord:feature-requests follow-up`). A release moves every Discord-sourced issue it closed from `Completed` to `Released`, and the requesters are told in their own threads with the version and where to find the feature.
