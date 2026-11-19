// The editor side: expansions put into real files of shadcn-admin, every import, hook,
// declaration and prop where it belongs, and the files still type-check.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Expander, type Model } from "../src/engine.js";
import { apply, edits, locate } from "../vscode/src/insert.js";
import { detectAlias, modelFor, projectConfig, sourceDir } from "../vscode/src/project.js";

const ROOT = "/home/claude/real/shadcn-admin";

describe("locate", () => {
  const at = (src: string) => locate(src.replace("|", ""), src.indexOf("|"));
  it("finds JSX and new-component spots", () => {
    expect(at("const A = () => (<div>\n  cardhdr|\n</div>)")?.mode).toBe("jsx");
    expect(at("function A() {\n  return (\n    cardhdr|\n  )\n}")?.mode).toBe("jsx");
    expect(at("function A() {\n  return cardhdr|\n}")?.mode).toBe("jsx");
    expect(at("const A = () => cardhdr|")?.mode).toBe("jsx");
    expect(at("import x from 'y'\n\ncardhdr|")?.mode).toBe("component");
    expect(at("const A = () => (<div>\n  tabs>list>trig*3^cont|\n</div>)")?.abbrev).toBe("tabs>list>trig*3^cont");
    expect(at("const A = () => (<Main>\n  <Card>\n    hdr|\n  </Card>\n</Main>)")?.inside).toEqual(["Main", "Card"]);
  });
  it("stays out of ordinary code", () => {
    expect(at("const s = 'cardhdr|'")).toBeNull();
    expect(at("// cardhdr|")).toBeNull();
    expect(at("function A() {\n  const x = cardhdr|\n}")).toBeNull();
    expect(at("function A() {\n  foo(cardhdr|)\n}")).toBeNull();
    expect(at("import { cardhdr| } from 'y'")).toBeNull();
  });
});


const PROJECTS: { root: string; cases: [string, string, string][] }[] = [
  {
    // Vite, src/, "@/*" → "./src/*"
    root: ROOT,
    cases: [
      ["src/features/dashboard/index.tsx", "<Main>", "cardhdrttlcont"],
      ["src/features/dashboard/index.tsx", "<Main>", "frm>usr+eml+btn"],
      ["src/features/dashboard/index.tsx", "<Main>", "tabs>list>trig*3^cont"],
      ["src/features/dashboard/index.tsx", "<Main>", "sel>trig^cont>itm*3"],
      ["src/features/dashboard/index.tsx", "<Main>", "tbl>hdr>row>head*4"],
      ["src/features/users/components/data-table-row-actions.tsx", "<>", "ddmtrigbtncontitm*3"],
      ["src/features/users/components/data-table-row-actions.tsx", "<>", "frmemlbtn"],
      ["src/features/users/components/data-table-row-actions.tsx", "<>", "dlg>cont>hdr+ftr>btn"],
      ["src/features/users/components/data-table-row-actions.tsx", "<>", "sheettrigbtncont"],
      ["src/features/users/components/data-table-row-actions.tsx", "<>", "avtrbdg"],
      ["src/features/dashboard/components/new.tsx", "", "cardhdrttlcont"],
      ["src/features/dashboard/components/new.tsx", "", "frm>usr+eml+btn"],
      ["src/features/dashboard/components/new.tsx", "", "tabs>list>trig*3^cont"],
    ],
  },
  {
    // Next.js, no src/, "@/*" → "./*", a small project
    root: "/home/claude/real/taxonomy",
    cases: [
      ["app/(dashboard)/dashboard/page.tsx", "<DashboardShell>", "cardhdrttlcont"],
      ["app/(dashboard)/dashboard/page.tsx", "<DashboardShell>", "tabs>list>trig*3^cont"],
      ["app/(dashboard)/dashboard/page.tsx", "<DashboardShell>", "ddmtrigbtncontitm*3"],
      ["app/(dashboard)/dashboard/page.tsx", "<DashboardShell>", "frm>eml+btn"],
      ["app/(dashboard)/dashboard/page.tsx", "<DashboardShell>", "ddmtrigbtncontitm*3"],
      ["components/user-account-nav.tsx", "<DropdownMenu>", "trig>avtr"],
      ["components/new.tsx", "", "cardhdrttlcont"],
      ["components/new.tsx", "", "dlg>cont>hdr+ftr>btn"],
    ],
  },
];

for (const { root, cases } of PROJECTS)
  describe.skipIf(!existsSync(join(root, "node_modules")))(`in ${root.split("/").pop()}`, () => {
    it("puts expansions into real files that still type-check under the project's own tsconfig", () => {
      const x = new Expander(modelFor(root) as unknown as Model);
      const written: string[] = [];
      const empty: string[] = [];
      try {
        cases.forEach(([file, after, abbrev], i) => {
          const orig = existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : "";
          const pos = after ? orig.indexOf(after) + after.length : 0;
          expect(pos, `${file}: ${after}`).toBeGreaterThanOrEqual(after.length);
          const pad = after ? "\n        " : "";
          const text = orig.slice(0, pos) + pad + abbrev + orig.slice(pos);
          const where = locate(text, pos + pad.length + abbrev.length);
          expect(where?.mode, abbrev).toBe(after ? "jsx" : "component");
          // as many readings as the extension offers by default: the search's width depends on it
          const results = x.expand(abbrev, 3, where!.inside).results;
          if (!results.length) empty.push(abbrev);
          for (const [k, r] of results.entries()) {
            const rel = file.replace(/\.tsx$/, `.jsxpand-${i}-${k}.tsx`);
            const { main, extra } = edits(text, where!, r.parts, rel);
            const f = join(root, rel);
            writeFileSync(f, apply(text, [main, ...extra]));
            written.push(f);
          }
        });
        expect(empty).toEqual([]);
        const cfg = projectConfig(root);
        const program = ts.createProgram([...written, ...cfg.declarations], { ...cfg.options, noEmit: true, incremental: false, tsBuildInfoFile: undefined });
        const msgs = ts
          .getPreEmitDiagnostics(program)
          .filter((d) => d.file && written.includes(d.file.fileName))
          .map((d) => `${d.file!.fileName.split("/").pop()}:${d.file!.getLineAndCharacterOfPosition(d.start ?? 0).line + 1} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
        expect(written.length).toBeGreaterThanOrEqual(cases.length);
        expect(msgs).toEqual([]);
      } finally {
        if (!process.env.KEEP) for (const f of written) rmSync(f, { force: true });
      }
    }, 600_000);
  });

describe.skipIf(!existsSync(join(ROOT, "node_modules")))("project settings", () => {
  it("reads each project's alias and source folder", () => {
    expect(detectAlias(ROOT)).toEqual({ prefix: "@/", target: join(ROOT, "src") });
    expect(sourceDir(ROOT)).toBe(join(ROOT, "src"));
    expect(detectAlias("/home/claude/real/taxonomy")).toEqual({ prefix: "@/", target: "/home/claude/real/taxonomy" });
    expect(sourceDir("/home/claude/real/taxonomy")).toBe("/home/claude/real/taxonomy");
  });
});
