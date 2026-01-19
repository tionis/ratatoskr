import * as esbuild from "esbuild";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = join(__dirname, "..", "src", "ui", "lib");

// Ensure output directory exists
mkdirSync(outdir, { recursive: true });

// Build the bundle
await esbuild.build({
  entryPoints: [join(__dirname, "src", "index.ts")],
  bundle: true,
  format: "esm",
  // Use 'neutral' platform to avoid the 'browser' condition in package exports
  // The 'browser' condition for @automerge/automerge uses a bundler entry point
  // that requires proper WASM loader support which esbuild doesn't provide.
  // With 'neutral', we get the default entry point which uses base64-encoded WASM.
  platform: "neutral",
  mainFields: ["browser", "module", "main"],
  target: ["es2022"],
  outfile: join(outdir, "ratatoskr-client.js"),
  minify: true,
  sourcemap: false,
});

console.log("Browser bundle built successfully!");
console.log(`Output: ${outdir}`);
