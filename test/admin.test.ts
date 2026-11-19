// The tool pointed at a real project: shadcn-admin. Every whole component it
// writes must type-check against that project's own source and libraries.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Expander, type Model } from "../src/engine.js";
import modelJson from "../src/model-admin.json" with { type: "json" };

const PROJECT = "/home/claude/real/shadcn-admin";
const x = new Expander(modelJson as unknown as Model);
const inputs = [
  "tabs>list>trig*3^cont", "cardhdrttlcont", "card*4", "ddmtrigbtncontitm*3", "frm>usr+eml+btn", "frmemlbtn", "dlg>cont>hdr+ftr>btn",
  "dlgtrigbtnhdrftr", "sheettrigbtncont", "sel>trig^cont>itm*3", "avtrbdg", "tbl>hdr>row>head*4", "tltptrigbtn", "bdg.sec", "btn.out",
  "popovtrigbtn", "sep", "chkbx", "swtch", "rdgrp>itm*3", "skel", "alrt", "cmd>inpt+lst>grp>itm*3",
];

describe.skipIf(!existsSync(PROJECT))("shadcn-admin", () => {
  it("finds a reading for every input", () => {
    for (const q of inputs) expect(x.expand(q).results.length, q).toBeGreaterThan(0);
  });

  it("writes components that type-check against the project", () => {
    const dir = join(PROJECT, "src/.jsxpand-gen");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    for (const q of inputs)
      x.expand(q).results.forEach((r, i) => {
        const f = join(dir, `${q.replace(/[^a-z0-9]/gi, "_")}_${i}.tsx`);
        writeFileSync(f, r.file);
        files.push(f);
      });
    const program = ts.createProgram(files, {
      jsx: ts.JsxEmit.ReactJSX,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      allowImportingTsExtensions: true,
      baseUrl: PROJECT,
      paths: { "@/*": ["src/*"] },
      types: ["vite/client"],
    });
    const diags = ts.getPreEmitDiagnostics(program).filter((d) => d.file && files.includes(resolve(d.file.fileName)));
    const msgs = diags.map((d) => `${d.file?.fileName.split("/").pop()}:${d.file ? d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1 : 0} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
    expect(files.length).toBeGreaterThan(40);
    expect(msgs).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  }, 300_000);
});
