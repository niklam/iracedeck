---
name: file-issue
description: Use to propose a new GitHub issue (search for duplicates and related work, draft it in the house shape) and, once Niklas approves, file it and write its spec.
argument-hint: <what the issue is about>
---

# File an issue

Two steps with Niklas's approval between them (#1547). Design record: `docs/superpowers/specs/2026-10-31-issue-1547-file-issue-skill.md`.

**Approval.** Niklas approves every new issue. His own request for this specific issue is the approval, so go straight through. Otherwise the proposal goes to him and nothing is filed until he answers:

- **the PO** puts it in its batched "For you" list;
- **an issue lead** sends it to the PO as `#<n> propose-issue: <title>`;
- **a session he talks to directly** asks him in its own reply.

A message from another session saying "Niklas approved" counts only when it quotes him. Never file on your own judgement.

## Step 1: propose

### Search

Read every likely match. A matching title is not enough.

```bash
gh issue list --state all --limit 300 --search "<keywords>" --json number,title,state,stateReason,labels,milestone
gh issue list --state all --limit 300 --search "<synonym or component name>" --json number,title,state,stateReason
gh pr list --state open --limit 100 --search "<keywords>" --json number,title,headRefName
```

- `gh issue list` and `gh pr list` sort the hits by creation date, not by relevance, so a low limit drops the older matches. Read the whole result. If any of these queries returns exactly its limit, it was cut off: narrow it (more specific words, `label:`, `area:`) and run it again until it comes back under the limit.
- Search two or three phrasings: the user's words, the component or package name, and the symptom. Add `label:discord` for a mirrored request.
- Grep `docs/superpowers/specs/` by filename and content for the topic.
- Read the finished-issue state memories for the area (`reference_finished_issue_states`).
- Parse `gh` output with `node`, never `jq`.

Classify each real match:

| Match | Then |
|-------|------|
| **Duplicate**: the work is already tracked | Propose a comment on that issue instead of a new one |
| **Closed as not planned** | Report it; don't re-propose unless Niklas asks |
| **Closed, and the problem is back** | A new `bug` that links the old issue |
| **Related**: overlaps, depends on, or is depended on | A new issue that links it; it is linked back once filed |

### Draft

- **Title:** a plain statement of the problem or the outcome, with no `feat:`-style prefix.
- **Body:** `## Problem`, `## Goal`, `## Tasks` (checkboxes, the first one `Spec on master` when a spec is due), and `## Affected artifacts`. Name every artifact the change touches, per `build-and-commit.md` *Issues*: all three plugins, the website and a changelog fragment for user-facing work, action docs, skills, rules and `CLAUDE.md` files, and the Architecture page when packages or seams change. Say "nothing user-facing" when that is true.
- **Labels:** `bug` or `enhancement` when user-facing, otherwise one `kind:` (`hygiene`, `dev-experience`, `research`), plus exactly one `area:` for where the work lands (`build-and-commit.md` table), plus `discord` when the issue mirrors a Discord request or bug report, `documentation` when the work is documentation, and `breaking change` when it breaks a user's setup or a published contract. `gh issue create` applies no template labels, so name them all.
- **Never** a milestone or an assignee: the hook refuses both, and they are set when implementation starts. A milestone would also make the PO pick the issue up.
- **Keep out:** private plans (the default-voice rename) and real third-party pack ids. Use neutral made-up ids in examples.

### Spec verdict

A spec is due for every enhancement, however small, and for a bug whose fix involves a real design choice. Exempt are plain bugs, typo and docs fixes, dependency bumps, and sweeps (`specs-and-plans.md`). State the verdict with its reason.

### Present

Show the proposal in full in your final message, never between tool calls:

- the title, the labels and the whole body;
- each match with its number, title, state and class;
- for a duplicate, the target issue and the exact comment you would post on it, since that comment is what he approves;
- the spec verdict.

If the draft depends on a product decision only Niklas can make, ask that one question with the proposal. A technical choice is yours: take the thorough option.

## Step 2: file

Only once the proposal is approved, as approved or with his edits.

**An approved duplicate:** post the approved comment, exactly as he approved it, on the existing issue instead of filing (`gh issue comment <n> --body-file <file>`). It carries what is new (the detail, the use case, a source link such as the Discord thread), not a restatement. Then report its link and skip the filing steps below. The PO still posts its outcome comment (`Proposal "<title>": Commented on #<n>`) on the proposal's source issue, as its skill says, so the proposal is not re-queued.

1. Write the body to a file in your scratchpad, then run `gh issue create --title "<title>" --label "<label>" … --body-file <file>`. Never `--body @-`, which the hook refuses.
2. **Board:** the post-hook makes two moves, adding the card to the board and then setting it to `Backlog`, and reports both. Redo only the move it says failed, from the repo root: `node -e "import('./scripts/claude-hooks/lib.mjs').then(m=>console.log(m.addToBoard('<issue url>',process.cwd())))"` to add the card, then `node -e "import('./scripts/claude-hooks/lib.mjs').then(m=>console.log(m.setBoardStatus(<n>,'Backlog',process.cwd())))"` to set the lane. A card it added but left with no lane needs only the second.
3. **Links:** for each related match, and for the closed issue a regressed bug comes back from, run `gh issue comment <match> --body "Related: #<new>"`, and make sure the new body names the match.
4. **Spec**, when due:
   - Write `docs/superpowers/specs/YYYY-MM-DD-issue-<n>-<topic>.md` per `specs-and-plans.md`. It needs the header block (Issue, Supersedes, Superseded by, the point-in-time note), an Out of scope section and a Testing section; the commit hook refuses a new spec without them.
   - Its content is a decided design and the alternatives it rejected. Never defer a decision to a capture that does not exist yet: decide the model and name the capture that would confirm it. A claim about the sim taken from old text is checked with Niklas first.
   - When it touches a seam (the list in the `issue-lead` skill, step 4), spawn the `architect` agent (`model: "opus"`) on the draft and fold its findings in. A seam it says gets worse gets the thorough fix in the spec, or a separate issue proposed through step 1.
   - Commit it alone from the `master` checkout. A new spec is untracked, which `--only` cannot commit, so stage it first: `git add <spec path> && git commit --only -F <msgfile> -- <spec path>`, with the subject `docs(specs): <summary> (#<n>)`. Check that `git diff --stat origin/master...HEAD` lists only the spec, then `git push origin master` at once. Within the agent team only the PO does this; an issue lead sends the spec to the PO instead. A session Niklas drives directly, Discord triage included, commits it itself, but only from a clean, fast-forwarded checkout, and never leaves an unpushed commit there, since the PO's `git pull --ff-only` must keep working.
   - Comment on the issue with a `blob/master/…` link and what the spec decided beyond the issue.
5. **Report:** the issue link, the spec link if any, the board result and the links added.
