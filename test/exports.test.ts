// What the project can use, used yet or not: its own exported components and its React dependencies'
// public entry points, with nothing from anywhere else.
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { Expander, type Model } from "../src/engine.js";
import { modelFor } from "../vscode/src/project.js";

// Real projects to test against: clone them side by side and install their dependencies
//   git clone https://github.com/satnaing/shadcn-admin && (cd shadcn-admin && npm install)
//   git clone https://github.com/shadcn-ui/taxonomy && (cd taxonomy && npm install --ignore-scripts --legacy-peer-deps)
// then run with JSXPAND_PROJECTS=<that folder>. Without it these tests are skipped.
const REAL = process.env.JSXPAND_PROJECTS ?? "/nonexistent";

const APP = resolve("test/fixtures/exports-app");

describe("a project's exports", () => {
  let m: { comps: Record<string, { count: number; module: string; exported?: string; required?: string[]; reqVals?: Record<string, string> }> };
  beforeAll(() => {
    // the fixture's dependencies: this repo's own react and zod
    mkdirSync(join(APP, "node_modules/@types"), { recursive: true });
    const link = (to: string, at: string) => { if (!existsSync(join(APP, at))) symlinkSync(resolve(to), join(APP, at)); };
    link("node_modules/react", "node_modules/react");
    link("node_modules/zod", "node_modules/zod");
    link("node_modules/@types/react", "node_modules/@types/react");
    m = modelFor(APP) as typeof m;
  }, 120_000);

  it("offers components the app has never used, with what their types require", () => {
    expect(m.comps.Panel?.count).toBeGreaterThan(0);
    expect(m.comps.PanelBadge).toMatchObject({ count: 0, module: "@/components/ui/panel", exported: "project", required: ["tone"], reqVals: { tone: '"info"' } });
    expect(m.comps.PanelLegacy).toMatchObject({ count: 0, required: ["title"] });
  });

  it("leaves out what is not a component and what the code marks @internal", () => {
    expect(m.comps.PanelSizes).toBeUndefined();
    expect(m.comps.PanelSecret).toBeUndefined();
  });

  it("reads only dependencies that can hold components (zod cannot: it does not depend on React)", () => {
    expect(Object.values(m.comps).some((c) => c.module === "zod")).toBe(false);
    expect(Object.keys(m.comps).some((n) => n.startsWith("Zod"))).toBe(false);
  });

  it("expands to a never-used part, inside its family, with its required prop", () => {
    const x = new Expander(m as unknown as Model);
    const r = x.expand("pnl>pnlbdg", 3).results[0];
    // inside its Panel (in the <p> this app's one Panel holds), given the tone its type requires
    expect(r?.code).toMatch(/^<Panel>[\s\S]*<PanelBadge tone="info" \/>[\s\S]*<\/Panel>$/);
  });
});

describe.skipIf(!existsSync(`${REAL}/taxonomy/node_modules`))("nothing from anywhere else", () => {
  it("a small project's suggestions carry no other project's text or classes", () => {
    const x = new Expander(modelFor(`${REAL}/taxonomy`) as unknown as Model);
    const code = ["cardhdrttlcont", "tabs>list>trig*3^cont", "frm>eml+btn"].flatMap((q) => x.expand(q, 3, ["DashboardShell"]).results.map((r) => r.file)).join("\n");
    // shadcn-admin's dashboard text, which a built-in layer used to bring in
    for (const s of ["Total Clicks", "1,248", "+12.4% vs last week", "Overview", "Analytics"]) expect(code, s).not.toContain(s);
  }, 300_000);
  it("never-used components of the project are offered when spelled out", () => {
    const x = new Expander(modelFor(`${REAL}/taxonomy`) as unknown as Model);
    expect(x.expand("select", 3, ["DashboardShell"]).results[0]?.code).toMatch(/^<Select/);
    expect(x.expand("dlgportal", 3, ["DashboardShell"]).results[0]?.code).toMatch(/^<DialogPortal/);
  }, 300_000);
});
