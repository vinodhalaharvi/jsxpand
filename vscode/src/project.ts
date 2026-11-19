// Finding what to learn from in a workspace: the source folder, and how the project writes
// imports from its own tree ("@/*" → "./src/*").
import ts from "typescript";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { learn } from "../../src/learn.mjs";

export type Alias = { prefix: string; target: string } | null;

/** compilerOptions.paths of a tsconfig, following "extends" and "references" (Vite splits them). */
function pathsOf(file: string, seen = new Set<string>()): { paths: Record<string, string[]>; base: string } | null {
  if (seen.has(file) || !existsSync(file)) return null;
  seen.add(file);
  const read = ts.readConfigFile(file, ts.sys.readFile);
  if (read.error || !read.config) return null;
  const c = read.config;
  const dir = dirname(file);
  if (c.compilerOptions?.paths) return { paths: c.compilerOptions.paths, base: resolve(dir, c.compilerOptions.baseUrl ?? ".") };
  if (typeof c.extends === "string" && c.extends.startsWith(".")) {
    const p = pathsOf(resolve(dir, c.extends.endsWith(".json") ? c.extends : c.extends + ".json"), seen);
    if (p) return p;
  }
  for (const r of c.references ?? []) {
    const p0 = resolve(dir, r.path);
    const p = pathsOf(p0.endsWith(".json") ? p0 : join(p0, "tsconfig.json"), seen);
    if (p) return p;
  }
  return null;
}

/** The project's alias for its own tree, if it has one of the form "X/*": ["dir/*"]. */
export function detectAlias(root: string): Alias {
  const p = pathsOf(join(root, "tsconfig.json")) ?? pathsOf(join(root, "jsconfig.json"));
  if (!p) return null;
  for (const [k, vs] of Object.entries(p.paths)) {
    const v = vs[0];
    if (k.endsWith("/*") && v?.endsWith("/*")) return { prefix: k.slice(0, -1), target: resolve(p.base, v.slice(0, -2)) };
  }
  return null;
}

/** The folder to learn from: src/ when there is one, else the whole workspace (a Next.js app keeps app/, components/ and more at the top). */
export function sourceDir(root: string): string {
  return existsSync(join(root, "src")) ? join(root, "src") : root;
}

/** The model the extension works from: learned from the workspace and what it has installed, nothing else. */
export function modelFor(root: string, src?: string): Record<string, unknown> {
  const alias = detectAlias(root);
  const cfg = projectConfig(root);
  return learn(src ?? sourceDir(root), { root, alias, compilerOptions: cfg.options, declarations: cfg.declarations });
}

/** The project's compiler options, from its tsconfig (following a Vite-style reference to the app config). */
export function compilerOptions(root: string): ts.CompilerOptions {
  return projectConfig(root).options;
}

/** The project's compiler options and its own declaration files (types/next-auth.d.ts and the like). */
export function projectConfig(root: string): { options: ts.CompilerOptions; declarations: string[] } {
  const tryFile = (f: string): { options: ts.CompilerOptions; declarations: string[] } | null => {
    if (!existsSync(f)) return null;
    const read = ts.readConfigFile(f, ts.sys.readFile);
    if (read.error) return null;
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(f));
    if (parsed.options.jsx !== undefined) return { options: parsed.options, declarations: parsed.fileNames.filter((n) => n.endsWith(".d.ts")) };
    for (const r of read.config.references ?? []) {
      const p = resolve(dirname(f), r.path);
      const o = tryFile(p.endsWith(".json") ? p : join(p, "tsconfig.json"));
      if (o) return o;
    }
    return null;
  };
  return (
    tryFile(join(root, "tsconfig.json")) ?? {
      options: { jsx: ts.JsxEmit.ReactJSX, strict: true, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      declarations: [],
    }
  );
}
