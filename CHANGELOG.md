# Changelog

## [1.3.0](https://github.com/niklam/iracedeck/compare/v1.2.0...v1.3.0) (2026-03-15)

### Features

* **stream-deck-plugin:** add font size setting for Chat action key text ([337ecd9](https://github.com/niklam/iracedeck/commit/337ecd91701e364b8fb2f7168f6957ac514ce3ca)), closes [#140](https://github.com/niklam/iracedeck/issues/140)
* **stream-deck-plugin:** add Race Admin action ([6a3e933](https://github.com/niklam/iracedeck/commit/6a3e933e721f7b6eae5736a3b9773e7908cd2f11)), closes [#139](https://github.com/niklam/iracedeck/issues/139)

### Bug Fixes

* address review findings and adjust car number icon positions ([c207870](https://github.com/niklam/iracedeck/commit/c207870c408ec8e62ca369a757e2360cdb7a12ab))
* align control counts across website pages and fix stale action count ([7c43bde](https://github.com/niklam/iracedeck/commit/7c43bde708ec11b29be46da9c2b18f1be55525c4))
* **stream-deck-plugin:** address PR review comments ([06777b3](https://github.com/niklam/iracedeck/commit/06777b3f02771b5b62ce1f17892fafb2caac1a91))
* **stream-deck-plugin:** address PR review findings for car number nav ([201c522](https://github.com/niklam/iracedeck/commit/201c522e05236b371b86d1e28596635d2910bef8))
* **stream-deck-plugin:** address Race Admin code review findings ([6689bd9](https://github.com/niklam/iracedeck/commit/6689bd90b28334157e4e5ca9a9c73384ef6934dc))
* **stream-deck-plugin:** adjust text vertical position based on font size ([6f2030e](https://github.com/niklam/iracedeck/commit/6f2030e792d22600a80b9e9ee51384a26b5849eb))
* **stream-deck-plugin:** correct misleading baseY comment about SVG Y-axis ([7dab6d0](https://github.com/niklam/iracedeck/commit/7dab6d0b8f05b09c3019cebe6b9bbc2dd15cca6e))
* **stream-deck-plugin:** fix TS2345 type errors in race-admin tests ([890d834](https://github.com/niklam/iracedeck/commit/890d834b6c4e8bce26d5595fdbfc38717e65306b))

### Refactoring

* **iracing-sdk:** extract getCarNumberFromSessionInfo to session-utils ([6a08467](https://github.com/niklam/iracedeck/commit/6a0846764e75311a083e6d2ac8a8e1f1ad0f7021)), closes [#139](https://github.com/niklam/iracedeck/issues/139)
* **stream-deck-plugin:** move car number navigation from Race Admin to Replay Control ([997407a](https://github.com/niklam/iracedeck/commit/997407a0c220d6fc17810b6e2249827f1b23bb04)), closes [#145](https://github.com/niklam/iracedeck/issues/145)
* **stream-deck-plugin:** split Show Disqualifications into field and driver modes ([4359eb9](https://github.com/niklam/iracedeck/commit/4359eb99f11d37839e940943a9c074fe675ac32e)), closes [#143](https://github.com/niklam/iracedeck/issues/143)

### Documentation

* add Race Admin action documentation ([2db42d4](https://github.com/niklam/iracedeck/commit/2db42d4fb942f4c6c5af340fd9404065842f1ba1))
* **website:** document Chat action settings and fix encoder description ([f83593d](https://github.com/niklam/iracedeck/commit/f83593da33dd580a4db53114f3b067685fb4e8fd))

## [1.2.0](https://github.com/niklam/iracedeck/compare/v1.1.0...v1.2.0) (2026-03-14)

### Features

* **stream-deck-plugin:** add camera subactions to Replay Control ([fde7b3e](https://github.com/niklam/iracedeck/commit/fde7b3ec7108bf1a9234126d68a3c6bfc03b32b5)), closes [#125](https://github.com/niklam/iracedeck/issues/125)
* **stream-deck-plugin:** refine camera subaction icons ([88506df](https://github.com/niklam/iracedeck/commit/88506df3873d495a970c4ca90e48f8de129fc9b5))

### Bug Fixes

* **stream-deck-plugin:** use switchNum with car number lookup for camera subactions ([ebd28e2](https://github.com/niklam/iracedeck/commit/ebd28e245b5b0b8a841ebbd053bc9b6ef11b2a98)), closes [#125](https://github.com/niklam/iracedeck/issues/125)
* **website:** add build step and change deploy trigger for Firebase Hosting ([cd6353e](https://github.com/niklam/iracedeck/commit/cd6353ec22905efe8607953fa03a2e6f560a4076))

### Refactoring

* **stream-deck-plugin:** address review feedback for camera subactions ([73fa323](https://github.com/niklam/iracedeck/commit/73fa323f772b2dd504ed4a0a4f07d0faac83f2e7))
* **website:** rename workflow to firebase-hosting-release.yml ([88ba6a9](https://github.com/niklam/iracedeck/commit/88ba6a9a0d0ccbf7a206cf30ea9701e7cd5b4d45))

### Documentation

* fix stale control count total in actions skill metadata ([0a57286](https://github.com/niklam/iracedeck/commit/0a572865611185733547b6546538d5732bd7392f))
* fix View & Camera control count (101 → 104) in actions skill ([6c58a9e](https://github.com/niklam/iracedeck/commit/6c58a9ec11617b1b0780179c7e8283a7cc0bc8af))
* **website:** update controls count to 290 on landing page ([24724b1](https://github.com/niklam/iracedeck/commit/24724b1f879ea8ef2c251e0f18e59c30d386115f))

## [1.1.0](https://github.com/niklam/iracedeck/compare/v1.0.0...v1.1.0) (2026-03-14)

### Features

* **icons:** add set-speed and speed-display icons for replay control ([32a59b8](https://github.com/niklam/iracedeck/commit/32a59b84abf65b5ddc775cde5b915482aae0a7d4)), closes [#2a3a4a](https://github.com/niklam/iracedeck/issues/2a3a4a) [#127](https://github.com/niklam/iracedeck/issues/127)
* **icons:** redesign frame forward/backward as film strip icons ([ca8f02a](https://github.com/niklam/iracedeck/commit/ca8f02a88100697933e3298706b6fa7d6fc4a668)), closes [#127](https://github.com/niklam/iracedeck/issues/127)
* **icons:** redesign next/prev lap as oval race track icons ([d6ffc1f](https://github.com/niklam/iracedeck/commit/d6ffc1f72ec5f5d7359565e6e043007c1c4d4249)), closes [#127](https://github.com/niklam/iracedeck/issues/127)
* **stream-deck-plugin:** add long-press repeat for speed and transport controls ([a061e29](https://github.com/niklam/iracedeck/commit/a061e29700faaad61ae4dca61423758aad029813)), closes [#127](https://github.com/niklam/iracedeck/issues/127)
* **stream-deck-plugin:** add play backward mode and fix play/pause behavior ([76e942e](https://github.com/niklam/iracedeck/commit/76e942ed7d5086e94c3d766007eb1990fe1ed1ab)), closes [#127](https://github.com/niklam/iracedeck/issues/127)
* **stream-deck-plugin:** add progressive replay speed control ([7a216ee](https://github.com/niklam/iracedeck/commit/7a216eeb6472d67a1bd1b930af9d37a7d63c9178)), closes [#127](https://github.com/niklam/iracedeck/issues/127)
* **stream-deck-plugin:** direction-aware speed control and turtle/rabbit icons ([2166bdc](https://github.com/niklam/iracedeck/commit/2166bdcc3afe0286eabc7d020d8695ff5bb723d4)), closes [#127](https://github.com/niklam/iracedeck/issues/127)
* **stream-deck-plugin:** redesign set-speed gauge with dynamic needle angle ([0198f6e](https://github.com/niklam/iracedeck/commit/0198f6e3d629f01087dbcd18c3edb0b466d9d99f)), closes [#127](https://github.com/niklam/iracedeck/issues/127)
* **stream-deck-plugin:** redesign speed display icon and labels ([2db510c](https://github.com/niklam/iracedeck/commit/2db510c3311f7bb41a88b266c3aab11275eb81f2)), closes [#127](https://github.com/niklam/iracedeck/issues/127)
* **stream-deck-plugin:** speed increase/decrease spans full 1/16x to 16x range ([bd709b4](https://github.com/niklam/iracedeck/commit/bd709b467c896a55e341838ff17eccc0b5ccad64)), closes [#127](https://github.com/niklam/iracedeck/issues/127)
* **website:** add iRating Gain stat and asterisk joke ([3cee986](https://github.com/niklam/iracedeck/commit/3cee986e38c28a0d59891fca5302a19ca06a6fea))
* **website:** improve landing page, add social links and install options ([85150fa](https://github.com/niklam/iracedeck/commit/85150fa59ff2033676dc2621645aaaf3ce69f55d))
* **website:** migrate from static HTML to Astro + Starlight ([322d206](https://github.com/niklam/iracedeck/commit/322d2062cd447a7141d4ce1f996e28630fa3263b)), closes [#ce2128](https://github.com/niklam/iracedeck/issues/ce2128)
* **website:** polish landing page layout and styling ([93b4637](https://github.com/niklam/iracedeck/commit/93b4637a491ee34a4ee03bcc85be0c9a777a9692))
* **website:** use proper logo variants with transparent backgrounds ([566bfd7](https://github.com/niklam/iracedeck/commit/566bfd7e379c7842f06ebdde97c3e18cc2eec5ad))

### Bug Fixes

* address review feedback and add fenced code block rule ([532a7b2](https://github.com/niklam/iracedeck/commit/532a7b2497d25539dc4044618f606c6532b6b1f2))
* **icons:** adjust stop icon vertical position ([304ad7b](https://github.com/niklam/iracedeck/commit/304ad7b80582dad286d36ff844ec7f94cb3d905b)), closes [#127](https://github.com/niklam/iracedeck/issues/127)
* **iracing-native:** add granular focus result codes and increase timeout ([c3d7770](https://github.com/niklam/iracedeck/commit/c3d7770c650c23ebbdd902f71054ac32dcc6ec19)), closes [#131](https://github.com/niklam/iracedeck/issues/131)
* **iracing-native:** use ALT key workaround to bypass foreground lock ([1987f5d](https://github.com/niklam/iracedeck/commit/1987f5d3fd3cdca02fd9bb49da9dc9dc085c42eb)), closes [#131](https://github.com/niklam/iracedeck/issues/131)
* **stream-deck-plugin:** address PR review feedback for replay control ([27495ca](https://github.com/niklam/iracedeck/commit/27495cae07e8eaf7449478bf07a3e2b738e47e93)), closes [#127](https://github.com/niklam/iracedeck/issues/127)
* **stream-deck-plugin:** address second round PR review feedback ([1eee311](https://github.com/niklam/iracedeck/commit/1eee3118d79951d6fe89c0365db6f5b3806e96b5)), closes [#127](https://github.com/niklam/iracedeck/issues/127)
* **stream-deck-plugin:** play buttons pause at any same-direction speed ([b5a2e8d](https://github.com/niklam/iracedeck/commit/b5a2e8dd5fe6a216bcc93435877a2959f69bc6a7)), closes [#127](https://github.com/niklam/iracedeck/issues/127)
* **stream-deck-plugin:** play buttons reset FF/rewind to 1x and mirror slow-mo ([0fcb85e](https://github.com/niklam/iracedeck/commit/0fcb85ed1c9f96194a756b552ca3e095cd06050a)), closes [#127](https://github.com/niklam/iracedeck/issues/127)
* **website:** address code review feedback ([e90e372](https://github.com/niklam/iracedeck/commit/e90e372767c7468b03c2f82998a286fc91924ce0))
* **website:** fine-tune landing page spacing and theme toggle alignment ([350705f](https://github.com/niklam/iracedeck/commit/350705f5609fcd459dc139124db37629d6d7a297))

### Refactoring

* **website:** move docs under /docs/ prefix, add Features section ([ff29496](https://github.com/niklam/iracedeck/commit/ff29496511abb6aea972da03c1264b876b01c85a))

### Documentation

* update action references for progressive replay speed modes ([f71b8e8](https://github.com/niklam/iracedeck/commit/f71b8e879bb343927a79b911198fc890c2a2ff98)), closes [#127](https://github.com/niklam/iracedeck/issues/127)
* **website:** add all documentation content pages ([fd886f7](https://github.com/niklam/iracedeck/commit/fd886f7f06d45d19bf3661fcb4987aff29a387b5))
* **website:** add Development section and Reddit sidebar link ([91920a7](https://github.com/niklam/iracedeck/commit/91920a73b655eb0eb6e1fd97d72c5eb4c55f40e4))
* **website:** update counts and replay control page for progressive speed ([a02c211](https://github.com/niklam/iracedeck/commit/a02c21186d6e31b062423c8bba36e85209ab598a))

### Maintenance

* update skills for /docs/ restructuring and template variables ([1add388](https://github.com/niklam/iracedeck/commit/1add388b2455109f90e22c6967e4e49b955cf90a))
* update skills for Astro website migration ([b094d91](https://github.com/niklam/iracedeck/commit/b094d91473cd84149b7ca26357bebd8af0b976f5))

## [1.0.0](https://github.com/niklam/iracedeck/compare/v0.13.0...v1.0.0) (2026-03-13)

### ⚠ BREAKING CHANGES

* **stream-deck-plugin:** Replay Transport, Replay Speed, and Replay Navigation actions
are replaced by the unified Replay Control action. Existing instances continue
to work but are hidden from the action list.
* **stream-deck-plugin:** Spotter volume and silence controls have been moved
from Audio Controls to the new AI Spotter Controls action. Users with
existing Audio Controls buttons configured for spotter will need to
reconfigure them using the new AI Spotter Controls action.

The Audio Controls action now only supports voice-chat and master
categories. The default category changes from 'spotter' to 'voice-chat'.

### Features

* **icons:** add Change All Tires icon for tire service ([d033a6a](https://github.com/niklam/iracedeck/commit/d033a6a60523211e363504df10d6def079198bbd))
* **icons:** add toggle-wipers icon variant for cockpit-misc ([7d51689](https://github.com/niklam/iracedeck/commit/7d516899a0c74d068fafb39f96bf71b73a0207dd))
* **iracing-native:** add focusIRacingWindow native function ([3a79366](https://github.com/niklam/iracedeck/commit/3a793668b4f78dfbf2e756cb6177dc7cf26e69f0)), closes [#111](https://github.com/niklam/iracedeck/issues/111)
* **iracing-native:** add mock mode on Windows and flag test snapshots ([6361df5](https://github.com/niklam/iracedeck/commit/6361df5bf8c38f3587cd92115afdb1a60b7e4a9c))
* **iracing-sdk:** extract flag utilities for cross-plugin reuse ([a74431f](https://github.com/niklam/iracedeck/commit/a74431fceec40f8ed1d795bf07c909c7a1243755))
* **stream-deck-plugin:** add AI Spotter Controls action ([bd0946e](https://github.com/niklam/iracedeck/commit/bd0946eee5188a08f1897cda1f82bf586ecc3839)), closes [#117](https://github.com/niklam/iracedeck/issues/117)
* **stream-deck-plugin:** add AI Spotter Controls icon SVGs ([8356386](https://github.com/niklam/iracedeck/commit/8356386ac797a7efeea25f5ea97894892f3a098c))
* **stream-deck-plugin:** add Change All Tires sub-action to Tire Service ([5cf7845](https://github.com/niklam/iracedeck/commit/5cf78457219afaf96acc97d13322680d904b0afe)), closes [#t](https://github.com/niklam/iracedeck/issues/t) [#115](https://github.com/niklam/iracedeck/issues/115)
* **stream-deck-plugin:** add common-settings include to all PI templates ([1428763](https://github.com/niklam/iracedeck/commit/14287630b9d755cc9bc6602a4857de38f4e57200))
* **stream-deck-plugin:** add common-settings PI partial ([1eb0904](https://github.com/niklam/iracedeck/commit/1eb0904401e07931fae9fb1ba987806f47ca7093))
* **stream-deck-plugin:** add CommonSettings schema ([36a3601](https://github.com/niklam/iracedeck/commit/36a3601ba92861bfda42d6eec58844e2258c96fc))
* **stream-deck-plugin:** add flag overlay to BaseAction ([401a014](https://github.com/niklam/iracedeck/commit/401a014b1c5b43101310daa4725c79731b2e8487))
* **stream-deck-plugin:** add focus setting to Property Inspector ([3a9626a](https://github.com/niklam/iracedeck/commit/3a9626a0fd304bd14c6d39f2410376f24f5515f6)), closes [#111](https://github.com/niklam/iracedeck/issues/111)
* **stream-deck-plugin:** add focusIRacingWindow global setting ([9e03a73](https://github.com/niklam/iracedeck/commit/9e03a734425fbb28b18848683499fac9d12c50c1)), closes [#111](https://github.com/niklam/iracedeck/issues/111)
* **stream-deck-plugin:** add Replay Control icon SVGs ([eef13e9](https://github.com/niklam/iracedeck/commit/eef13e9c99b166ec9056af37be7e54f119e4709b))
* **stream-deck-plugin:** add Replay Control Property Inspector template ([674a537](https://github.com/niklam/iracedeck/commit/674a5374a46b422b44725d3386b8fcf8962da7bf))
* **stream-deck-plugin:** add Toggle Wipers global key binding ([d0e2ff6](https://github.com/niklam/iracedeck/commit/d0e2ff63ac1660dd01560ee38fee7b97ea7c9192))
* **stream-deck-plugin:** add Toggle Wipers option to cockpit-misc PI ([cdf5988](https://github.com/niklam/iracedeck/commit/cdf5988d6d1a3b8b3e1d16b71aa952ae9ea6510b))
* **stream-deck-plugin:** add toggle-wipers control to cockpit-misc action ([64f2fbe](https://github.com/niklam/iracedeck/commit/64f2fbe2267aef4e916bcfd3b7b35d5a3950d1c3))
* **stream-deck-plugin:** differentiate louder/quieter icons by wave count ([a001841](https://github.com/niklam/iracedeck/commit/a0018410da35b2328cab3ebfb641fd03828b1321))
* **stream-deck-plugin:** extend CommonSettings in all action schemas ([e710985](https://github.com/niklam/iracedeck/commit/e7109854e74f14876d6357491bb21775fe0f3f1e))
* **stream-deck-plugin:** focus iRacing window before sending keys ([a33a7e0](https://github.com/niklam/iracedeck/commit/a33a7e018f909e4a1c4126dcb74e46184eeee396)), closes [#111](https://github.com/niklam/iracedeck/issues/111)
* **stream-deck-plugin:** implement Replay Control action ([b8efe05](https://github.com/niklam/iracedeck/commit/b8efe0539ad9c5a2ff6ed4902475e295fe79a157)), closes [#110](https://github.com/niklam/iracedeck/issues/110)
* **stream-deck-plugin:** register Replay Control and hide legacy replay actions ([264279d](https://github.com/niklam/iracedeck/commit/264279d2c890725486a34daa7769ab749d1e8e8e)), closes [#110](https://github.com/niklam/iracedeck/issues/110)
* **stream-deck-plugin:** remove spotter category from Audio Controls ([ada7fab](https://github.com/niklam/iracedeck/commit/ada7fab6f1d11e9d1efeac5e192051995cdb2ad3))
* **stream-deck-plugin:** swap spotter icon labels and polish icons ([2c8406a](https://github.com/niklam/iracedeck/commit/2c8406ad1aa93bdbe8535bf15622844a1ac31df9))

### Bug Fixes

* add markdown language label and log swallowed catch errors ([4923227](https://github.com/niklam/iracedeck/commit/4923227481c98af2c04b5c3e58dba8fdb7a21971))
* **docs:** move macro entries after send-message in actions.json ([97d412c](https://github.com/niklam/iracedeck/commit/97d412c2fdcfcda6041c036f557425f9bd3c9e65))
* harden window focus with null checks, try/catch, and timeout detection ([1735650](https://github.com/niklam/iracedeck/commit/1735650d2b113e83f7763839698f36a8465680e9))
* **icons:** make replay control icons white and solid ([ba9796d](https://github.com/niklam/iracedeck/commit/ba9796d6a8d77f926ee13243d64ce566c6f42640))
* **iracing-native:** close chat window after sending message ([8d6f2ac](https://github.com/niklam/iracedeck/commit/8d6f2ac1fde6d7d1ababc27d5555e24e3cae85fb)), closes [#108](https://github.com/niklam/iracedeck/issues/108)
* **iracing-native:** poll for confirmed focus after SetForegroundWindow ([d71bd55](https://github.com/niklam/iracedeck/commit/d71bd55bfc8c51d362b6c9510732ac460ed35cc4))
* **iracing-sdk:** add YellowWaving to flag detection and improve flag debug logging ([71983ab](https://github.com/niklam/iracedeck/commit/71983ab53e045520df3a3796214123d4237ee0c8))
* make relink:stream-deck tolerant of missing plugin ([14f80eb](https://github.com/niklam/iracedeck/commit/14f80eb29fe8a84bf273636e3f2049f12719f54c))
* **stream-deck-plugin:** add missing replay-control PI HTML ([2c90900](https://github.com/niklam/iracedeck/commit/2c9090067da2bcb07ab91683a413d754ce9917b8))
* **stream-deck-plugin:** add telemetry-aware play/pause icon toggle ([9cea11d](https://github.com/niklam/iracedeck/commit/9cea11d54a6da15486ce83924f31ffd397e991e6))
* **stream-deck-plugin:** assign flagTelemetrySubId only after successful subscribe ([b3703c8](https://github.com/niklam/iracedeck/commit/b3703c8dd0cd848276dd5f1bd6194156c2a675f5))
* **stream-deck-plugin:** fix flag overlay flashing and filter informational flags ([9179bcb](https://github.com/niklam/iracedeck/commit/9179bcbf85d6d25ee2365800fceb4021d073e6aa))
* **stream-deck-plugin:** fix TypeScript errors from CommonSettings integration ([594340b](https://github.com/niklam/iracedeck/commit/594340b7a614bd6c9cfe336f0a646302159f95d8))
* **stream-deck-plugin:** rebuild audio-controls PI after spotter extraction ([6996e9b](https://github.com/niklam/iracedeck/commit/6996e9b6a4e5ed3c350e37c294f2dd1591f9b1e7))
* **stream-deck-plugin:** rebuild chat.html with reordered modes from [#116](https://github.com/niklam/iracedeck/issues/116) ([3be1a17](https://github.com/niklam/iracedeck/commit/3be1a17fd8492c3700febf4a2a16805f09d8c420))
* **stream-deck-plugin:** reorder Chat modes with Send Message as default ([a7fe52f](https://github.com/niklam/iracedeck/commit/a7fe52f656b6731808845627ca299fa0e8a57ebc)), closes [#112](https://github.com/niklam/iracedeck/issues/112)
* **stream-deck-plugin:** reset flag state in stopFlagFlash to prevent stale cache ([2548777](https://github.com/niklam/iracedeck/commit/2548777cc00426a5ec8cf65c884e891dc8a4f66b))
* **stream-deck-plugin:** resolve mustache templates in message field for icon display ([dcfa902](https://github.com/niklam/iracedeck/commit/dcfa90214c316a52e716afd0daab05dd7a46fbf6)), closes [#114](https://github.com/niklam/iracedeck/issues/114)
* **stream-deck-plugin:** skip flag overlay contexts in setActive refresh loop ([0d996b7](https://github.com/niklam/iracedeck/commit/0d996b7e3652692754a402d8d0b1ab7ddd142e13))
* **stream-deck-plugin:** update replay action tests to match new labels ([b2a7ab0](https://github.com/niklam/iracedeck/commit/b2a7ab03dd1845221eda8dc94c7bb3a563b98cf9))
* **stream-deck-plugin:** update replay control labels and icons ([5512b79](https://github.com/niklam/iracedeck/commit/5512b79ca74f805860b67202ac61edaf11723caf))
* **stream-deck-plugin:** use static counter for flag subscription IDs ([3530620](https://github.com/niklam/iracedeck/commit/35306202bd8b082abf526c3fdfee5362f369b18e))

### Refactoring

* **iracing-native:** use named constant for chat step delays ([b25c6cc](https://github.com/niklam/iracedeck/commit/b25c6ccffe10614809a1f48d8244c0b8665976e5))
* **stream-deck-plugin:** import flag utils from SDK ([9286171](https://github.com/niklam/iracedeck/commit/928617103da5ceade15bd643850b3df42224f454))
* **stream-deck-plugin:** move window focus from keyboard service to plugin level ([d31b77e](https://github.com/niklam/iracedeck/commit/d31b77e87606e0152ee836cf56594fafd58352f9)), closes [#111](https://github.com/niklam/iracedeck/issues/111)
* **stream-deck-plugin:** show common settings as visible section above key bindings ([43a13c2](https://github.com/niklam/iracedeck/commit/43a13c23c69c7ee6b9d22704ec3077ed0d826bb1))

### Documentation

* add Change All Tires to action references ([40b73ae](https://github.com/niklam/iracedeck/commit/40b73ae26556180f0016daa017d3593acb96fc1f))
* add flags overlay design spec ([#106](https://github.com/niklam/iracedeck/issues/106)) ([adc7fa0](https://github.com/niklam/iracedeck/commit/adc7fa0ab71600edb5b861d9f152d35be4523434))
* add flags overlay implementation plan ([75124e0](https://github.com/niklam/iracedeck/commit/75124e08702ecbbce28f69b87cfa06c5da8dc88e))
* add Replay Control spec and implementation plan ([2cbb67a](https://github.com/niklam/iracedeck/commit/2cbb67a0cf94a6601e1fb892352a9f21d6764cb0)), closes [#110](https://github.com/niklam/iracedeck/issues/110)
* add SessionFlags reference and mock mode documentation to skills ([decd2a6](https://github.com/niklam/iracedeck/commit/decd2a608680fb72ab26693d912935d085d9d006))
* add toggle-wipers to actions reference and skill metadata ([4b6eb40](https://github.com/niklam/iracedeck/commit/4b6eb4085c699d7ccb0a09c89163b8ab9c1a7148))
* address spec review feedback for flags overlay ([#106](https://github.com/niklam/iracedeck/issues/106)) ([ae25bd1](https://github.com/niklam/iracedeck/commit/ae25bd10f60a63ed213146c76e260a1a0eb18df8))
* enforce worktree workflow, pre-commit checks, and post-merge cleanup ([b84960c](https://github.com/niklam/iracedeck/commit/b84960c4d68a6363561608243aea869f6fdd540c))
* **iracing-native:** clarify .mock file path for non-plugin consumers ([ea74f24](https://github.com/niklam/iracedeck/commit/ea74f24d7eae95b24a03241d20e7247dd8e48386))
* remove stale spotter references from Audio Controls ([a138451](https://github.com/niklam/iracedeck/commit/a138451c526a718e83ad5d51ec04a847bcc3399d))
* **stream-deck-plugin:** update cockpit-misc tooltip to mention toggle wipers ([821fe8a](https://github.com/niklam/iracedeck/commit/821fe8a65becddd19407f25d1146917b1978882f))
* update action conventions for CommonSettings and super calls ([fe930fa](https://github.com/niklam/iracedeck/commit/fe930fa00d4daaeb488b77a2affa172f971b6c21)), closes [#106](https://github.com/niklam/iracedeck/issues/106)
* update rules for focusIRacingWindow feature ([adbaf1f](https://github.com/niklam/iracedeck/commit/adbaf1f015bc5dc88c7b20d80201ce2e9ad067b2))
* update SKILL.md action counts for AI Spotter Controls ([774b2fc](https://github.com/niklam/iracedeck/commit/774b2fcef8eacf5a00ed3f03a192264500315322))
* update spotter shortcuts and action reference for AI Spotter Controls ([d499dce](https://github.com/niklam/iracedeck/commit/d499dce48f176adeebefde6b9bc9eaf4535f734e))
* update Toggle Windshield Wipers default key to Shift+W ([e9c571b](https://github.com/niklam/iracedeck/commit/e9c571bcf1426cf46521e392f2b98fc6dcaaf4cb))

### Maintenance

* add stream-deck link/unlink/relink pnpm scripts ([62f05fc](https://github.com/niklam/iracedeck/commit/62f05fc8d9d049a81527f7794408c14a19c51443)), closes [#122](https://github.com/niklam/iracedeck/issues/122)
* **deps-dev:** bump @eslint/js from 9.39.3 to 9.39.4 ([#95](https://github.com/niklam/iracedeck/issues/95)) ([83e252e](https://github.com/niklam/iracedeck/commit/83e252e9040860466ccefc71a3db9d63554a4f72))
* **deps-dev:** bump @rollup/plugin-node-resolve from 15.3.1 to 16.0.3 ([#92](https://github.com/niklam/iracedeck/issues/92)) ([494f955](https://github.com/niklam/iracedeck/commit/494f955a21b53a5ac0e77f20b4b1eae86902c80f))
* **deps-dev:** bump @rollup/plugin-terser from 0.4.4 to 1.0.0 ([#93](https://github.com/niklam/iracedeck/issues/93)) ([d69a385](https://github.com/niklam/iracedeck/commit/d69a385da386e590e815f1816ed082328b778d5b))
* **deps-dev:** bump ejs from 4.0.1 to 5.0.1 ([#94](https://github.com/niklam/iracedeck/issues/94)) ([5435e79](https://github.com/niklam/iracedeck/commit/5435e790c793a13e768ff8d3d956aa810b8aec98))
* **deps-dev:** bump the minor-and-patch group with 3 updates ([#91](https://github.com/niklam/iracedeck/issues/91)) ([b650f2f](https://github.com/niklam/iracedeck/commit/b650f2f95e3aae6b9db06f388f5ddc31e9361406))
* **deps:** bump actions/checkout from 4 to 6 ([#90](https://github.com/niklam/iracedeck/issues/90)) ([eb0dc83](https://github.com/niklam/iracedeck/commit/eb0dc8344ea9db5a306aa754f5037e802fab8f1e))
* **deps:** bump actions/setup-node from 4 to 6 ([#89](https://github.com/niklam/iracedeck/issues/89)) ([4bb4889](https://github.com/niklam/iracedeck/commit/4bb4889790ac89429fef80d9f9e6e47931385179))
* require logical commits and switch to regular merges ([3233e1d](https://github.com/niklam/iracedeck/commit/3233e1d260d4964bac1e28428035cac8b8517360))
* **stream-deck-plugin:** improve global settings diagnostic logging ([41508ac](https://github.com/niklam/iracedeck/commit/41508ac4aff7488aba6e6c574beda8dfad136871))
* **stream-deck-plugin:** rebuild cockpit-misc PI HTML ([58be779](https://github.com/niklam/iracedeck/commit/58be77952f6037014c62903200c3725f1ff8f79c))
* **stream-deck-plugin:** rebuild PI HTML files with common-settings ([b07a1a1](https://github.com/niklam/iracedeck/commit/b07a1a1610caf17d40ae872f0e022a41af9ae2ad))
* unify build scripts with smart Stream Deck stop/restart ([2adc237](https://github.com/niklam/iracedeck/commit/2adc237afdf1676c9ec50db34e82cbbba2a84ce4))

## [0.13.0](https://github.com/niklam/iracedeck/compare/v0.12.0...v0.13.0) (2026-03-11)

### Features

* **website:** link to Elgato Marketplace instead of GitHub releases ([1dea507](https://github.com/niklam/iracedeck/commit/1dea50745d6ce10d4f73eb428528fe4347a8a97c))

### Maintenance

* add .sdignore, change build script to trim Stream Deck plugin ([#103](https://github.com/niklam/iracedeck/issues/103)) ([7f5ee0e](https://github.com/niklam/iracedeck/commit/7f5ee0ef9b4492b220594284388d5770568bca59))

## [0.12.0](https://github.com/niklam/iracedeck/compare/v0.11.0...v0.12.0) (2026-03-10)

### Features

* **iracing-sdk:** add lazy template context caching to SDKController ([2157126](https://github.com/niklam/iracedeck/commit/21571266d3e99c65ae3a5910363a2706917db24f))
* **iracing-sdk:** convert known 0/1 boolean telemetry fields to Yes/No ([4ec9673](https://github.com/niklam/iracedeck/commit/4ec9673f83c3eb14b4b02fdbbbc9b93ccb08d9a3))
* **stream-deck-plugin:** add Telemetry Display action with custom template support ([38f10da](https://github.com/niklam/iracedeck/commit/38f10da6404d60248f2edab63c01b4a3d1cc6525))
* **stream-deck-plugin:** support multiline templates in telemetry display ([3fc0121](https://github.com/niklam/iracedeck/commit/3fc01215c18a6bf2fba4967b3b4ac3723a830543))
* **stream-deck-plugin:** use number input for telemetry display font size ([28d85b7](https://github.com/niklam/iracedeck/commit/28d85b79da2466ca1a8f4a6d330921326cd051d5))
* **stream-deck-plugin:** use text color for telemetry display title ([cc40e6c](https://github.com/niklam/iracedeck/commit/cc40e6c66cd172240bbcdf996d4edc1e2d5db10a))
* **website:** add template variables reference page ([bc8e616](https://github.com/niklam/iracedeck/commit/bc8e616eb48a82d0aff1d01325c3a09f9d49a53f))

### Bug Fixes

* **icons:** change subLabel text color from [#aaaaaa](https://github.com/niklam/iracedeck/issues/aaaaaa) to [#ffffff](https://github.com/niklam/iracedeck/issues/ffffff) for readability ([e02e5c8](https://github.com/niklam/iracedeck/commit/e02e5c8e8943d00062fd9002f5b73485d898ec4c))
* **iracing-sdk:** flatten template context for correct dot-notation variable resolution ([aeec573](https://github.com/niklam/iracedeck/commit/aeec57323912da7b6525304e3d32a32325e0a1a9))
* **stream-deck-plugin:** adjust telemetry display text vertical position by font size ([06fc659](https://github.com/niklam/iracedeck/commit/06fc6593a2a50574fbc12e4d7ad87c24493b30de))
* **stream-deck-plugin:** apply defaults for sdpi-textfield and sdpi-textarea ([9ce9d03](https://github.com/niklam/iracedeck/commit/9ce9d03d5978fc5572ee11d28aa288281c621d65))
* **stream-deck-plugin:** fix PI template link URLs and font sizes ([0b7f856](https://github.com/niklam/iracedeck/commit/0b7f85645c8ee7f8609b7e18a4af7cb2b18f72e4))
* **stream-deck-plugin:** open PI links in new window with target="_blank" ([08ccfd8](https://github.com/niklam/iracedeck/commit/08ccfd86f8ead5caaef4294c32495cbf1712c605))
* **stream-deck-plugin:** unify PI template help text across actions ([02af3ce](https://github.com/niklam/iracedeck/commit/02af3ce04ad43c009ac0d0602524c2ce463712e7))
* **stream-deck-plugin:** update telemetry display defaults to CAR # template ([a478f2c](https://github.com/niklam/iracedeck/commit/a478f2cc7060f234cd816e7bba0887d380be570f))
* **website:** complete template variables reference with all session info fields ([4e71a14](https://github.com/niklam/iracedeck/commit/4e71a14452674b302f6bb7c364df085569ffff32))

### Refactoring

* **stream-deck-plugin:** simplify Telemetry Display Property Inspector ([eae354b](https://github.com/niklam/iracedeck/commit/eae354b56835e5942f1c7a087a160de3dbdb86b8))
* **stream-deck-plugin:** simplify Telemetry Display to custom template only ([c82636a](https://github.com/niklam/iracedeck/commit/c82636a0c0b3683209259cb2e3ae0a70d2139e86))

### Documentation

* mark all design doc progress items complete ([139d68b](https://github.com/niklam/iracedeck/commit/139d68bbd93bb4d54c436ecdaf09367ce11e4771))
* update Telemetry Display manifest and actions reference ([703e878](https://github.com/niklam/iracedeck/commit/703e878a08aabe8d1db6036f9eaefbe06e946ebc))

### Maintenance

* remove superseded template-variables.md and add design docs ([2fc4456](https://github.com/niklam/iracedeck/commit/2fc4456d84a3236da6c6f1b39cf028ee9f80881c))
* **website:** add Google Analytics tracking ([#97](https://github.com/niklam/iracedeck/issues/97)) ([bc0cd73](https://github.com/niklam/iracedeck/commit/bc0cd731d72c5d5d9bd1c142867ec3172aeb2687))
* **website:** update download links to v0.11.0 ([3b23c41](https://github.com/niklam/iracedeck/commit/3b23c41eb0f9519a30783737c61d87881f3673a2))

## [0.11.0](https://github.com/niklam/iracedeck/compare/v0.10.1...v0.11.0) (2026-03-08)

### Features

* **iracing-sdk:** add template variable system for dynamic string resolution ([#96](https://github.com/niklam/iracedeck/issues/96)) ([700879d](https://github.com/niklam/iracedeck/commit/700879d93eba5108bcdb6c04482140978896f169))

### Bug Fixes

* **icons:** update fuel-service icon designs ([#88](https://github.com/niklam/iracedeck/issues/88)) ([ffc343f](https://github.com/niklam/iracedeck/commit/ffc343f0e9e7006fe161ba6aed610e1e4ccccd1d))

### Refactoring

* **icons:** complete icon extraction and cleanup unused utilities ([#87](https://github.com/niklam/iracedeck/issues/87)) ([31b5c7c](https://github.com/niklam/iracedeck/commit/31b5c7c4d11fb9e6c7d624bcf660c745039631d8))
* **icons:** extract dynamic action icons to @iracedeck/icons ([#86](https://github.com/niklam/iracedeck/issues/86)) ([f14acd7](https://github.com/niklam/iracedeck/commit/f14acd7e33f1fe40fd13cd9b6e7bf78cae9eb4f8))
* **icons:** extract icons to shared @iracedeck/icons package ([#84](https://github.com/niklam/iracedeck/issues/84)) ([3dc4f52](https://github.com/niklam/iracedeck/commit/3dc4f521b46cf4e35b79b6ae00d92c197c6d2047))
* **icons:** extract remaining static action icons to @iracedeck/icons ([#85](https://github.com/niklam/iracedeck/issues/85)) ([7d482b2](https://github.com/niklam/iracedeck/commit/7d482b2af5d1b011c5af0ca637b65824df7e3363))

### Documentation

* **website:** add download links, version requirement, and troubleshooting ([#83](https://github.com/niklam/iracedeck/issues/83)) ([d488cc0](https://github.com/niklam/iracedeck/commit/d488cc0b57a10de4afec16a956e24b0dbf9c188d))

### Maintenance

* **deps-dev:** bump @types/node from 24.0.15 to 25.3.3 ([#69](https://github.com/niklam/iracedeck/issues/69)) ([a9f47ae](https://github.com/niklam/iracedeck/commit/a9f47ae45d6649afaef781146c9d16fea7845a7b))
* **deps:** bump the minor-and-patch group across 1 directory with 6 updates ([#79](https://github.com/niklam/iracedeck/issues/79)) ([aaa253a](https://github.com/niklam/iracedeck/commit/aaa253a0c47e18ddb220e5450e1a6aa8c2280e2f))

## [0.10.1](https://github.com/niklam/iracedeck/compare/v0.10.0...v0.10.1) (2026-03-06)

### Bug Fixes

* **stream-deck-plugin:** show default sub-options on initial PI load ([#82](https://github.com/niklam/iracedeck/issues/82)) ([8043a28](https://github.com/niklam/iracedeck/commit/8043a285b05ca4e861bc9b337bdf0bad341bb680)), closes [#81](https://github.com/niklam/iracedeck/issues/81)

## [0.10.0](https://github.com/niklam/iracedeck/compare/v0.9.2...v0.10.0) (2026-03-06)

### Features

* **stream-deck-plugin:** add Setup Traction action ([#58](https://github.com/niklam/iracedeck/issues/58)) ([e90350f](https://github.com/niklam/iracedeck/commit/e90350feff4d1ff2542650a4066c032697705581)), closes [#25](https://github.com/niklam/iracedeck/issues/25)

### Documentation

* add release workflow documentation to README ([#78](https://github.com/niklam/iracedeck/issues/78)) ([71a2599](https://github.com/niklam/iracedeck/commit/71a2599617a24e28de5861c208861918400a21ee))

### Maintenance

* **ci:** delete .github/workflows/firebase-hosting-pull-request.yml ([5a505bb](https://github.com/niklam/iracedeck/commit/5a505bb16d7c15c73daa58e40cbc45e5eb123fcd))
* **deps-dev:** bump @rollup/plugin-commonjs from 28.0.9 to 29.0.0 ([#68](https://github.com/niklam/iracedeck/issues/68)) ([6751624](https://github.com/niklam/iracedeck/commit/67516241f47d45b6207e2bc48637a89c780b6674))
* **deps-dev:** bump firebase-tools from 13.35.1 to 15.8.0 ([#70](https://github.com/niklam/iracedeck/issues/70)) ([0f20c02](https://github.com/niklam/iracedeck/commit/0f20c021908c9bf4a7b97dea700c14d35f268f66))
* **deps-dev:** bump rimraf from 5.0.10 to 6.1.3 ([#67](https://github.com/niklam/iracedeck/issues/67)) ([a507339](https://github.com/niklam/iracedeck/commit/a5073396fef8dd04f807f9b12b255cf242596015))
* **deps:** bump actions/checkout from 4 to 6 ([#65](https://github.com/niklam/iracedeck/issues/65)) ([645bb2a](https://github.com/niklam/iracedeck/commit/645bb2a430de567a1ba2db10524cbcabc4d7477e))
* **deps:** pin all dependencies to exact versions ([#80](https://github.com/niklam/iracedeck/issues/80)) ([2059fed](https://github.com/niklam/iracedeck/commit/2059fedc96fcb6eb38731a05221891797fdc90df))

## [0.9.2](https://github.com/niklam/iracedeck/compare/v0.9.1...v0.9.2) (2026-03-05)

### Documentation

* add iRaceIT inspiration section to README ([aa9a083](https://github.com/niklam/iracedeck/commit/aa9a08344dd987c536861460fed47c466c649990))
* add PR template usage guidance to rules and agents ([#74](https://github.com/niklam/iracedeck/issues/74)) ([aa44471](https://github.com/niklam/iracedeck/commit/aa4447156ea41f498942f629d11a020cada93c8a))

### CI/CD

* add GitHub Actions CI workflows for pull requests ([#72](https://github.com/niklam/iracedeck/issues/72)) ([60fb872](https://github.com/niklam/iracedeck/commit/60fb8724c1b51cc946abe749f31c7d2759e4de18))

### Maintenance

* add cross-platform release wrapper for GITHUB_TOKEN ([9b45b5b](https://github.com/niklam/iracedeck/commit/9b45b5b6f4f62e7428fa6bb3d5f4c05d43e390ed))
* add pre-commit hooks with husky and lint-staged ([#75](https://github.com/niklam/iracedeck/issues/75)) ([537fa2b](https://github.com/niklam/iracedeck/commit/537fa2bb3f70efa6293d7022921d045c7d396593))
* add release workflow with release-it ([#77](https://github.com/niklam/iracedeck/issues/77)) ([9f97002](https://github.com/niklam/iracedeck/commit/9f970022285bc7347edce7ce8381075cd37f36e0))
* anchor dist/ and build/ gitignore patterns to repo root ([#76](https://github.com/niklam/iracedeck/issues/76)) ([24f2205](https://github.com/niklam/iracedeck/commit/24f2205f7fe5f3be4a7ae0edcb1a8c1f2a4b36f0))
