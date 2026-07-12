/**
 * Rollup Plugin for EJS-based Property Inspector Templates
 *
 * Compiles .ejs templates to static HTML at build time.
 * Supports partials from a shared directory for reusable components.
 *
 * @example
 * // In rollup.config.mjs
 * import { piTemplatePlugin } from "./src/build/pi-template-plugin.mjs";
 *
 * plugins: [
 *   piTemplatePlugin({
 *     templatesDir: "src/pi",
 *     outputDir: "com.iracedeck.sd.core.sdPlugin/ui",
 *     partialsDir: "src/pi-templates/partials",
 *   }),
 * ]
 */
import ejs from "ejs";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Recursively find all .ejs files in a directory
 */
function findEjsFiles(dir) {
  const results = [];

  if (!existsSync(dir)) {
    return results;
  }

  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip 'data' directories - they contain JSON, not templates
      if (entry.name !== "data") {
        results.push(...findEjsFiles(fullPath));
      }
    } else if (entry.name.endsWith(".ejs")) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Load JSON data files from a directory
 * Returns an object with filename (without extension) as key
 */
function loadDataFiles(dataDir) {
  const data = {};

  if (!existsSync(dataDir)) {
    return data;
  }

  const files = readdirSync(dataDir).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const key = path.basename(file, ".json");
    const content = readFileSync(path.join(dataDir, file), "utf-8");
    data[key] = JSON.parse(content);
  }

  return data;
}

/**
 * Create a custom require function for use in EJS templates.
 * Paths are resolved relative to the templates root (where the shared `data/`
 * directory lives), so templates can live in nested per-action folders and
 * still reach shared JSON via `require('./data/key-bindings.json')`.
 */
function createTemplateRequire(templatesDir) {
  return (modulePath) => {
    const fullPath = path.resolve(templatesDir, modulePath);

    if (!existsSync(fullPath)) {
      throw new Error(`Template require: file not found: ${fullPath}`);
    }

    const content = readFileSync(fullPath, "utf-8");

    if (fullPath.endsWith(".json")) {
      return JSON.parse(content);
    }

    throw new Error(`Template require: unsupported file type: ${fullPath}`);
  };
}

/**
 * Rollup plugin for compiling EJS Property Inspector templates
 */
export function piTemplatePlugin(options) {
  const {
    templatesDir,
    outputDir,
    partialsDir,
    additionalPartialsDirs = [],
    version,
    platformFeatures = { features: {} },
  } = options;

  if (!version) {
    throw new Error("piTemplatePlugin: version option is required");
  }

  // Build list of partial search directories
  const partialSearchDirs = [partialsDir, ...additionalPartialsDirs].filter((d) => existsSync(d));

  return {
    name: "pi-template-plugin",

    buildStart() {
      // Watch template files for changes
      if (existsSync(templatesDir)) {
        const ejsFiles = findEjsFiles(templatesDir);
        for (const file of ejsFiles) {
          this.addWatchFile(file);
        }

        // Watch data directory if it exists
        const dataDir = path.join(templatesDir, "data");
        if (existsSync(dataDir)) {
          const dataFiles = readdirSync(dataDir).filter((f) => f.endsWith(".json"));
          for (const file of dataFiles) {
            this.addWatchFile(path.join(dataDir, file));
          }
        }
      }

      // Watch shared partials for changes
      for (const searchDir of partialSearchDirs) {
        if (existsSync(searchDir)) {
          const partialFiles = readdirSync(searchDir).filter((f) => f.endsWith(".ejs"));
          for (const file of partialFiles) {
            this.addWatchFile(path.join(searchDir, file));
          }
        }
      }
    },

    generateBundle() {
      if (!existsSync(templatesDir)) {
        this.warn(`Templates directory not found: ${templatesDir}`);
        return;
      }

      // Ensure output directory exists
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      // Find all .ejs template files
      const ejsFiles = findEjsFiles(templatesDir);

      // Load data files
      const dataDir = path.join(templatesDir, "data");
      const dataFiles = loadDataFiles(dataDir);

      // Guard against two templates compiling to the same `ui/<name>.html`.
      const seenBasenames = new Map();
      for (const templatePath of ejsFiles) {
        const basename = path.basename(templatePath, ".ejs");
        const previous = seenBasenames.get(basename);
        if (previous) {
          this.error(
            `pi-template-plugin: basename collision for "${basename}.ejs" — ` +
              `${path.relative(templatesDir, previous)} vs ${path.relative(templatesDir, templatePath)}`,
          );
          return;
        }
        seenBasenames.set(basename, templatePath);
      }

      for (const templatePath of ejsFiles) {
        const templateName = path.basename(templatePath, ".ejs");
        const relativePath = path.relative(templatesDir, templatePath);
        // Flatten nested template paths: every template compiles to `{outputDir}/{name}.html`
        // regardless of its source-tree location (templates live in per-action subfolders).
        const outputPath = path.join(outputDir, `${templateName}.html`);

        try {
          const templateContent = readFileSync(templatePath, "utf-8");
          const templateDir = path.dirname(templatePath);
          const docsUrl = dataFiles["docs-urls"]?.[templateName] || "";

          // Compile the template
          const html = ejs.render(templateContent, {
            // Make data files available as 'data' object
            data: dataFiles,
            // Plugin version from package.json
            version: version,
            // Documentation URL for this action (empty string if not mapped)
            docsUrl,
            // Platform feature flags for this plugin build
            platform: platformFeatures,
            // Also expose a require function for inline requires (resolved from templatesDir)
            require: createTemplateRequire(templatesDir),
            // Expose locals for checking if variables are defined
            locals: {
              data: dataFiles,
              version: version,
              docsUrl,
              platform: platformFeatures,
            },
          }, {
            // Search directories for includes
            views: [templateDir, ...partialSearchDirs],
            // Enable async for potential future use
            async: false,
            // Filename for better error messages
            filename: templatePath,
          });

          // Write the compiled HTML
          writeFileSync(outputPath, html, "utf-8");

          this.info?.(`Compiled: ${relativePath} → ${path.relative(process.cwd(), outputPath)}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.error(`Failed to compile ${relativePath}: ${message}`);
        }
      }
    },
  };
}
