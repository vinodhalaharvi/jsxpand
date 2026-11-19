// Bundles the extension and its worker. The worker carries TypeScript (the learner reads code with it).
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { makePrior } from "../src/prior.mjs";

// (import.meta is empty in a CommonJS bundle: that is what keeps learn.mjs's command-line block off)
const common = { bundle: true, platform: "node", format: "cjs", target: "node20", minify: true, sourcemap: false, logLevel: "warning", logOverride: { "empty-import-meta": "silent" } };
await build({ ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", external: ["vscode"] });
await build({ ...common, entryPoints: ["src/worker.ts"], outfile: "dist/worker.js" });

// the prior: shadcn/ui patterns from the sample files and from shadcn-admin (MIT, © 2024 Sat Naing)
mkdirSync("dist", { recursive: true });
const models = ["../src/model.json", "../src/model-admin.json"].map((f) => JSON.parse(readFileSync(f, "utf8")));
writeFileSync("dist/prior.json", JSON.stringify(makePrior(models)));

// TypeScript looks for its standard library (lib.es2022.d.ts: Omit, Partial, the DOM) beside the file
// it runs from: in the bundle, that is dist/. Without them every type built from them reads as any.
const tsLib = dirname(createRequire(import.meta.url).resolve("typescript/lib/typescript.js"));
let n = 0;
for (const f of readdirSync(tsLib)) if (/^lib\..*\.d\.ts$/.test(f) || f === "lib.d.ts") { copyFileSync(join(tsLib, f), join("dist", f)); n++; }
console.log(`copied ${n} TypeScript library files`);
