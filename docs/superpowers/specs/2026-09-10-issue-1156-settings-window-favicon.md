# Settings window favicon

> **Issue:** [#1156](https://github.com/niklam/iracedeck/issues/1156) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

Ship one square brand mark as a committed asset in `packages/pi-components/browser/`, copy it into each plugin's `ui/` through the browser-assets copy list that already carries `iracedeck-logo.png`, and reference it from `settings-window.ejs` alone with a `<link rel="icon">`.

The asset is the same mark iracedeck.com uses — the red "iR" on a white square, `packages/website/public/favicon-96x96.png`, 4 KB — committed under a distinct name (`iracedeck-icon.png`) rather than shared across packages.

Nothing else changes. The loopback settings server already serves any file under `ui/` and its `CONTENT_TYPES` map already maps `.png`; the favicon is a same-origin subresource of a page the browser has already authenticated, so it rides the `SameSite=Strict` session cookie exactly as `sdpi-components.js` does. No guard, no route and no auth decision is touched by this issue, and none should be.

## Why the settings window and nothing else

The window is the only page we serve that a browser gives window chrome to. It opens as `--app=<url>`, so it has a title bar, a taskbar button and an alt-tab entry, and each of those falls back to the browser's placeholder globe.

Property Inspectors are `file://` pages rendered inside the deck host. They have no tab, no title bar and no taskbar entry, so a favicon there is a request whose answer nothing displays. That is why the link goes in `settings-window.ejs` and deliberately not in `head-common.ejs`, which the 35 action PIs share.

## Alternatives rejected

**Reuse `iracedeck-logo.png`, already in `ui/`.** It costs no new file and no copy-list entry. It is the wordmark, though — roughly 95×26 as rendered in the header — and a browser scales the whole image into a square slot, so the mark arrives as an illegible smear a few pixels tall. A favicon has to be authored square.

**`assets/category-icon.png`.** The white monochrome Stream Deck category glyph, which is invisible on a light tab strip. It exists to sit on the deck host's dark chrome and is wrong for this by construction.

**Generate the icon at build time from an SVG source.** No generator exists for it, the website already commits its own favicon set rather than generating one, and a new generated artifact would need a freshness test guarding a file that changes when the brand does — roughly never. The cost of committing a 4 KB binary is lower than the cost of the machinery that would avoid it.

**Inline the icon as a `data:` URI in the template.** Avoids the copy-list entry entirely, at the price of a base64 blob inside a hand-edited EJS file and in every generated `settings-window.html`. Rejected on maintainability; the copy list is the established path and already carries four assets.

**Ship an `.ico`.** Chromium honours the declared `<link>`, so the multi-resolution container buys nothing here, and `.ico` has no `CONTENT_TYPES` entry — adding one would widen what the server serves for no gain.

## The one thing that is not settled

Whether the white-background mark reads well against a **dark** title bar. It is the same mark the website shows on both themes, so the expectation is yes; if the manual test says otherwise, the fix is a transparent-background variant swapped into the same filename — a one-file change that needs no rework of anything above. That is why this spec commits to the shipping path rather than to the pixels.

Separately, and outside this issue's control: whether the Windows **taskbar** button picks the favicon up at all, or keeps showing the Edge/Chrome icon, depends on how Chromium assigns the AppUserModelID for an `--app` window running under a custom `--user-data-dir`. The title bar icon is the outcome being bought; the taskbar is a possible bonus to be observed during the manual test, not a requirement to be engineered towards. Do not reach for a PWA install or a shortcut-with-icon to force it — that would trade a one-line template change for a second launch path to maintain.

## Drift worth knowing about

The committed copy means the brand mark now lives in two places in the repo — `packages/website/public/favicon-96x96.png` and `packages/pi-components/browser/iracedeck-icon.png` — and a future rebrand has to touch both. This is the same trade `iracedeck-logo.png` already makes, and the alternative (a package dependency from the plugin builds onto the website package) is worse for a file that changes once every few years.
