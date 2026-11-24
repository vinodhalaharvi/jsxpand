// Runs the bundled extension (dist/) against a stand-in for the vscode API: activates it on a
// workspace, waits for it to learn, asks for completions at spots in real files, applies the
// chosen item the way VS Code does, and type-checks what comes out.
// usage: node test/smoke.cjs <workspace>
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const ts = require("typescript");

const root = path.resolve(process.argv[2]);
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "jsxpand-"));

// ---- a small vscode -------------------------------------------------------------------------
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(a, b) { this.start = a; this.end = b; } }
class Doc {
  constructor(file, text) { this.uri = { fsPath: file }; this.text = text; this.languageId = "typescriptreact"; }
  getText(r) { return r ? this.text.slice(this.offsetAt(r.start), this.offsetAt(r.end)) : this.text; }
  offsetAt(p) { const ls = this.text.split("\n"); let o = 0; for (let i = 0; i < p.line; i++) o += ls[i].length + 1; return o + p.character; }
  lineAt(l) { return { text: this.text.split("\n")[l] }; }
  getWordRangeAtPosition(p, re) { const line = this.text.split("\n")[p.line]; const g = new RegExp(re.source, "g"); let m; while ((m = g.exec(line))) if (m.index <= p.character && p.character <= m.index + m[0].length) return new Range(new Position(p.line, m.index), new Position(p.line, m.index + m[0].length)); return undefined; }
  positionAt(o) { const before = this.text.slice(0, o).split("\n"); return new Position(before.length - 1, before[before.length - 1].length); }
}
let provider = null;
let hover = null;
let triggers = [];
const status = { text: "", show() {}, hide() {}, dispose() {} };
const vscode = {
  Position, Range,
  Uri: { joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p) }) },
  StatusBarAlignment: { Right: 2 },
  CompletionItemKind: { Snippet: 27 },
  CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1 },
  Hover: class { constructor(contents, range) { this.contents = contents; this.range = range; } },
  CompletionItem: class { constructor(label, kind) { this.label = label; this.kind = kind; } },
  CompletionList: class { constructor(items, inc) { this.items = items; this.isIncomplete = inc; } },
  MarkdownString: class { constructor(v = "") { this.value = v; } appendCodeblock(c, l) { this.value += "```" + l + "\n" + c + "\n```"; } appendMarkdown(m) { this.value += m; } },
  TextEdit: { replace: (range, newText) => ({ range, newText }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: root } }],
    getConfiguration: () => ({ get: () => undefined }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    fs: {
      createDirectory: async (u) => fs.mkdirSync(u.fsPath, { recursive: true }),
      writeFile: async (u, b) => fs.writeFileSync(u.fsPath, b),
      readFile: async (u) => fs.readFileSync(u.fsPath),
    },
  },
  window: {
    createOutputChannel: () => ({ appendLine: (s) => console.log("  [out]", s), dispose() {} }),
    createStatusBarItem: () => status,
  },
  commands: { registerCommand: () => ({ dispose() {} }) },
  languages: {
    registerCompletionItemProvider: (sel, p, ...t) => { provider = p; triggers = t; return { dispose() {} }; },
    registerHoverProvider: (sel, h) => { hover = h; return { dispose() {} }; },
  },
};
const load = Module._load;
Module._load = function (req, ...rest) { return req === "vscode" ? vscode : load.call(this, req, ...rest); };

// ---- run --------------------------------------------------------------------------------------
(async () => {
  const extDir = process.env.EXT ?? path.join(__dirname, "..");
  const ext = require(path.join(extDir, "dist", "extension.js"));
  const subs = [];
  ext.activate({ extensionPath: extDir, storageUri: { fsPath: storage }, subscriptions: subs });
  const t0 = Date.now();
  while (!/components/.test(status.text)) {
    if (Date.now() - t0 > 120_000) throw new Error("never finished learning: " + status.text);
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log("status:", status.text, "| triggers:", triggers.join(" "));
  if (!fs.existsSync(path.join(storage, "model-v1.json"))) throw new Error("model was not cached");
  // the bundle must read types as well as the unbundled learner does (its TypeScript needs its lib files)
  const model = JSON.parse(fs.readFileSync(path.join(storage, "model-v1.json"), "utf8"));
  const withModule = Object.values(model.comps).filter((c) => c.module && c.count >= 1 && !c.module.startsWith("@/components/ui/"));
  const typedShare = withModule.filter((c) => c.typed).length / Math.max(1, withModule.length);
  console.log(`types read for ${Math.round(typedShare * 100)}% of the project's imported components`);
  console.log("types:", JSON.stringify(model.types));
  if (fs.existsSync(path.join(root, "node_modules")) && (typedShare < 0.5 || !model.types?.lib)) throw new Error("types were not read in full: is TypeScript's lib missing from dist/?");

  const cases = path.basename(root) === "taxonomy" ? [
    ["app/(dashboard)/dashboard/page.tsx", "<DashboardShell>", "cardhdrttlcont"],
    ["app/(dashboard)/dashboard/page.tsx", "<DashboardShell>", "ddmtrigbtncontitm*3"],
    ["app/(dashboard)/dashboard/page.tsx", "<DashboardShell>", "frm>eml+btn"],
    ["components/new.tsx", "", "dlg>cont>hdr+ftr>btn"],
  ] : [
    ["src/features/dashboard/index.tsx", "<Main>", "cardhdrttlcont"],
    ["src/features/dashboard/index.tsx", "<Main>", "tabs>list>trig*3^cont"],
    ["src/features/users/components/data-table-row-actions.tsx", "<>", "frm>usr+eml+btn"],
    ["src/features/users/components/data-table-row-actions.tsx", "<>", "sel>trig^cont>itm*3"],
    ["src/features/dashboard/components/new.tsx", "", "cardhdrttlcont"],
  ];
  const written = [];
  let n = 0;
  // what goes here: "<" typed on a new line after a marker, the first item expected, and the file
  // after taking it must type-check
  const nextCases = path.basename(root) === "shadcn-admin" ? [
    ["src/features/dashboard/index.tsx", "<Card>", "CardHeader"],
    ["src/features/dashboard/index.tsx", "</CardHeader>", "CardContent"],
  ] : [];
  for (const [file, after, want] of nextCases) {
    const abs = path.join(root, file);
    const orig = fs.readFileSync(abs, "utf8");
    const pos = orig.indexOf(after) + after.length;
    const text = orig.slice(0, pos) + "\n                <" + orig.slice(pos);
    const target = abs.replace(/\.tsx$/, `.smoke-${n++}.tsx`);
    const doc = new Doc(target, text);
    const at = pos + "\n                <".length;
    const list = await provider.provideCompletionItems(doc, doc.positionAt(at), null, { triggerKind: 1, triggerCharacter: "<" });
    const it = list?.items?.[0];
    if (!it || it.label.label !== want) throw new Error(`after ${after}: wanted ${want} first, got ${it ? it.label.label : "nothing"}`);
    const edits = [{ range: it.range, newText: it.insertText }, ...it.additionalTextEdits]
      .map((e, i) => ({ s: doc.offsetAt(e.range.start), e: doc.offsetAt(e.range.end), t: e.newText, i }))
      .sort((a, b) => b.s - a.s || b.i - a.i);
    let out = text;
    for (const e of edits) out = out.slice(0, e.s) + e.t + out.slice(e.e);
    if (out.includes("<<")) throw new Error("the typed < was left in");
    fs.writeFileSync(target, out);
    written.push(target);
    console.log(`next after ${after.padEnd(14)} ${list.items.map((i) => i.label.label + " " + i.label.description).join(", ")}`);
  }
  // hover: what goes inside a Card
  if (path.basename(root) === "shadcn-admin") {
    const abs = path.join(root, "src/features/dashboard/index.tsx");
    const text = fs.readFileSync(abs, "utf8");
    const doc = new Doc(abs, text);
    const h = await hover.provideHover(doc, doc.positionAt(text.indexOf("<Card>") + 2));
    if (!h || !/CardHeader|Header/.test(h.contents.value)) throw new Error("no map on hovering Card: " + JSON.stringify(h));
    console.log("hover Card:\n" + h.contents.value.split("\n").filter((l) => !l.startsWith("```")).map((l) => "  " + l).join("\n"));
  }
  for (const [file, after, abbrev] of cases) {
    const abs = path.join(root, file);
    const orig = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    const pos = after ? orig.indexOf(after) + after.length : 0;
    const pad = after ? "\n        " : "";
    const text = orig.slice(0, pos) + pad + abbrev + orig.slice(pos);
    const target = abs.replace(/\.tsx$/, `.smoke-${n++}.tsx`);
    const doc = new Doc(target, text);
    const t = Date.now();
    const list = await provider.provideCompletionItems(doc, doc.positionAt(pos + pad.length + abbrev.length));
    const ms = Date.now() - t;
    if (!list.items.length) throw new Error("no completions for " + abbrev);
    const it = list.items[0];
    // VS Code: the item's text over its range, its additional edits elsewhere, all against the original
    const edits = [{ range: it.range, newText: it.insertText }, ...it.additionalTextEdits]
      .map((e, i) => ({ s: doc.offsetAt(e.range.start), e: doc.offsetAt(e.range.end), t: e.newText, i }))
      .sort((a, b) => b.s - a.s || b.i - a.i);
    for (let i = 1; i < edits.length; i++) if (edits[i].e > edits[i - 1].s) throw new Error("overlapping edits for " + abbrev);
    let out = text;
    for (const e of edits) out = out.slice(0, e.s) + e.t + out.slice(e.e);
    fs.writeFileSync(target, out);
    written.push(target);
    console.log(`${abbrev.padEnd(24)} ${list.items.length} items · ${it.label.detail.trim()} · ${it.label.description} · ${ms} ms`);
  }
  // the project's own tsconfig (following a Vite-style reference) and its own .d.ts files
  const cfgOf = (f) => {
    if (!fs.existsSync(f)) return null;
    const read = ts.readConfigFile(f, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(f));
    if (parsed.options.jsx !== undefined) return parsed;
    for (const r of read.config.references ?? []) { const p = path.resolve(path.dirname(f), r.path); const c = cfgOf(p.endsWith(".json") ? p : path.join(p, "tsconfig.json")); if (c) return c; }
    return null;
  };
  const cfg = cfgOf(path.join(root, "tsconfig.json"));
  const program = ts.createProgram([...written, ...cfg.fileNames.filter((n) => n.endsWith(".d.ts"))], { ...cfg.options, noEmit: true, incremental: false, tsBuildInfoFile: undefined });
  const diags = ts.getPreEmitDiagnostics(program).filter((d) => d.file && written.includes(d.file.fileName));
  for (const d of diags) console.log("  ✗", path.basename(d.file.fileName), ts.flattenDiagnosticMessageText(d.messageText, " "));
  if (!process.env.KEEP) for (const f of written) fs.rmSync(f);
  for (const s of subs) s.dispose?.();
  console.log(diags.length ? `FAILED: ${diags.length} type errors` : `ok: ${written.length} files type-check`);
  process.exit(diags.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
