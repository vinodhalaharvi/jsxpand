// A prior: what shadcn/ui-style code generally looks like (Card holds CardHeader and CardContent,
// SelectItem goes in SelectContent), for projects too small to have taught it themselves.
// It keeps only what carries over between projects (library components, literal props and text)
// and is added to a project's own model at a fraction of its weight, limited to the components
// that project actually has.

const FORM_NAMES = new Set(["field", "form"]);

/** A value that means the same in any project: a literal, or the usual form plumbing ({...field}). */
function portable(model, k, v) {
  const key = k.startsWith("...") ? k : v;
  if (key == null || !/^\{/.test(key)) return true;
  const uses = model.exprUses?.[key];
  return Array.isArray(uses) && uses.every((u) => FORM_NAMES.has(u));
}

/** Adds b into a (numbers summed, b's scaled by w; maps merged; anything else: a's kept). */
function merge(a, b, w) {
  for (const [k, v] of Object.entries(b)) {
    if (a[k] === undefined || a[k] === null) a[k] = scale(v, w);
    else if (typeof a[k] === "number" && typeof v === "number") a[k] += v * w;
    else if (isMap(a[k]) && isMap(v)) merge(a[k], v, w);
  }
  return a;
}
const isMap = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
function scale(v, w) {
  if (typeof v === "number") return v * w;
  if (isMap(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scale(x, w)]));
  return structuredClone(v);
}

/** Removes every component not in keep, and every pattern that mentions one, from a model (in place). */
function restrict(model, keep) {
  const ok = (n) => n === "ROOT" || keep.has(n);
  const okNames = (list) => list.every((n) => !/^[A-Z]/.test(n) || ok(n));
  for (const n of Object.keys(model.comps)) if (!keep.has(n)) delete model.comps[n];
  for (const [p, kids] of Object.entries(model.edges)) {
    if (!ok(p)) { delete model.edges[p]; continue; }
    for (const c of Object.keys(kids)) if (!ok(c)) delete kids[c];
  }
  for (const c of Object.values(model.comps)) {
    for (const f of ["seqs", "skels", "propsBy", "textBy", "sigs", "byParent", "renderSeqs"])
      if (c[f]) for (const p of Object.keys(c[f])) if (!ok(p)) delete c[f][p];
    if (c.within) for (const a of Object.keys(c.within)) if (!ok(a)) delete c.within[a];
    for (const by of Object.values(c.seqs ?? {})) for (const s of Object.keys(by)) if (s && !okNames(s.split(","))) delete by[s];
    for (const by of Object.values(c.renderSeqs ?? {})) if (isMap(by)) for (const s of Object.keys(by)) if (s && !okNames(s.split(","))) delete by[s];
    for (const by of Object.values(c.skels ?? {}))
      for (const [shape, sk] of Object.entries(by)) {
        const items = [];
        const walk = (xs) => xs.forEach((it) => { items.push(it); if (it.k) walk(it.k); });
        walk(sk.sample ?? []);
        const bad = items.some((it) => (it.c && !ok(it.c)) || (it.a ?? []).some(([k, v]) => !portable(model, k, v)));
        if (bad) delete by[shape];
      }
  }
}

/**
 * The prior from one or more learned models: library components only (modules from
 * @/components/ui/ or npm packages), literal props and text, no project declarations.
 */
export function makePrior(models) {
  const out = { files: 0, edges: {}, comps: {}, decls: {}, imports: {}, exprUses: {}, fields: {} };
  for (const m0 of models) {
    const m = structuredClone(m0);
    const keep = new Set(Object.entries(m.comps).filter(([, c]) => c.module && (c.module.startsWith("@/components/ui/") || !/^[@~.]\//.test(c.module))).map(([n]) => n));
    restrict(m, keep);
    for (const c of Object.values(m.comps)) {
      for (const ps of [c.props, ...Object.values(c.propsBy ?? {})])
        for (const [k, p] of Object.entries(ps ?? {})) {
          for (const v of Object.keys(p.vals ?? {})) if (!portable(m, k, v)) delete p.vals[v];
          if (!portable(m, k, null) && !Object.keys(p.vals ?? {}).length) delete ps[k];
        }
      for (const by of Object.values(c.sigs ?? {}))
        for (const key of Object.keys(by)) {
          const sig = JSON.parse(key);
          if (!sig.p.every(([k, v]) => portable(m, k, v))) delete by[key];
        }
    }
    // the expressions kept (form plumbing) keep what they read
    const exprUses = {};
    for (const [k, v] of Object.entries(m.exprUses ?? {})) if (v.every((u) => FORM_NAMES.has(u))) exprUses[k] = v;
    merge(out, { edges: m.edges, comps: m.comps, exprUses }, 1);
  }
  return out;
}

/**
 * A project's model with the prior added at weight w, for the components the project has.
 * resolve(module) gives the project's own module for a prior module ("@/components/ui/card" →
 * "~/components/ui/card"), or null when the project does not have it.
 */
export function withPrior(project, prior, resolve, w = 0.3) {
  const p = structuredClone(prior);
  const keep = new Set();
  for (const [n, c] of Object.entries(p.comps)) {
    // the project's own component of that name must be the same one: next/link's Link is not
    // @tanstack/react-router's, and must not pick up its to= prop
    const own = project.comps[n]?.module;
    const mod = resolve(c.module);
    if (!mod || (own && own !== mod)) continue;
    c.module = mod;
    keep.add(n);
  }
  restrict(p, keep);
  const out = structuredClone(project);
  out.exprUses ??= {};
  merge(out, { edges: p.edges, comps: p.comps, exprUses: p.exprUses }, w);
  // a component the prior brought in is imported the way the project imports
  for (const n of keep) if (!out.comps[n].module) out.comps[n].module = p.comps[n].module;
  out.prior = { components: keep.size, weight: w };
  return out;
}
