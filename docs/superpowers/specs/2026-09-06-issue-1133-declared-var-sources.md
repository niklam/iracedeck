> **Issue:** [#1133](https://github.com/niklam/iracedeck/issues/1133) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# A var declares the clips it draws from

## Prose is the only link, and two tools stand on it

A vocabulary var's resolver returns a clip path or a `poolRef(group, base)` at fire time; nothing static says which group that is. #1066 needed the answer twice — the recording script's "which callouts draw from this line, via which var" and `lint:pack`'s "is this shipped clip an orphan" — and got it by regex over the var's `description` (`descriptionNamesGroup`: the text names `<group>/` or `<group> [clip] group`). Every description in the catalog was written to fit the regex, which is the tell: the descriptions are doing a job data should do. The consequences are known and accepted for the MVP: `lint:pack`'s exemption is per group, so a misspelled clip in a group any var names is never reported; a description that merely mentions another group disables orphan checking for that group in every pack; nothing can test that a description matches its resolver.

## The declaration

`defineVar` gains a fourth argument, `draws`, describing the clips the resolver can return:

```ts
engine.defineVar("incident.points", (ctx) => poolRef("incidents", `points-${n}`), "…", {
  draws: { group: "incidents", bases: ["points-1", "points-2", "points-3", "points-4"] },
});
engine.defineVar("cornerName.clip", (ctx) => poolRef("corner-names", slug), "…", {
  draws: { group: "corner-names" }, // every base of the group: one per corner, open-ended
});
```

`bases` is optional; absent means "any base of the group" — for the open-ended vars (corner names, driver names, value-indexed numbers) where the set is whatever the voice ships. A var that returns a fixed clip declares nothing. `vocabulary()` reports `draws` per var, so the reference generator and the linter read it from the same place they read the description.

Two tests make the declaration honest. A static one: every declared `group` (and every declared base) exists in the bundled manifest. A dynamic one, in the family test that already exercises each resolver: every `poolRef` a resolver returns during the test lands inside its declaration. A resolver whose output escapes its declaration is a code bug and fails loudly, which is the property the regex never had.

## What the two consumers become

- The recording script's `viaVar` is exact: a line is attributed to the vars whose declaration covers it, not to every var whose prose mentions the group.
- `lint:pack`'s var-driven exemption is per declared base where bases are declared and per group where they are not — which is what the bundled coverage test's hand-coded `VAR_DRIVEN_BASES` regexes encode today, so that list goes and the two readings finally agree (the unification issue, #1135, depends on this one).
- `descriptionNamesGroup` is deleted. A description goes back to being prose for a pack author.

## Per-contract scoping is the same declaration, seen from the other side

The #1065 review asked for the vocabulary to be scoped per contract — which vars a given callout may name — so the reference can say "these are the words available to `pit-crew.lap-time-best`" and the compiler can refuse a script that reaches for a var another family owns. That is a declaration on the contract (`vars: [...]`), not on the var, and it changes what the compiler accepts. It is left out of this issue on purpose: the two are separable, this one has no compile-time effect, and doing them together would put a format-facing change inside a tooling fix. When it comes, it reuses `draws` to show, per callout, which clips a pack needs for that callout alone.
