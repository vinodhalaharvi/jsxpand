// Replay a real project: hide each component it uses, type an abbreviation for it in place,
// and see where the real component ranks. Counts are taken leaving the file out, so a file
// never helps rank its own components.
//   vite-node bench/replay.ts <project>/src
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Expander, parts, type Model } from "../src/engine.js";
import modelJson from "../src/model-admin.json" with { type: "json" };

const ROOT = "ROOT";
const x = new Expander(modelJson as unknown as Model);
const names = new Set(x.names);

interface Use { file: string; name: string; parent: string; prev: string; grand: string; depth: number }

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f.startsWith(".")) return [];
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

const tagOf = (n: ts.Node): string | null => {
  const t = ts.isJsxElement(n) ? n.openingElement.tagName : ts.isJsxSelfClosingElement(n) ? n.tagName : null;
  return t && ts.isIdentifier(t) && /^[A-Z]/.test(t.text) ? t.text : null;
};

const uses: Use[] = [];
for (const file of files(process.argv[2]!)) {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // walk with the chain of enclosing components, and the previous component among siblings
  const walk = (n: ts.Node, chain: string[]) => {
    const name = tagOf(n);
    let inner = chain;
    if (name) {
      inner = [...chain, name];
    }
    if (ts.isJsxElement(n)) {
      let prev = "^";
      for (const c of n.children) {
        const cn = tagOf(c);
        if (cn) {
          record(c, cn, inner, prev);
          prev = cn;
        }
        walk(c, inner);
      }
      return;
    }
    n.forEachChild((c) => {
      const cn = tagOf(c);
      if (cn && !ts.isJsxElement(n)) record(c, cn, inner, "^");
      walk(c, inner);
    });
  };
  const record = (_n: ts.Node, name: string, chain: string[], prev: string) => {
    if (!names.has(name)) return;
    uses.push({ file, name, parent: chain.at(-1) ?? ROOT, grand: chain.at(-2) ?? ROOT, prev, depth: chain.length });
  };
  walk(sf, []);
}

// counts, and the same counts for each file alone (to leave it out)
type C = Map<string, number>;
const inc = (m: C, k: string, d = 1) => m.set(k, (m.get(k) ?? 0) + d);
const all = { one: new Map() as C, par: new Map() as C, parT: new Map() as C, sib: new Map() as C, sibT: new Map() as C, gp: new Map() as C, gpT: new Map() as C, gps: new Map() as C, gpsT: new Map() as C };
const per = new Map<string, typeof all>();
const add = (t: typeof all, u: Use, d: number) => {
  inc(t.one, u.name, d);
  inc(t.par, u.parent + ">" + u.name, d); inc(t.parT, u.parent, d);
  inc(t.sib, u.parent + "|" + u.prev + ">" + u.name, d); inc(t.sibT, u.parent + "|" + u.prev, d);
  inc(t.gp, u.grand + "/" + u.parent + ">" + u.name, d); inc(t.gpT, u.grand + "/" + u.parent, d);
  inc(t.gps, u.grand + "/" + u.parent + "|" + u.prev + ">" + u.name, d); inc(t.gpsT, u.grand + "/" + u.parent + "|" + u.prev, d);
};
for (const u of uses) {
  add(all, u, 1);
  if (!per.has(u.file)) per.set(u.file, { one: new Map(), par: new Map(), parT: new Map(), sib: new Map(), sibT: new Map(), gp: new Map(), gpT: new Map(), gps: new Map(), gpsT: new Map() });
  add(per.get(u.file)!, u, 1);
}
const N = uses.length;
const g = (k: keyof typeof all, key: string, f: typeof all) => (all[k].get(key) ?? 0) - (f[k].get(key) ?? 0);

// the abbreviations people type
const CONS = (w: string) => { let s = w[0]!; for (const ch of w.slice(1)) if (!"aeiou".includes(ch) && s.length < 3) s += ch; return s; };
const schemes: Record<string, (u: Use) => string> = {
  "consonants (dlgtrg)": (u) => parts(u.name).map(CONS).join(""),
  "two letters a word (ditr)": (u) => parts(u.name).slice(0, 3).map((p) => p.slice(0, 2)).join(""),
  "last word inside its family (trg in Dialog)": (u) => {
    const ps = parts(u.name), pp = parts(u.parent);
    let k = 0;
    while (k < ps.length - 1 && pp[k] === ps[k]) k++;
    return ps.slice(k).map(CONS).join("");
  },
};

const ALPHA = 2, BETA = 2;
function rank(u: Use, chunk: string, ctx: "none" | "parent" | "parent+previous" | "parent+grandparent"): number {
  const f = per.get(u.file)!;
  const n1 = N - (f.one.size ? [...f.one.values()].reduce((a, b) => a + b, 0) : 0);
  const prior = (c: string) => (g("one", c, f) + 1) / (n1 + names.size);
  const pPar = (c: string) => (g("par", u.parent + ">" + c, f) + ALPHA * prior(c)) / (g("parT", u.parent, f) + ALPHA);
  const p = (c: string) => {
    if (ctx === "none") return prior(c);
    if (ctx === "parent") return pPar(c);
    if (ctx === "parent+previous") return (g("sib", u.parent + "|" + u.prev + ">" + c, f) + BETA * pPar(c)) / (g("sibT", u.parent + "|" + u.prev, f) + BETA);
    return (g("gp", u.grand + "/" + u.parent + ">" + c, f) + BETA * pPar(c)) / (g("gpT", u.grand + "/" + u.parent, f) + BETA);
  };
  const best = new Map<string, number>();
  for (const m of x.matches(chunk)) {
    if (m.set) continue;
    const pp = parts(u.parent);
    const implied = m.dropped.every((d, i) => pp[i] === d);
    const s = m.logp + (m.dropped.length && !implied ? m.dropped.length * Math.log(0.15) : 0) + Math.log(p(m.comp));
    if (!best.has(m.comp) || s > best.get(m.comp)!) best.set(m.comp, s);
  }
  const truth = best.get(u.name);
  if (truth === undefined) return Infinity;
  let r = 1;
  for (const [c, s] of best) if (c !== u.name && s > truth) r++;
  return r;
}

console.log(`${uses.length} component uses in ${per.size} files, ${new Set(uses.map((u) => u.name)).size} different components\n`);
const ctxs = ["none", "parent", "parent+previous", "parent+grandparent"] as const;
for (const [label, ab] of Object.entries(schemes)) {
  console.log(label);
  for (const ctx of ctxs) {
    let top1 = 0, top3 = 0, mrr = 0, miss = 0;
    for (const u of uses) {
      const r = rank(u, ab(u), ctx);
      if (r === Infinity) { miss++; continue; }
      if (r === 1) top1++;
      if (r <= 3) top3++;
      mrr += 1 / r;
    }
    const pct = (k: number) => ((100 * k) / uses.length).toFixed(1).padStart(5) + "%";
    console.log(`  ${ctx.padEnd(20)} first ${pct(top1)}   top 3 ${pct(top3)}   MRR ${(mrr / uses.length).toFixed(3)}   no match ${miss}`);
  }
}

if (process.argv.includes("--why")) {
  const ab = schemes["last word inside its family (trg in Dialog)"]!;
  const miss = new Map<string, number>(), wrong = new Map<string, number>();
  for (const u of uses) {
    const chunk = ab(u);
    const r = rank(u, chunk, "parent");
    if (r === Infinity) inc(miss, `${u.name} as "${chunk}"`);
    else if (r > 1) {
      const f = per.get(u.file)!;
      let top = "", ts2 = -Infinity;
      for (const m of x.matches(chunk)) { if (m.set) continue; const s = m.logp; if (s > ts2) { ts2 = s; top = m.comp; } }
      inc(wrong, `${u.name} as "${chunk}" in ${u.parent}`);
    }
  }
  console.log("\nno match:", [...miss].sort((a, b) => b[1] - a[1]).slice(0, 15));
  console.log("\nnot first:", [...wrong].sort((a, b) => b[1] - a[1]).slice(0, 15));
}

// With nothing typed: where does the component written there rank among what goes at that spot?
// Inside X; inside X after Y; inside X under G after Y (the way the extension asks).
if (process.argv.includes("--next")) {
  const comps = [...new Set(uses.map((u) => u.name))];
  const B = 1;
  const rankNext = (u: Use, how: "parent" | "parent+previous" | "+grandparent") => {
    const f = per.get(u.file)!;
    const p1 = (c: string) => g("par", u.parent + ">" + c, f) / Math.max(1, g("parT", u.parent, f));
    const p2 = (c: string) => (g("sib", u.parent + "|" + u.prev + ">" + c, f) + B * p1(c)) / (g("sibT", u.parent + "|" + u.prev, f) + B);
    const p3 = (c: string) => (g("gps", u.grand + "/" + u.parent + "|" + u.prev + ">" + c, f) + B * p2(c)) / (g("gpsT", u.grand + "/" + u.parent + "|" + u.prev, f) + B);
    const p = how === "parent" ? p1 : how === "parent+previous" ? p2 : p3;
    const truth = p(u.name);
    if (truth <= 0) return Infinity;
    let r = 1;
    for (const c of comps) if (c !== u.name && p(c) > truth) r++;
    return r;
  };
  console.log("\nnothing typed: the component written there, ranked first / in the top 3 (file left out)");
  const buckets: [string, (u: Use) => boolean][] = [["all", () => true], ["depth 1 (top level)", (u) => u.depth === 0], ["depth 2", (u) => u.depth === 1], ["depth 3", (u) => u.depth === 2], ["depth 4+", (u) => u.depth >= 3], ["first child", (u) => u.prev === "^"], ["after a sibling", (u) => u.prev !== "^"]];
  for (const [label, keep] of buckets) {
    const us = uses.filter(keep);
    const row = (["parent", "parent+previous", "+grandparent"] as const).map((how) => {
      let a = 0, b3 = 0;
      for (const u of us) { const r = rankNext(u, how); if (r === 1) a++; if (r <= 3) b3++; }
      return `${((100 * a) / us.length).toFixed(0).padStart(3)}% / ${((100 * b3) / us.length).toFixed(0).padStart(3)}%`;
    });
    console.log(`  ${label.padEnd(20)} n=${String(us.length).padEnd(5)} inside X ${row[0]}   after Y ${row[1]}   under G ${row[2]}`);
  }
}
