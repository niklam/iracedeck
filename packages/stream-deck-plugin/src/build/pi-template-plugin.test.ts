import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { piTemplatePlugin } from "./pi-template-plugin.mjs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFunction = (...args: any[]) => any;

describe("piTemplatePlugin", () => {
  const testDir = path.join(process.cwd(), "test-pi-templates");
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
});
