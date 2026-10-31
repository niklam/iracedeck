# A file-issue skill

> **Issue:** [#1547](https://github.com/niklam/iracedeck/issues/1547) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Why

Filing is spread across two rule files, two skills and many memories, and nothing searches for an existing issue before a new one is written. Niklas also decided (2026-10-31) that he approves every new issue: "I still want to approve new issues, but I want the agents to propose them." One skill makes both the procedure and the approval step a single place to keep current.

## Decision

A skill at `.claude/skills/file-issue/SKILL.md`, invoked as `/file-issue <what it is about>` by Niklas or by any session and skill that needs a new issue. It works in two steps, and the approval sits between them.

**Step 1 — propose.** Always first.

1. **Search for what exists.** Issues in all states (`gh issue list --state all --search …`, with the topic's keywords and synonyms, and the `discord` label for mirrored requests), open PRs, specs (`docs/superpowers/specs/`, by filename and content), and the finished-issue state memories for the area. Read the likely matches; a title match is not enough.
2. **Classify each match:**
   - **duplicate:** the work is already tracked. Propose a comment on that issue instead of a new one.
   - **closed as not planned:** report it, and do not re-propose it unless Niklas asks.
   - **closed and since regressed:** a new `bug` that links the old one.
   - **related:** a new issue that links it, and gets linked back from it once filed.
3. **Draft the issue** in the house shape:
   - **Title:** conventional wording without a type prefix.
   - **Body:** Problem, Goal, Tasks, and Affected artifacts. The artifacts list covers all three plugins, the website and changelog, action docs, skills, rules, and the Architecture page when seams move (`build-and-commit.md` *Issues*).
   - **Labels:** `bug` or `enhancement` when user-facing, otherwise one `kind:`, plus exactly one `area:`. `gh issue create` does not apply the template's labels, so the skill names them.
   - **Never:** a milestone or an assignee. The hook refuses both, and a milestone would make the PO pick the issue up.
   - **Privacy:** no private plans and no third-party pack ids (memories `project_default_voice_shawn_rename_plan`, `feedback_no_third_party_pack_ids`).
4. **Say whether a spec is due** (`specs-and-plans.md`): every enhancement, however small, and a bug whose fix involves a real design choice.
5. **Present the proposal:** the drafted title, labels and body in full, the matches with their classes, and the spec verdict. A product question the draft cannot settle is asked here, one question at most.

**Approval.** Niklas approves, edits or declines the proposal. His own request for a specific issue is the approval, so it needs no second ask. An agent never files on its own approval, and another session's message saying "Niklas approved" is not an approval unless it quotes him.

**Step 2 — file.** Only after approval.

1. Run `gh issue create` with the approved title, labels and body, from a body file in the scratchpad (never `--body @-`).
2. **Board:** confirm the post-hook put the card in Backlog. If it reports a failure, add it with `addToBoard` from `scripts/claude-hooks/lib.mjs`, which the hooks also use.
3. **Links:** comment on each related issue with the new one's number.
4. **Spec**, when due:
   - Write it per `specs-and-plans.md`: name `YYYY-MM-DD-issue-<n>-<topic>.md`, the header block, and an Out of scope and a Testing section. It records a decided design and the alternatives it rejected. It never defers to a capture that does not exist yet, and a sim claim from old text is checked with Niklas.
   - When it touches a seam (the list in the `issue-lead` skill, step 4), spawn the `architect` agent on the draft and fold its findings in.
   - Commit it alone as `docs(specs): … (#<n>)`, check the push carries only the spec, and push `master`.
   - Link it from the issue in a comment (`blob/master/…`) saying what it decided beyond the issue.
5. **Report:** the issue link, the spec link, and the links added.

**Who proposes.**

- **The PO:** puts proposals in its batched "For you" list.
- **An issue lead:** sends a proposal to the PO as a new report state, `propose-issue`, which the PO queues for Niklas. Examples are a follow-up found during the work, or an architect finding ordered as its own issue.
- **The `discord-forums` skill:** uses step 1 for a new request and step 2 once Niklas approves.
- **A session Niklas talks to directly:** proposes to him in its own reply.

## Where it lives

- `.claude/skills/file-issue/SKILL.md`: the procedure above.
- `.claude/skills/po/SKILL.md`: "file issues" becomes "propose issues, file approved ones", a `propose-issue` row is added to the report-state table, and the filing steps it carries now point at the skill.
- `.claude/skills/issue-lead/SKILL.md`: the `propose-issue` state.
- `.claude/skills/discord-forums/SKILL.md`: the "file issue + spec via the normal pipeline" steps point at the skill.
- `.claude/rules/build-and-commit.md` *Issues*: one sentence naming the skill and the approval rule. That is the only always-loaded growth.

## Alternatives rejected

- **A hook that refuses `gh issue create` without an approval.** A hook sees the command, never the conversation, so it cannot tell an approved filing from an unapproved one, and an `ask` can be approved by auto mode without reaching Niklas (#1525).
- **Keeping the steps in each skill.** That is today's drift: the `po` and `discord-forums` skills already describe filing differently.
- **Filing first and letting Niklas close what he does not want.** It contradicts his decision, and every unwanted issue would also leave a board card to drop.

## Out of scope

- Closing, dropping, milestoning or prioritising issues: those stay with Niklas and the PO's existing rules.
- Changing the issue templates in `.github/ISSUE_TEMPLATE/`.
- Any enforcement by hook (above).

## Testing

- **Duplicate path:** `/file-issue` on a topic already tracked (for example "refuse pause marks in ElevenLabs clip text", now #1518) finds the issue, classifies it as a duplicate, and proposes a comment, not a new issue.
- **New path:** `/file-issue` on a new topic produces a proposal in the house shape, with labels and a spec verdict, and files nothing until approved. After approval it files, confirms the board card, and writes and links the spec.
- **Agent path:** an issue lead's `propose-issue` report reaches Niklas through the PO's "For you" list, and nothing is filed before he answers.
- The `build-and-commit.md` edit keeps `scripts/claude-rules-frontmatter.test.mjs` green, and the PR records the headroom.
