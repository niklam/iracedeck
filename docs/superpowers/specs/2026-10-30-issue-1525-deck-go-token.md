# Deck-linked builds need Niklas's own go

> **Issue:** [#1525](https://github.com/niklam/iracedeck/issues/1525) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The problem in one line

The #1520 guard returns `ask` before a build, install or restart in a deck-linked tree, and in auto mode an `ask` can be approved by the auto-mode classifier from its reading of the conversation, so the go Niklas is supposed to give is not guaranteed to be his (observed 2026-10-30 on `pnpm install && pnpm build` in `master`).

## What counts as a hard stop

Anything an agent can produce on its own does not count: a file it writes, an environment variable it sets, a phrase it types into the command, a message from another session claiming Niklas said go. The go has to come out of a channel only Niklas can answer, and the evidence of it has to be written by a hook, not by the agent.

## Decision: the go is an `AskUserQuestion` answer, recorded by a hook

1. **The question.** When a session needs a deck-linked build or restart, it asks Niklas with `AskUserQuestion`: one question whose header is exactly `Deck go`, naming the command and the tree, with the options `Go` and `Not now`. `AskUserQuestion` always reaches the user, and neither the classifier nor the agent answers it.
2. **The token.** A `PostToolUse` hook on `AskUserQuestion` reads the tool's response. When the `Deck go` question was answered `Go`, the hook writes a token outside the repository (under the user's Claude config directory, e.g. `~/.claude/iracedeck/deck-go.json`): the tree, the session id, the time, and an expiry 15 minutes later. Only the hook writes it.
3. **The guard.** The deck-linked-tree rule in `rules-bash.mjs` turns from `ask` to `deny`, unless a token exists that is unexpired, names the tree the command runs in, and belongs to the calling session. The deny says to ask the `Deck go` question first.
4. **Agents cannot forge the token.** `permissions.deny` rules in `.claude/settings.json` refuse `Edit` and `Write` on the token path, and the Bash guard denies any command that names it (`>`, `tee`, `cp`, `rm`, a node one-liner). A deny rule is not something auto mode can approve.
5. **One go, one window.** The token is not consumed by the first command. A go covers the window, because a build is several commands (`pnpm install`, `pnpm build`, a restart). It expires on its own, and a `Not now` answer deletes any token for that tree.

The PO and issue-lead skills replace "wait for Niklas's go in conversation" with "ask the `Deck go` question". The PO batches it with its other questions where it can.

## Alternatives rejected

- **Keep the `ask`, trust the classifier.** That is today's behaviour, and the reason for this issue.
- **Niklas runs the command himself.** It is a hard stop, but it routes builds to him, which the standing rule says never to do (workers build, not Niklas).
- **An environment variable or a file Niklas creates by hand.** An agent can set or create either just as easily, so neither proves anything.
- **A deny with no way through.** That would block the integration build and the PO's post-merge build entirely.

## Research the builder does first

- Confirm that a `PostToolUse` hook on `AskUserQuestion` receives the chosen answer in `tool_response`, and in what shape. If it does not, the fallback channel is a hook on `UserPromptSubmit` that records a go when Niklas types an exact phrase (e.g. `deck go <tree>`) in his own message. That is weaker, since it is any message he sends, but it is still not agent-producible, because only the user submits prompts.
- Confirm that a `PreToolUse` hook knows the calling session id, so a token can be scoped to the session that asked.
- Confirm that `AskUserQuestion` is not auto-answered in any permission mode this project uses.

## Out of scope

- Changing which commands count as deck-touching: the #1520 rule and its expansion stay as they are.
- Stopping a human from building in a linked tree from their own terminal: hooks govern Claude's tool calls only.
- Any change to how deck hosts are linked.

## Testing

- **Guard:** a deck-linked build with no token is denied; with a fresh token for that tree and session it passes; with an expired token, a token for another tree, or a token from another session it is denied. Each comes with a positive control.
- **Token writer:** an `AskUserQuestion` response answering `Deck go` with `Go` writes the token; `Not now`, another header, or a malformed response writes nothing; `Not now` deletes an existing token.
- **Forgery:** `Write` or `Edit` on the token path is refused by the permission rules, and Bash commands that write, copy or delete it are denied.
- **In session, auto mode:** a deck-linked `pnpm build` is denied, the `Deck go` question reaches Niklas, `Go` lets the same build through, and the same build 16 minutes later is denied again.
