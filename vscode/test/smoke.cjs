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
// files a failed run left behind would be learned from: clear them first
const stale = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { if (f.name === "node_modules" || f.name.startsWith(".")) continue; const p = path.join(d, f.name); if (f.isDirectory()) stale(p); else if (/\.smoke-\d+\.tsx$/.test(f.name)) fs.rmSync(p); } };
stale(root);
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
let inline = null;
const commands = {};
const settings = {};
let applied = null;
let triggers = [];
const status = { text: "", show() {}, hide() {}, dispose() {} };
const vscode = {
  Position, Range,
  Uri: { joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p) }) },
  StatusBarAlignment: { Right: 2 },
  CompletionItemKind: { Snippet: 27 },
  CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1 },
  InlineCompletionItem: class { constructor(insertText, range) { this.insertText = insertText; this.range = range; } },
  WorkspaceEdit: class { constructor() { this.edits = []; } replace(uri, range, newText) { this.edits.push({ range, newText }); } },
  Hover: class { constructor(contents, range) { this.contents = contents; this.range = range; } },
  CompletionItem: class { constructor(label, kind) { this.label = label; this.kind = kind; } },
  CompletionList: class { constructor(items, inc) { this.items = items; this.isIncomplete = inc; } },
  MarkdownString: class { constructor(v = "") { this.value = v; } appendCodeblock(c, l) { this.value += "```" + l + "\n" + c + "\n```"; } appendMarkdown(m) { this.value += m; } },
  TextEdit: { replace: (range, newText) => ({ range, newText }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: root } }],
    getConfiguration: () => ({ get: (k) => settings[k] }),
    openTextDocument: async (uri) => applied.doc,
    applyEdit: async (we) => { applied.edits.push(...we.edits); return true; },
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
  commands: { registerCommand: (name, fn) => { commands[name] = fn; return { dispose() {} }; } },
  languages: {
    registerCompletionItemProvider: (sel, p, ...t) => { provider = p; triggers = t; return { dispose() {} }; },
    registerHoverProvider: (sel, h) => { hover = h; return { dispose() {} }; },
    registerInlineCompletionItemProvider: (sel, p) => { inline = p; return { dispose() {} }; },
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
  // grey text on an empty line: the first one, and the imports it needs once taken
  if (path.basename(root) === "shadcn-admin") {
    const abs = path.join(root, "src/features/dashboard/index.tsx");
    const orig = fs.readFileSync(abs, "utf8");
    const pos = orig.indexOf("<Card>") + "<Card>".length;
    const text = orig.slice(0, pos) + "\n                " + orig.slice(pos);
    const target = abs.replace(/\.tsx$/, `.smoke-${n++}.tsx`);
    const doc = new Doc(target, text);
    const at = pos + "\n                ".length;
    const got = await inline.provideInlineCompletionItems(doc, doc.positionAt(at));
    const g = got?.[0];
    if (!g || !g.insertText.startsWith("<CardHeader")) throw new Error("no grey CardHeader on an empty line in a Card: " + JSON.stringify(g?.insertText));
    // take it the way VS Code does: the text over its range, then its command
    let out = text.slice(0, doc.offsetAt(g.range.start)) + g.insertText + text.slice(doc.offsetAt(g.range.end));
    if (g.command) {
      const after = new Doc(target, out);
      applied = { doc: after, edits: [] };
      await commands[g.command.command](...g.command.arguments);
      for (const e of applied.edits.map((e) => ({ s: after.offsetAt(e.range.start), e: after.offsetAt(e.range.end), t: e.newText })).sort((a, b) => b.s - a.s)) out = out.slice(0, e.s) + e.t + out.slice(e.e);
    }
    fs.writeFileSync(target, out);
    written.push(target);
    console.log("grey on an empty line in Card:", g.insertText.split("\n")[0], g.command ? "(+ imports)" : "");
    // in a file that does not import it yet: the import comes with it
    {
      const fresh = "import { Card } from '@/components/ui/card'\n\nexport function Fresh() {\n  return (\n    <Card>\n      \n    </Card>\n  )\n}\n";
      const t2 = abs.replace(/\.tsx$/, `.smoke-${n++}.tsx`);
      const d2 = new Doc(t2, fresh);
      const at2 = fresh.indexOf("<Card>") + "<Card>\n      ".length;
      const g2 = (await inline.provideInlineCompletionItems(d2, d2.positionAt(at2)))?.[0];
      if (!g2?.command) throw new Error("no import with the grey CardHeader in a fresh file");
      let o2 = fresh.slice(0, d2.offsetAt(g2.range.start)) + g2.insertText + fresh.slice(d2.offsetAt(g2.range.end));
      const after2 = new Doc(t2, o2);
      applied = { doc: after2, edits: [] };
      await commands[g2.command.command](...g2.command.arguments);
      for (const e of applied.edits.map((e) => ({ s: after2.offsetAt(e.range.start), e: after2.offsetAt(e.range.end), t: e.newText })).sort((a, b) => b.s - a.s)) o2 = o2.slice(0, e.s) + e.t + o2.slice(e.e);
      if (!/import \{[^}]*CardHeader[^}]*\} from '@\/components\/ui\/card'/.test(o2)) throw new Error("CardHeader was not imported:\n" + o2);
      fs.writeFileSync(t2, o2);
      written.push(t2);
      console.log("grey in a fresh file: imported", o2.split("\n")[0]);
    }
    // and none when it is set to the list only, or off
    for (const v of ["list", "off", false]) {
      settings["suggestNext"] = v;
      if (await inline.provideInlineCompletionItems(doc, doc.positionAt(at))) throw new Error("grey text with suggestNext " + v);
    }
    settings["suggestNext"] = "off";
    const lt = new Doc(target, text.slice(0, at) + "<" + text.slice(at));
    if (await provider.provideCompletionItems(lt, lt.positionAt(at + 1), null, { triggerKind: 1 })) throw new Error("a list with suggestNext off");
    delete settings["suggestNext"];
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
