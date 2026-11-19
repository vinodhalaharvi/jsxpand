// jsxpand for VS Code: type an abbreviation in JSX, pick a reading, get the code your project
// would write, with its imports, hooks and declarations put where they belong.
import * as vscode from "vscode";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import type { Item, Reply, Request } from "./worker.js";

const LANGS = ["typescriptreact", "javascriptreact"];
const MODEL_VERSION = 1;

export function activate(ctx: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const root = folder.uri.fsPath;
  const out = vscode.window.createOutputChannel("jsxpand");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
  status.command = "jsxpand.relearn";
  status.tooltip = "jsxpand: click to learn this workspace again";
  ctx.subscriptions.push(out, status);

  const worker = new Worker(join(ctx.extensionPath, "dist", "worker.js"));
  ctx.subscriptions.push({ dispose: () => void worker.terminate() });
  const send = (r: Request) => worker.postMessage(r);
  const pending = new Map<number, (items: Item[]) => void>();
  let nextId = 1;
  let ready = false;
  let learning = false;

  const cache = ctx.storageUri ? vscode.Uri.joinPath(ctx.storageUri, `model-v${MODEL_VERSION}.json`) : null;

  worker.on("message", async (m: Reply) => {
    if (m.type === "expanded") {
      pending.get(m.id)?.(m.items);
      pending.delete(m.id);
    } else if (m.type === "learned") {
      learning = false;
      ready = true;
      status.text = `$(symbol-snippet) jsxpand · ${m.comps} components`;
      status.show();
      out.appendLine(`learned ${m.files} files, ${m.comps} components in ${(m.ms / 1000).toFixed(1)} s`);
      if (!m.typesRead) out.appendLine("types not read (install the project's dependencies to learn required props)");
      if (cache && ctx.storageUri) {
        await vscode.workspace.fs.createDirectory(ctx.storageUri);
        await vscode.workspace.fs.writeFile(cache, Buffer.from(m.model));
      }
    } else if (m.type === "loaded") {
      ready = true;
      status.text = `$(symbol-snippet) jsxpand · ${m.comps} components`;
      status.show();
    } else if (m.type === "error") {
      out.appendLine(m.message);
      if (m.id !== undefined) {
        pending.get(m.id)?.([]);
        pending.delete(m.id);
      } else learning = false;
    }
  });
  worker.on("error", (e) => out.appendLine(String(e)));

  const relearn = () => {
    if (learning) return;
    learning = true;
    status.text = "$(sync~spin) jsxpand · learning";
    status.show();
    const src = vscode.workspace.getConfiguration("jsxpand").get<string>("sourceFolder");
    send({ type: "learn", root, src: src ? join(root, src) : undefined });
  };

  // start from the last model at once, then learn again in the background
  void (async () => {
    if (cache) {
      try {
        const bytes = await vscode.workspace.fs.readFile(cache);
        send({ type: "load", root, model: Buffer.from(bytes).toString("utf8") });
      } catch {
        /* no model yet */
      }
    }
    relearn();
  })();

  // what the project writes changes as you work: learn again a while after saving
  let timer: ReturnType<typeof setTimeout> | undefined;
  ctx.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (!LANGS.includes(d.languageId)) return;
      clearTimeout(timer);
      timer = setTimeout(relearn, 60_000);
    }),
    { dispose: () => clearTimeout(timer) },
    vscode.commands.registerCommand("jsxpand.relearn", relearn),
  );

  const expand = (doc: vscode.TextDocument, pos: vscode.Position): Promise<Item[]> => {
    if (!ready) return Promise.resolve([]);
    const id = nextId++;
    const k = vscode.workspace.getConfiguration("jsxpand").get<number>("results") ?? 3;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      send({ type: "expand", id, text: doc.getText(), offset: doc.offsetAt(pos), file: doc.uri.fsPath, k });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve([]);
        }
      }, 3000);
    });
  };

  const provider: vscode.CompletionItemProvider = {
    async provideCompletionItems(doc, pos) {
      const items = await expand(doc, pos);
      const list = items.map((it, i) => {
        const c = new vscode.CompletionItem(
          { label: it.abbrev, detail: `  ${it.tops.join(" + ")}`, description: `${Math.round(it.prob * 100)}%${it.mode === "component" ? " · new component" : ""}` },
          vscode.CompletionItemKind.Snippet,
        );
        c.filterText = it.abbrev;
        c.sortText = `!${i}`;
        c.preselect = i === 0;
        c.range = new vscode.Range(doc.positionAt(it.main.start), doc.positionAt(it.main.end));
        c.insertText = it.main.text;
        c.additionalTextEdits = it.extra.map((e) => vscode.TextEdit.replace(new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text));
        const md = new vscode.MarkdownString();
        md.appendCodeblock(it.code, "tsx");
        md.appendMarkdown("\n\n**Why**\n\n" + it.why.filter((w) => w.trim()).map((w) => `- ${w.trim()}`).join("\n"));
        c.documentation = md;
        return c;
      });
      return new vscode.CompletionList(list, true);
    },
  };
  ctx.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      LANGS.map((language) => ({ language, scheme: "file" })),
      provider,
      ">", "+", "^", "*", ".",
    ),
  );
}

export function deactivate(): void {}
