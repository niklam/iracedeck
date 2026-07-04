import { readFileSync } from "fs";
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";

// Fallback: read version from root package.json if env var not set
if (!process.env.PUBLIC_IRACEDECK_VERSION) {
  const rootPkg = JSON.parse(readFileSync("../../package.json", "utf-8"));
  process.env.PUBLIC_IRACEDECK_VERSION = rootPkg.version;
}

export default defineConfig({
  site: "https://iracedeck.com",
  integrations: [
    // Must come BEFORE starlight so its rehype plugin transforms ```mermaid
    // code fences into rendered diagrams ahead of Expressive Code.
    //
    // Known, non-fatal startup warnings: astro-mermaid 2.1.0 (the latest release)
    // lags Astro 6's reworked markdown API, so it logs "isUnifiedProcessor is not
    // a function" and falls back to the deprecated `markdown.rehypePlugins` array,
    // which in turn makes Astro print its own deprecation notice. Diagrams still
    // transform and render correctly in dev and build. Revisit (and drop this note)
    // when astro-mermaid ships Astro 6 support.
    mermaid({
      theme: "default",
      autoTheme: true,
      mermaidConfig: { flowchart: { curve: "basis" } },
    }),
    starlight({
      title: "iRaceDeck",
      logo: {
        dark: "./src/assets/logo-dark.png",
        light: "./src/assets/logo-light.png",
        replacesTitle: true,
      },
      customCss: ["./src/styles/custom.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/niklam/iracedeck",
        },
        {
          icon: "discord",
          label: "Discord",
          href: "https://discord.gg/c6nRYywpah",
        },
        {
          icon: "reddit",
          label: "Reddit",
          href: "https://www.reddit.com/r/iRaceDeck/",
        },
      ],
      favicon: "/favicon.svg",
      head: [
        {
          tag: "script",
          attrs: {
            async: true,
            src: "https://www.googletagmanager.com/gtag/js?id=G-HKB3F7KB00",
          },
        },
        {
          tag: "script",
          content:
            "window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','G-HKB3F7KB00');",
        },
        {
          tag: "link",
          attrs: {
            rel: "icon",
            type: "image/x-icon",
            href: "/favicon.ico",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "icon",
            type: "image/png",
            sizes: "96x96",
            href: "/favicon-96x96.png",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "apple-touch-icon",
            sizes: "180x180",
            href: "/apple-touch-icon.png",
          },
        },
        {
          tag: "link",
          attrs: { rel: "manifest", href: "/site.webmanifest" },
        },
        {
          tag: "script",
          attrs: { src: "/diagram-zoom.js", defer: true },
        },
      ],
      sidebar: [
        { label: "Downloads", link: "/downloads/" },
        { label: "Changelog", link: "/changelog/" },
        { label: "Home", link: "/docs/" },
        {
          label: "Getting Started",
          items: [
            { slug: "docs/getting-started/installation" },
            { slug: "docs/getting-started/troubleshooting" },
          ],
        },
        {
          label: "Features",
          items: [
            { slug: "docs/features/communication-methods" },
            { slug: "docs/features/key-bindings" },
            { slug: "docs/features/dials" },
            { slug: "docs/features/flags-overlay" },
            { slug: "docs/features/focus-iracing-window" },
            { slug: "docs/features/icon-colors" },
            { slug: "docs/features/title-customization" },
            { slug: "docs/features/graphic-scaling" },
            { slug: "docs/features/border-indicator" },
            { slug: "docs/features/template-variables" },
          ],
        },
        {
          label: "Actions",
          items: [
            { slug: "docs/actions/overview" },
            {
              label: "Audio & Voice",
              items: [
                { slug: "docs/actions/audio-voice/ai-spotter-controls" },
                { slug: "docs/actions/audio-voice/audio-controls" },
                { slug: "docs/actions/audio-voice/pit-crew" },
              ],
            },
            {
              label: "Display & Session",
              items: [
                { slug: "docs/actions/display-session/session-info" },
                { slug: "docs/actions/display-session/telemetry-display" },
              ],
            },
            {
              label: "Driving Controls",
              items: [
                { slug: "docs/actions/driving/black-box-selector" },
                { slug: "docs/actions/driving/look-direction" },
                { slug: "docs/actions/driving/car-control" },
              ],
            },
            {
              label: "Cockpit & Interface",
              items: [
                { slug: "docs/actions/cockpit/cockpit-misc" },
                { slug: "docs/actions/cockpit/force-feedback" },
                { slug: "docs/actions/cockpit/splits-delta-cycle" },
                { slug: "docs/actions/cockpit/telemetry-control" },
                { slug: "docs/actions/cockpit/toggle-ui-elements" },
              ],
            },
            {
              label: "View & Camera",
              items: [
                { slug: "docs/actions/view-camera/view-adjustment" },
                { slug: "docs/actions/view-camera/replay-control" },
                { slug: "docs/actions/view-camera/camera-focus" },
                { slug: "docs/actions/view-camera/camera-editor-controls" },
                { slug: "docs/actions/view-camera/camera-editor-adjustments" },
              ],
            },
            {
              label: "Media",
              items: [{ slug: "docs/actions/media/media-capture" }],
            },
            {
              label: "Pit Service",
              items: [
                { slug: "docs/actions/pit-service/pit-quick-actions" },
                { slug: "docs/actions/pit-service/fuel-service" },
                { slug: "docs/actions/pit-service/tire-service" },
              ],
            },
            {
              label: "Car Setup",
              items: [
                { slug: "docs/actions/car-setup/setup-aero" },
                { slug: "docs/actions/car-setup/setup-brakes" },
                { slug: "docs/actions/car-setup/setup-brakes-dial" },
                { slug: "docs/actions/car-setup/setup-chassis" },
                { slug: "docs/actions/car-setup/setup-engine" },
                { slug: "docs/actions/car-setup/setup-fuel" },
                { slug: "docs/actions/car-setup/setup-hybrid" },
                { slug: "docs/actions/car-setup/setup-traction" },
              ],
            },
            {
              label: "Communication",
              items: [
                { slug: "docs/actions/communication/chat" },
                { slug: "docs/actions/communication/race-admin" },
              ],
            },
          ],
        },
        {
          label: "Reference",
          items: [
            { slug: "docs/reference/action-types" },
            { slug: "docs/reference/keyboard-shortcuts" },
          ],
        },
        {
          label: "Development",
          items: [
            { slug: "docs/development" },
            { slug: "docs/development/tech-stack" },
            { slug: "docs/development/architecture" },
            { slug: "docs/development/contributing" },
            { slug: "docs/development/setup" },
            { slug: "docs/development/feature-flags" },
          ],
        },
        {
          label: "Links",
          items: [
            {
              label: "Elgato Marketplace",
              link: "https://marketplace.elgato.com/product/iracedeck-042a0efb-58aa-428c-b1de-8b6169edd21d",
              attrs: { target: "_blank", rel: "noopener noreferrer" },
            },
            {
              label: "Mirabox Space",
              link: "https://space.key123.vip/product?id=20260322000598",
              attrs: { target: "_blank", rel: "noopener noreferrer" },
            },
            {
              label: "GitHub",
              link: "https://github.com/niklam/iracedeck",
              attrs: { target: "_blank", rel: "noopener noreferrer" },
            },
            {
              label: "Discord",
              link: "https://discord.gg/c6nRYywpah",
              attrs: { target: "_blank", rel: "noopener noreferrer" },
            },
            {
              label: "Reddit",
              link: "https://www.reddit.com/r/iRaceDeck/",
              attrs: { target: "_blank", rel: "noopener noreferrer" },
            },
          ],
        },
      ],
    }),
  ],
});
