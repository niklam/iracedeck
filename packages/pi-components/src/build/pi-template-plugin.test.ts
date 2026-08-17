import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { piTemplatePlugin } from "./pi-template-plugin.mjs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFunction = (...args: any[]) => any;

describe("piTemplatePlugin", () => {
  // OS temp dir, NOT the repo root — a scratch directory inside the working
  // tree flickers in and out of `git status` and races the release-hooks
  // test's clean-tree snapshot when vitest workers run in parallel.
  const testDir = mkdtempSync(path.join(os.tmpdir(), "iracedeck-pi-templates-"));
  const templatesDir = path.join(testDir, "templates");
  const partialsDir = path.join(testDir, "partials");
  const outputDir = path.join(testDir, "output");
  const dataDir = path.join(templatesDir, "data");

  beforeEach(() => {
    // Create test directories
    mkdirSync(templatesDir, { recursive: true });
    mkdirSync(partialsDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directories
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should compile a basic EJS template to HTML", async () => {
    // Create a simple template
    writeFileSync(
      path.join(templatesDir, "simple.ejs"),
      "<!DOCTYPE html><html><body><h1><%= 'Hello' %></h1></body></html>",
    );

    const plugin = piTemplatePlugin({
      templatesDir,
      outputDir,
      partialsDir,
      version: "1.0.0",
    });

    // Mock rollup context
    const context = {
      addWatchFile: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    // Run buildStart to set up watchers
    if (plugin.buildStart) {
      await (plugin.buildStart as AnyFunction).call(context);
    }

    // Run generateBundle to compile templates
    if (plugin.generateBundle) {
      await (plugin.generateBundle as AnyFunction).call(context);
    }

    // Check output
    const outputPath = path.join(outputDir, "simple.html");
    expect(existsSync(outputPath)).toBe(true);

    const content = readFileSync(outputPath, "utf-8");
    expect(content).toContain("<h1>Hello</h1>");
  });

  it("should include partials from the partials directory", async () => {
    // Create a partial
    writeFileSync(path.join(partialsDir, "header.ejs"), "<header>iRaceDeck</header>");

    // Create a template that uses the partial
    writeFileSync(
      path.join(templatesDir, "with-partial.ejs"),
      "<!DOCTYPE html><html><body><%- include('header') %></body></html>",
    );

    const plugin = piTemplatePlugin({
      templatesDir,
      outputDir,
      partialsDir,
      version: "1.0.0",
    });

    const context = {
      addWatchFile: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    if (plugin.buildStart) {
      await (plugin.buildStart as AnyFunction).call(context);
    }
    if (plugin.generateBundle) {
      await (plugin.generateBundle as AnyFunction).call(context);
    }

    const outputPath = path.join(outputDir, "with-partial.html");
    expect(existsSync(outputPath)).toBe(true);

    const content = readFileSync(outputPath, "utf-8");
    expect(content).toContain("<header>iRaceDeck</header>");
  });

  it("should support require for JSON data files", async () => {
    // Create a JSON data file
    writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ name: "Test Plugin" }));

    // Create a template that uses require
    writeFileSync(
      path.join(templatesDir, "with-data.ejs"),
      "<!DOCTYPE html><html><body><%= require('./data/config.json').name %></body></html>",
    );

    const plugin = piTemplatePlugin({
      templatesDir,
      outputDir,
      partialsDir,
      version: "1.0.0",
    });

    const context = {
      addWatchFile: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    if (plugin.buildStart) {
      await (plugin.buildStart as AnyFunction).call(context);
    }
    if (plugin.generateBundle) {
      await (plugin.generateBundle as AnyFunction).call(context);
    }

    const outputPath = path.join(outputDir, "with-data.html");
    expect(existsSync(outputPath)).toBe(true);

    const content = readFileSync(outputPath, "utf-8");
    expect(content).toContain("Test Plugin");
  });

  it("should add watch files for templates and partials", async () => {
    writeFileSync(path.join(templatesDir, "watch-test.ejs"), "<html></html>");
    writeFileSync(path.join(partialsDir, "watch-partial.ejs"), "<div></div>");
    writeFileSync(path.join(dataDir, "watch-data.json"), "{}");

    const plugin = piTemplatePlugin({
      templatesDir,
      outputDir,
      partialsDir,
      version: "1.0.0",
    });

    const context = {
      addWatchFile: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    if (plugin.buildStart) {
      await (plugin.buildStart as AnyFunction).call(context);
    }

    // Should watch the template
    expect(context.addWatchFile).toHaveBeenCalledWith(expect.stringContaining("watch-test.ejs"));
    // Should watch the partial
    expect(context.addWatchFile).toHaveBeenCalledWith(expect.stringContaining("watch-partial.ejs"));
    // Should watch the data file
    expect(context.addWatchFile).toHaveBeenCalledWith(expect.stringContaining("watch-data.json"));
  });

  it("should report error for invalid template syntax", async () => {
    // Create a template with invalid EJS syntax
    writeFileSync(
      path.join(templatesDir, "invalid.ejs"),
      "<!DOCTYPE html><html><body><%= unclosedTag</body></html>",
    );

    const plugin = piTemplatePlugin({
      templatesDir,
      outputDir,
      partialsDir,
      version: "1.0.0",
    });

    const context = {
      addWatchFile: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    if (plugin.buildStart) {
      await (plugin.buildStart as AnyFunction).call(context);
    }
    if (plugin.generateBundle) {
      await (plugin.generateBundle as AnyFunction).call(context);
    }

    // Should report an error
    expect(context.error).toHaveBeenCalledWith(expect.stringContaining("invalid.ejs"));
  });

  it("should warn when templates directory does not exist", async () => {
    const plugin = piTemplatePlugin({
      templatesDir: path.join(testDir, "nonexistent"),
      outputDir,
      partialsDir,
      version: "1.0.0",
    });

    const context = {
      addWatchFile: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    if (plugin.buildStart) {
      await (plugin.buildStart as AnyFunction).call(context);
    }
    if (plugin.generateBundle) {
      await (plugin.generateBundle as AnyFunction).call(context);
    }

    expect(context.warn).toHaveBeenCalledWith(expect.stringContaining("Templates directory not found"));
  });

  it("should flatten nested template paths to flat output", async () => {
    // Nest a template two levels deep
    const actionDir = path.join(templatesDir, "fuel-service");
    mkdirSync(actionDir, { recursive: true });
    writeFileSync(path.join(actionDir, "fuel-service.ejs"), "<html><body>Fuel</body></html>");

    const plugin = piTemplatePlugin({
      templatesDir,
      outputDir,
      partialsDir,
      version: "1.0.0",
    });

    const context = {
      addWatchFile: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    if (plugin.buildStart) {
      await (plugin.buildStart as AnyFunction).call(context);
    }
    if (plugin.generateBundle) {
      await (plugin.generateBundle as AnyFunction).call(context);
    }

    // Output is flat: `outputDir/fuel-service.html`, not `outputDir/fuel-service/fuel-service.html`
    expect(existsSync(path.join(outputDir, "fuel-service.html"))).toBe(true);
    expect(existsSync(path.join(outputDir, "fuel-service", "fuel-service.html"))).toBe(false);
  });

  it("should resolve require('./data/...') from templatesDir even for nested templates", async () => {
    // Shared data at templatesDir/data — the nested template's require must resolve here,
    // NOT relative to the template's own directory.
    writeFileSync(path.join(dataDir, "icon-defaults.json"), JSON.stringify({ "fuel-service": { color: "red" } }));

    const actionDir = path.join(templatesDir, "fuel-service");
    mkdirSync(actionDir, { recursive: true });
    writeFileSync(
      path.join(actionDir, "fuel-service.ejs"),
      "<html><body><%= require('./data/icon-defaults.json')['fuel-service'].color %></body></html>",
    );

    const plugin = piTemplatePlugin({
      templatesDir,
      outputDir,
      partialsDir,
      version: "1.0.0",
    });

    const context = {
      addWatchFile: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    if (plugin.buildStart) {
      await (plugin.buildStart as AnyFunction).call(context);
    }
    if (plugin.generateBundle) {
      await (plugin.generateBundle as AnyFunction).call(context);
    }

    const content = readFileSync(path.join(outputDir, "fuel-service.html"), "utf-8");
    expect(content).toContain("red");
    expect(context.error).not.toHaveBeenCalled();
  });

  it("should error when two templates share a basename", async () => {
    const dirA = path.join(templatesDir, "group-a");
    const dirB = path.join(templatesDir, "group-b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(path.join(dirA, "dup.ejs"), "<html>A</html>");
    writeFileSync(path.join(dirB, "dup.ejs"), "<html>B</html>");

    const plugin = piTemplatePlugin({
      templatesDir,
      outputDir,
      partialsDir,
      version: "1.0.0",
    });

    const context = {
      addWatchFile: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    if (plugin.buildStart) {
      await (plugin.buildStart as AnyFunction).call(context);
    }
    if (plugin.generateBundle) {
      await (plugin.generateBundle as AnyFunction).call(context);
    }

    expect(context.error).toHaveBeenCalledWith(expect.stringContaining("basename collision"));
  });

  it("should expose platformFeatures as locals.platform to templates", async () => {
    writeFileSync(
      path.join(templatesDir, "flags.ejs"),
      "<!DOCTYPE html><html><body>" +
        "<% if (locals.platform?.features?.dialFeedback !== false) { %>DIAL<% } %>" +
        "|<%= locals.platform?.features?.pngRasterization %>" +
        "</body></html>",
    );

    const plugin = piTemplatePlugin({
      templatesDir,
      outputDir,
      partialsDir,
      version: "1.0.0",
      platformFeatures: {
        features: { dialFeedback: false, pngRasterization: false },
      },
    });

    const context = {
      addWatchFile: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    if (plugin.buildStart) {
      await (plugin.buildStart as AnyFunction).call(context);
    }
    if (plugin.generateBundle) {
      await (plugin.generateBundle as AnyFunction).call(context);
    }

    const content = readFileSync(path.join(outputDir, "flags.html"), "utf-8");
    expect(content).not.toContain("DIAL");
    expect(content).toContain("|false");
  });

  it("should default platformFeatures to empty objects so templates without flags still render", async () => {
    writeFileSync(
      path.join(templatesDir, "no-flags.ejs"),
      "<!DOCTYPE html><html><body>" +
        "<% if (locals.platform?.features?.dialFeedback !== false) { %>DIAL<% } %>" +
        "</body></html>",
    );

    const plugin = piTemplatePlugin({
      templatesDir,
      outputDir,
      partialsDir,
      version: "1.0.0",
    });

    const context = {
      addWatchFile: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    if (plugin.buildStart) {
      await (plugin.buildStart as AnyFunction).call(context);
    }
    if (plugin.generateBundle) {
      await (plugin.generateBundle as AnyFunction).call(context);
    }

    // With default platformFeatures = { features: {} }, features.dialFeedback is
    // undefined (!== false), so DIAL is emitted — preserving backward-compatible
    // behavior for templates without platform gating.
    const content = readFileSync(path.join(outputDir, "no-flags.html"), "utf-8");
    expect(content).toContain("DIAL");
  });

  it("should pass variables to partials", async () => {
    // Create a partial that uses a variable
    writeFileSync(path.join(partialsDir, "title.ejs"), "<title><%= title %></title>");

    // Create a template that passes a variable to the partial
    writeFileSync(
      path.join(templatesDir, "with-var.ejs"),
      "<!DOCTYPE html><html><head><%- include('title', { title: 'My Page' }) %></head></html>",
    );

    const plugin = piTemplatePlugin({
      templatesDir,
      outputDir,
      partialsDir,
      version: "1.0.0",
    });

    const context = {
      addWatchFile: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    if (plugin.buildStart) {
      await (plugin.buildStart as AnyFunction).call(context);
    }
    if (plugin.generateBundle) {
      await (plugin.generateBundle as AnyFunction).call(context);
    }

    const outputPath = path.join(outputDir, "with-var.html");
    expect(existsSync(outputPath)).toBe(true);

    const content = readFileSync(outputPath, "utf-8");
    expect(content).toContain("<title>My Page</title>");
  });

  it("should expose optional include parameters through locals so partials can guard on them (#992)", async () => {
    // A partial that renders extra markup only when an optional parameter is passed.
    writeFileSync(
      path.join(partialsDir, "header.ejs"),
      "<h1><%= title %></h1><% if (locals.extra) { %><p>extra</p><% } %>",
    );

    writeFileSync(
      path.join(templatesDir, "with-extra.ejs"),
      "<!DOCTYPE html><html><body><%- include('header', { title: 'A', extra: true }) %></body></html>",
    );
    writeFileSync(
      path.join(templatesDir, "without-extra.ejs"),
      "<!DOCTYPE html><html><body><%- include('header', { title: 'B' }) %></body></html>",
    );

    const plugin = piTemplatePlugin({
      templatesDir,
      outputDir,
      partialsDir,
      version: "1.0.0",
    });

    const context = {
      addWatchFile: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    if (plugin.buildStart) {
      await (plugin.buildStart as AnyFunction).call(context);
    }
    if (plugin.generateBundle) {
      await (plugin.generateBundle as AnyFunction).call(context);
    }

    expect(context.error).not.toHaveBeenCalled();
    expect(readFileSync(path.join(outputDir, "with-extra.html"), "utf-8")).toContain("<p>extra</p>");
    expect(readFileSync(path.join(outputDir, "without-extra.html"), "utf-8")).not.toContain("<p>extra</p>");
  });
});
