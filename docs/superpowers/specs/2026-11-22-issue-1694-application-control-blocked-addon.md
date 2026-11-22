# A native addon blocked by Windows application control

> **Issue:** [#1694](https://github.com/niklam/iracedeck/issues/1694) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

The issue is a user report: one day the plugin showed the #1373 banner *"iRaceDeck could not load its iRacing component"*, after working the day before. Their log carries Windows's reason:

```text
NativeAddons: iRacing native addon (iracing_native.node) failed to load; iRacing will read as not running: An Application Control policy has blocked this file.
```

That is Windows Code Integrity refusing the file, on a home PC almost always **Smart App Control** (Windows 11), on a managed one possibly an organisation's App Control (WDAC) policy. Smart App Control blocks a binary that is neither signed by a CA in Microsoft's Trusted Root Program nor known-good to Microsoft's reputation service. Nothing iRaceDeck ships is signed: `release-pack.yml` builds both `.node` files with node-gyp on `windows-latest` and packs them as they come out, so every release is a set of never-seen, unsigned binaries.

Three facts from the report shape the design:

- **The plugin did not change.** v3.8.1 shipped on 2026-11-08 and v3.9.0 on 2026-11-21; the report is from 2026-11-13. What changed was Windows' verdict — Smart App Control leaves evaluation mode on its own, and its reputation answers move — so this can reach any user on any day without an update.
- **Only `iracing_native.node` was refused.** `audio_native.node` and resvg's `.node`, equally unsigned, loaded in the same run. Why one and not the other is Microsoft's to know; the design must not assume all-or-nothing.
- **The #1373 banner fired as designed, but its remedy is wrong for this cause.** "Reinstall the plugin and check that your antivirus has not quarantined it" cannot help: a reinstall puts back the same refused file, and no antivirus was involved.

So there are two halves, and they ship independently: **say the right thing** when this happens (decisions 1–3, no outside dependency), and **make it stop happening** by signing what we ship (decision 4, which needs a certificate Niklas chooses and pays for).

## Decision 1: a failed load is classified by cause

`plugin-runtime` classifies each `load-failed` status into a cause:

```typescript
// shape, not final names
type NativeLoadFailureCause = "application-control" | "other";
```

- **The native packages do not change.** `NativeLoadStatus` keeps `{ kind: "load-failed"; error: string }` as #1373 decided; both stay zero-dependency leaves with no knowledge of Windows policy. Classification is a pure function in `native-addons.ts` over the error text and one fact read from the machine.
- **Primary signal: the error text.** Node's `process.dlopen` failure carries libuv's formatting of the Win32 error, which libuv asks for in US English first and falls back to the system language only when the English text is unavailable. `ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION` (4551, `0x11C7`) reads *"An Application Control policy has blocked this file."*; a match on that sentence is `application-control`. The implementation confirms the libuv behaviour against the Node version we ship on rather than trusting this paragraph.
- **Backstop: Smart App Control's state, for the localized case.** When the text does not match, and only on the failure path, `plugin-runtime` reads `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy\VerifiedAndReputablePolicyState` with `reg query`, the same way `settings-window`'s `chromium-browser.ts` reads App Paths. A value of `1` (On, enforcing) makes the failure `application-control`; anything else, a missing value or a failed read is `other`. An organisation's WDAC policy with a localized message stays `other` — the generic banner still points at the log, which names the reason in the user's language.
- **The read happens once, at startup, only when an addon failed.** A healthy start spawns nothing. The read is async and bounded by a timeout; a hang or error classifies as `other`, never delays startup past the timeout, and never throws.

## Decision 2: the banner and log line say what the cause needs

- **`application-control` gets its own banner text**, under the same `_warnings` id as today (`native-addon-iracing`, `native-addon-audio`), so it replaces the generic one rather than stacking beside it. Roughly: *"Windows blocked iRaceDeck's iRacing component (Smart App Control or an application control policy), so keys cannot read or control iRacing. Reinstalling will not help. The Troubleshooting page on iracedeck.com explains what to do."* The audio text names the Race Engineer and the radar, as #1373's does. No path, as #1373 decided.
- **`other` keeps #1373's banner unchanged.**
- **The `error` log line gains the cause**, so a support log says it without the reader recognising the Windows sentence: `…failed to load (blocked by Windows application control); iRacing will read as not running: <error>`. `.claude/rules/logging.md` lists the line and is updated with it.
- **The Telemetry Snapshot's `environment` section records the cause** beside the `load-failed` kind. It is a fixed enum and carries no path, so #1373's no-path rule holds.

## Decision 3: the Troubleshooting page gets its own section

`getting-started/troubleshooting.md` gains a section for the new banner, beside #1373's. It says:

- **What it is:** Windows' Smart App Control (or, on a work PC, the organisation's application control) refused a file iRaceDeck ships, and why it can start on a day the plugin did not change.
- **How to confirm:** Windows Security → App & browser control → Smart App Control shows whether it is On, and Protection history lists the blocked file.
- **What to do:** update iRaceDeck once a signed release is out (this line is written when decision 4 ships, not before); otherwise turning Smart App Control off, stated plainly as lowering a Windows protection and as the user's call. The page tells the user to check whether their Windows build lets them turn it back on — recent Windows 11 updates allow it, older builds needed a reset — rather than promising either. On a managed PC: ask IT to allow the file.
- **Not:** reinstall, or antivirus advice. Those stay in #1373's section.

The page is user-facing, so the change carries a changelog fragment, and its draft goes to Niklas before the PR (`issue-workflow.md`, step 8).

## Decision 4: every native binary we ship is Authenticode-signed

Smart App Control allows code signed by a CA in Microsoft's Trusted Root Program, which is the durable fix. Signing is not a guarantee — Microsoft also weighs the signer's reputation, which accrues over time on a stable signing identity — but an unsigned file has no path to being allowed at all.

- **What is signed:** every PE file in each plugin's shipped `bin/` tree that is not already validly signed: our `iracing_native.node` and `audio_native.node`, and third-party prebuilt `.node` files such as `@resvg/resvg-js`'s. Smart App Control judges each file, and the report shows the unsigned survivors survive only by luck. A third-party file signed by us carries our name as its publisher; that is accepted, since we are the ones shipping it.
- **Where:** a step in `release-pack.yml` after `Remove dev dependencies` and before `Pack plugins`, over all three plugin folders, so the Stream Deck, Mirabox and Ulanzi packages carry the same signed files.
- **How:** SHA-256 file digest, RSA key (Code Integrity is stricter than plain Authenticode; ECC is avoided for compatibility), and an RFC 3161 timestamp so signatures outlive the certificate.
- **Verified before upload:** after signing, a check runs `Get-AuthenticodeSignature` over every PE file in the three `bin/` trees and fails the run unless each is `Valid`. A tag build that cannot sign fails rather than publishing unsigned binaries. A non-tag run (a manual or branch run of `release-pack.yml`) skips signing and verification, since the signing secret is not available to it.
- **Secrets:** the signing credential lives only in GitHub Actions secrets for the release environment; no key, certificate or token is committed, and since 2023 the CA/B Forum requires an OV/EV private key to live in hardware (an HSM or a cloud signing service), so the step calls a signing service rather than holding a key file.
- **Local and development builds stay unsigned.** A developer whose machine enforces Smart App Control sees the new banner, which is the point of decisions 1–3.

### The provider is Niklas's decision, open at the time of writing

The step is written against whichever service he picks; the requirements above hold for each. The options as found on 2026-11-22, to be re-checked before buying:

| Option | Cost | Fit |
| --- | --- | --- |
| Microsoft Artifact Signing (formerly Trusted Signing) | Basic plan $9.99/month for 5,000 signatures | Built for CI (`azure/artifact-signing-action`). Identity validation for **individuals** is reported as US and Canada only; **organisations** in the EU are eligible. From Finland this likely needs a registered business. |
| OV code-signing certificate with cloud signing (e.g. SSL.com eSigner, Certum SimplySign) | roughly one to a few hundred euros a year, per vendor | Available to an individual in Finland; the key stays in the vendor's HSM and the vendor's CLI signs from CI. |
| Open-source signing programmes (e.g. SignPath Foundation) | free | Require an OSI-approved licence; the iRaceDeck Non-Commercial License is not one, so these are not expected to qualify. |

EV is not listed: it no longer buys SmartScreen reputation over OV, and it adds cost and validation burden.

## Out of scope

- **Reading the Code Integrity event log** (events 3077/3033) to name the policy that blocked a file. The error text and the registry value classify the case that matters; the event log needs elevated or event-log access and adds a parser for a better log line only.
- **Retrying the load during the run**, as #1373 already decided: a block does not clear without the user changing Windows.
- **Signing the deck-host packages themselves** (`.streamDeckPlugin`, the Ulanzi zip): they are archives, not PE files, and no Windows policy evaluates them.
- **macOS.** Neither addon loads there (the platform mock), and Gatekeeper is a separate concern with no reported problem.
- **Contacting Microsoft to whitelist the file**, or submitting binaries for analysis per release: a manual per-release step that signing makes unnecessary.

## Testing

- **Unit, classification:** the pure classifier returns `application-control` for the English sentence (taken verbatim from the issue's log, path suffix included), `other` for an unrelated load error (e.g. a missing module), `application-control` for a localized message when the Smart App Control value reads `1`, `other` for that message when it reads `0` or `2`, is missing, errors or times out. The registry reader is injected, so no test spawns `reg`.
- **Unit, output:** banner text and log line per cause per addon; the `other` banner is byte-identical to #1373's; the snapshot's environment section carries the cause; a healthy start never calls the registry reader.
- **Release verification:** the signing step's `Get-AuthenticodeSignature` check is itself proven by a failing case once — a run with one deliberately unsigned file must fail — before it is trusted (positive control).
- **Manual, messaging (Niklas):** in a linked tree, force the iRacing addon's load error to the issue's sentence (the load function is injectable since #1373) and restart the deck host: the PI and the Settings window show the application-control banner, the log line names the cause. Repeat with a generic error: #1373's banner, unchanged.
- **Manual, signing:** on a Windows 11 machine or VM with Smart App Control **On**, install the last unsigned release and see the block reproduced, then install the first signed release: both `.node` files load, `Get-AuthenticodeSignature` on each in the installed `bin/` reads `Valid`. Ask the #1694 reporter to confirm on the release that carries it.
