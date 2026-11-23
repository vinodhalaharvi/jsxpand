import { describe, expect, it } from "vitest";
import ts from "typescript";
import { bruteForce, count, dyna, product, topK, ungraded, type GradedAlgebra } from "@vhalaharvi/dyna";
import { Expander, abbrevLogP, type Model, type Step } from "../src/engine.js";
import modelJson from "../src/model.json" with { type: "json" };

const model = modelJson as unknown as Model;
const x = new Expander(model);

describe("abbreviations", () => {
  it("read as the words they come from", () => {
    expect(abbrevLogP("hdr", "header")).toBeGreaterThan(-Infinity);
    expect(abbrevLogP("btn", "button")).toBeGreaterThan(abbrevLogP("bn", "button"));
    expect(abbrevLogP("trig", "trigger")).toBeGreaterThan(-Infinity);
    expect(abbrevLogP("xyz", "header")).toBe(-Infinity);
    expect(abbrevLogP("dr", "header")).toBe(-Infinity); // the first letter must match
    expect(abbrevLogP("avtr", "avatar", [0])).toBeGreaterThan(abbrevLogP("avtr", "avatarfallback", [0, 6]));
  });
});

describe("the dynamic program", () => {
  // the same three algebras expand() uses, checked against folding every reading separately
  const algebra = () => {
    const best = topK<Step>(5, (l, kids) => (l.end ? 0 : l.logp + (kids[0] as number)));
    const total: GradedAlgebra<Step, number> = { zero: 0, plus: (a, b) => a + b, isZero: (v) => v === 0, alg: (n) => (n.label.end ? 1 : Math.exp(n.label.logp) * (n.kids[0] as number)) };
    return ungraded(product(best, product(count<Step>(), total)));
  };
  it.each(["cardbtn", "btn.out", "frmeml", "tblrow", "dlghdr", "crd>hdr"])("equals brute force on %s", (q) => {
    const alg = algebra();
    const [dp, st] = dyna(alg, x.coalgebra(q), "0|");
    const [bf, trees] = bruteForce(alg, x.coalgebra(q), "0|");
    expect(dp.b.a).toBe(trees);
    expect(dp.b.a).toBe(bf.b.a);
    expect(Math.abs(dp.b.b - bf.b.b) / bf.b.b).toBeLessThan(1e-9);
    expect(dp.a.map((e) => e.score)).toEqual(bf.a.map((e) => e.score));
    expect(st.states).toBeGreaterThan(0);
  });

  it("gives each result its share of all readings' probability", () => {
    for (const q of ["cardhdrbtn", "frmemlpwdbtn", "avtr", "dstr"]) {
      const e = x.expand(q);
      const sum = e.results.reduce((a, r) => a + r.prob, 0);
      expect(sum).toBeLessThanOrEqual(1 + 1e-9);
      for (const r of e.results) expect(r.prob).toBeGreaterThan(0);
      for (let i = 1; i < e.results.length; i++) expect(e.results[i - 1]!.prob).toBeGreaterThanOrEqual(e.results[i]!.prob);
    }
  });
});

// every component a test input could start from: its abbreviation, a short prefix, and a value
const inputs = [
  "cardhdrbtn", "crd>hdr+ftr>btn*2", "crd>hdr+ftr>btn.out+btn", "frmemlpwdbtn", "frm>eml+pwd+btn", "dlgtrigbtnhdrftr",
  "dstr", "btn.out", "btn.dstr*2", "bdg.sec", "avtr", "sel", "tbl", "tblhdrrowhead*3", "tblbdyrowcell*4", "tabslisttrig*2",
  "tabslisttrig*2+cont", "inpt", "lblinpt", "cardcontinpt", "dlgcontfrm", "sw", "txtar", "selitm*3", "cardftrbtn.ghost",
  "frmmsg", "cardhdrbdg", "tbl>bdy>row*2>cell*3", "dlg>trig>btn.dstr", "avtr>img+fb", "cardcont>avtr", "tabs>cont>card",
  "qqq", "", "card>", "btn*0", ">>>", "card..x", "zz>zz",
];

describe("every expansion is valid TSX", () => {
  const known = new Set(Object.keys(model.comps));
  it.each(inputs)("%s", (q) => {
    const e = x.expand(q);
    for (const r of e.results) {
      const file = `${r.imports.join("\n")}\nexport function Example() {\n  return (\n${r.code}\n  );\n}\n`;
      const sf = ts.createSourceFile("x.tsx", file, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const diags = (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
      expect(diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), file).toEqual([]);
      // every component used is a real one and is imported
      const tags = new Set([...r.code.matchAll(/<([A-Z][A-Za-z]*)/g)].map((m) => m[1] as string));
      const imported = new Set(r.imports.flatMap((l) => (/\{ (.*) \}/.exec(l)?.[1] ?? "").split(", ")));
      for (const t of tags) {
        expect(known.has(t), t).toBe(true);
        expect(imported.has(t), `${t} imported`).toBe(true);
      }
    }
  });
});

describe("expected expansions", () => {
  const best = (q: string) => x.expand(q).results[0]?.code ?? "";
  it("cardhdrbtn: a card with a header, and the button in a footer", () => {
    const c = best("cardhdrbtn");
    expect(c).toMatch(/<Card>[\s\S]*<CardHeader>[\s\S]*<CardTitle>[\s\S]*<\/CardHeader>[\s\S]*<CardFooter>[\s\S]*<Button[\s\S]*<\/CardFooter>[\s\S]*<\/Card>/);
  });
  it("hdr means a different header inside a dialog", () => {
    expect(best("dlghdr")).toContain("<DialogHeader>");
    expect(best("tblhdr")).toContain("<TableHeader>");
  });
  it("frmemlpwdbtn: email and password fields, the password input typed as one", () => {
    const c = best("frmemlpwdbtn");
    expect(c).toContain('name="email"');
    expect(c).toContain('name="password"');
    expect(c).toContain('<Input type="password"');
    expect(c).toContain("<FormLabel>Password</FormLabel>");
    expect(c).toContain('<Button type="submit"');
    expect(c).toContain("<form onSubmit=");
  });
  it("values after a dot, and repeats", () => {
    expect(best("btn.out")).toContain('variant="outline"');
    expect(best("bdg.sec")).toContain('variant="secondary"');
    expect((best("crd>hdr+ftr>btn*2").match(/<Button/g) ?? []).length).toBe(2);
  });
  it("nonsense expands to nothing", () => {
    expect(x.expand("qqq").results).toEqual([]);
    expect(x.expand("").results).toEqual([]);
  });
});

describe("a project's own model (shadcn-admin)", async () => {
  const admin = new Expander((await import("../src/model-admin.json", { with: { type: "json" } })).default as unknown as Model);
  const top = (q: string) => admin.expand(q).results[0]!.steps.filter((s) => !s.end).map((s) => s.comp);
  it("finds a long name from a careful abbreviation of it", () => {
    expect(top("usractdlg")).toEqual(["UsersActionDialog"]);
    expect(top("tskimpdlg")).toEqual(["TasksImportDialog"]);
    expect(top("chvrghicn")).toEqual(["ChevronRightIcon"]);
  });
  it("reads a family member the project never used under its family's root", () => {
    expect(top("dlgtrig")).toEqual(["Dialog", "DialogTrigger"]);
    expect(top("dlg>trig>btn")).toEqual(["Dialog", "DialogTrigger", "Button"]);
  });
  it("uses an unused member the way its look-alikes in other families are used", () => {
    // DialogTrigger is never used in the project; SheetTrigger, PopoverTrigger and the rest are,
    // with asChild and a Button inside
    expect(top("dlgtrigbtn")).toEqual(["Dialog", "DialogTrigger", "Button"]);
    expect(top("alrtdlgtrigbtn")).toEqual(["AlertDialog", "AlertDialogTrigger", "Button"]);
    const code = admin.expand("dlgtrigbtnhdrftr").results[0]!.code;
    expect(code).toMatch(/<DialogTrigger asChild>\s*<Button/);
    expect(code).toMatch(/<DialogContent[^>]*>\s*<DialogHeader/);
  });
});
