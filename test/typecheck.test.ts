// Every whole component the tool writes must type-check: against the real
// component sources in page/ui, React, react-hook-form and zod.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Expander, type Model } from "../src/engine.js";
import modelJson from "../src/model.json" with { type: "json" };

const x = new Expander(modelJson as unknown as Model);
const inputs = [
  "cardhdrbtn", "frmemlpwdbtn", "frm>eml+pwd+btn", "frmnameemlpwdbtn", "frmmsgbtn", "dlgtrigbtnhdrftr", "crd>hdr+ftr>btn.out+btn",
  "dlg>trig>btn.dstr", "cardcontsw", "srch", "inpt", "lblinpt", "tbl", "tblhdrrowhead*3", "tbl>bdy>row>cell*3", "avtr", "sel",
  "tabslisttrig*2", "bdg.sec", "btn.dstr*2", "cardcont>avtr", "tabs>cont>card", "dlgcontfrm", "txtar", "dlgcontinpt",
];

describe("generated components type-check", () => {
  it("against the real components and libraries", () => {
    const dir = resolve("test/.gen");
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
      baseUrl: resolve("."),
      // the sample project: its ui components are page/ui, its own components the corpus files
      paths: { "@/components/ui/*": ["page/ui/*"], "@/*": ["corpus/*"] },
      types: [],
    });
    const diags = ts.getPreEmitDiagnostics(program).filter((d) => d.file && files.includes(resolve(d.file.fileName)));
    const msgs = diags.map((d) => `${d.file?.fileName.split("/").pop()}:${d.file ? d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1 : 0} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
    expect(files.length).toBeGreaterThan(50);
    expect(msgs).toEqual([]);
  }, 120_000);
});
