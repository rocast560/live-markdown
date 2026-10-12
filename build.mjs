// Bundles the extension host code and the webview, and copies the lazily
// loaded renderers (MathJax, mermaid) into media/.
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

mkdirSync("media/mathjax", { recursive: true });
cpSync("node_modules/mathjax/es5/tex-svg-full.js", "media/mathjax/tex-svg-full.js");
cpSync("node_modules/mermaid/dist/mermaid.min.js", "media/mermaid.min.js");

if (production) for (const f of ["media/webview.js.map", "media/webview.css.map", "dist/extension.js.map"]) rmSync(f, { force: true });

const common = { bundle: true, minify: production, sourcemap: !production, logLevel: "info" };
const builds = [
  { ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", platform: "node", format: "cjs", target: "node20", external: ["vscode"] },
  { ...common, entryPoints: ["webview/main.ts"], outfile: "media/webview.js", platform: "browser", format: "iife", target: "chrome120" },
];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
