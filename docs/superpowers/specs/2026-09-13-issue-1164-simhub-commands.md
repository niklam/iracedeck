# SimHub commands

> **Issue:** [#1164](https://github.com/niklam/iracedeck/issues/1164) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

What SimHub triggers is a **named command**: a function registered in deck-core under a stable id, with explicit parameters, exposed only when a feature opts in. For example, `replay-markers.add { secondsBack: 5 }`.

That is the only thing this spec settles. #1164 is an idea to be split before anything is built. The transport, discovery, auth, the one-receiver rule, feedback, where parameters are set, and the SimHub plugin itself are open questions listed on the issue. Each split issue decides its own and writes its own spec where one is required. Those specs build on this decision rather than reopening it.

## What a command is

- **Named and registered.** A feature registers a command id and a handler in a deck-core registry. Nothing is exposed by default. No command exists just because an action does.
- **Parameters are explicit.** A command declares its parameters and their defaults, and validates what it receives. It reads no deck key's settings.
- **It needs no key.** A handler runs with no action context: no icon, no key flash, no `onWillAppear` having run. A command that wants to confirm itself has to do it some way that works without a deck. How is an open question.
- **It is a published contract.** The SimHub plugin and iRaceDeck are installed and updated separately, so a command id and its parameters are a contract between two programs. Renaming or removing one breaks a user's wheel mapping. It gets the same care as an action UUID or a stored setting.

Where a command and an action do the same thing, they share the underlying service. Neither should call the other. #1162's replay store in deck-core is the model: the Replay Markers action and a `replay-markers.add` command would both be thin callers of it.

## Why not press a deck key

The command would name a specific key on a specific deck. That fails three ways:

- **The key may not exist in the plugin.** Keys on another page or profile get no `willAppear`, so the plugin holds no context for them.
- **Key identity belongs to the deck app.** A context id differs between Elgato, Mirabox and Ulanzi, and nothing makes it stable enough to store in another program.
- **The mapping breaks silently.** Moving a key on the deck would change what a wheel button does, and nothing would tell the user.

## Why not a virtual key

Here the command would run any registered action and mode headlessly, through a synthetic context whose image calls do nothing. It is the tempting option, because almost every action would work with no changes: the handler interface is all an action sees. It loses anyway:

- **Actions assume a visible key.** Several set up state and telemetry subscriptions in `onWillAppear`, and confirm a press by flashing the key. Driven headlessly, some would half-work and some would confirm to nobody. Which ones would only show up action by action, in the sim.
- **Per-key settings need a home.** An action's behaviour lives in its per-key settings (Replay Markers' **Seconds back**, #1162). A virtual key would have to invent a second place to store them, with no schema of its own.
- **Every action becomes a contract by accident.** Any action's modes and settings keys would become something another program depends on. Changing an action's settings today is internal to one plugin; it would stop being so for all of them at once.

Named commands cost an opt-in per command. That cost is the point: each exposed command is a decision someone made, with a contract someone wrote down.
