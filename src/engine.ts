// Expands a terse abbreviation like "cardhdrbtn" into JSX, using what was
// learned from a codebase. The search is a dynamic program written with
// @vhalaharvi/dyna:
//
//   state      (position in the typed text, the components still open)
//   coalgebra  every way to read the next piece of text: which piece, which
//              component it names, where it attaches, and whether a usual
//              wrapper component sits in between
//   algebra    best three readings (max, +) on log-probabilities, the number
//              of readings (+, ×), and their total probability (+, ×)
//
// Reading the text left to right is the grammar Read ::= ε | Piece Read,
// the same shape as tiling a strip with tiles of different lengths.
import { count, dyna, product, topK, ungraded, type Coalgebra, type Entry, type GradedAlgebra, type Node, type Pair } from "@vhalaharvi/dyna";

const ROOT = "ROOT";

export interface PropStat { n: number; vals: Record<string, number> }
export interface CompStat {
  count: number;
  module: string | null;
  props: Record<string, PropStat>;
  propsBy?: Record<string, Record<string, PropStat>>;
  text: Record<string, number>;
  textBy?: Record<string, Record<string, number>>;
  seqs: Record<string, Record<string, number>>;
  byParent?: Record<string, number>;
  wrapper: Record<string, number>;
  render: { prop: string; params: string } | null;
  renderSeqs?: Record<string, number>;
  /** per parent: each use's props as JSON [name, value][], value null for a spread */
  sigs?: Record<string, Record<string, number>>;
  /** uses with text or an expression inside */
  content?: number;
}
/** One way a name is declared: a module const or type, a prop, or a statement in a component body. */
export interface DeclVariant { n: number; uses: string[]; imports: Record<string, string>; pos: number }
export interface Decl { kind: "module" | "local" | "prop"; declares: string[]; variants: Record<string, DeclVariant> }

export interface Model {
  files: number;
  edges: Record<string, Record<string, number>>;
  comps: Record<string, CompStat>;
  /** keyed by the names declared ("open,setOpen"), "prop:name", or "effect:<names used>" */
  decls?: Record<string, Decl>;
  /** where non-component names are imported from: useState → react */
  imports?: Record<string, string>;
  /** the names each learned prop expression reads: {form.handleSubmit(onSubmit)} → form, onSubmit */
  exprUses?: Record<string, string[]>;
  /** zod definitions seen for each form field name */
  fields?: Record<string, Record<string, number>>;
}

// ---------- The abbreviation model ----------

const VOWELS = new Set("aeiou");
/** How likely a typist keeps a letter when abbreviating: vowels are dropped more often. */
const keepP = (ch: string) => (VOWELS.has(ch) ? 0.4 : 0.65);

/**
 * log P(abbrev | word) for a typist who keeps the first letter, then keeps or
 * drops each letter on its own, and may stop early (the rest of the word left
 * off costs one fixed stop, so "trig" and "trigger" are both cheap). The best
 * way to line the abbreviation up against the word; -Infinity if there is none.
 */
export function abbrevLogP(a: string, w: string, starts: readonly number[] = [0]): number {
  // leaving off whole words at the end (the "Fallback" of AvatarFallback) costs more than trailing letters
  const skipped = (j: number) => starts.filter((s) => s >= j).length * Math.log(SKIP_PART);
  if (!a || !w || a[0] !== w[0] || a.length > w.length) return -Infinity;
  const n = a.length, m = w.length;
  let prev = new Float64Array(n + 1).fill(-Infinity);
  prev[1] = Math.log(keepP(w[0] as string)); // first letter kept
  let best = n === 1 ? (prev[1] as number) + Math.log(STOP) + skipped(1) : -Infinity;
  for (let j = 1; j < m; j++) {
    const ch = w[j] as string;
    const keep = Math.log(keepP(ch)), drop = Math.log(1 - keepP(ch));
    const cur = new Float64Array(n + 1).fill(-Infinity);
    for (let i = 0; i <= n; i++) {
      const d = (prev[i] as number) + drop;
      if (d > (cur[i] as number)) cur[i] = d;
      if (i > 0 && a[i - 1] === ch) {
        const k = (prev[i - 1] as number) + keep;
        if (k > (cur[i] as number)) cur[i] = k;
      }
    }
    prev = cur;
    if (j + 1 < m && best < (prev[n] as number) + Math.log(STOP) + skipped(j + 1)) best = (prev[n] as number) + Math.log(STOP) + skipped(j + 1);
  }
  return Math.max(best, prev[n] as number);
}

/** The chance the typist stops before the end of the word. */
const STOP = 0.5;
/** The extra chance of leaving off a whole word at the end. */
const SKIP_PART = 0.15;

/** "CardHeader" → ["card", "header"] */
export const parts = (name: string) => name.split(/(?=[A-Z])/).map((p) => p.toLowerCase());

// ---------- One reading step ----------

export interface Step {
  readonly end: boolean;
  readonly chunk: string;
  readonly comp: string;
  readonly parent: string;
  readonly wrapper: string | null;
  /** how many open components were closed before this one */
  readonly up: number;
  readonly repeat: number;
  /** a prop value the piece named, like name="email" */
  readonly set: { prop: string; value: string } | null;
  readonly logp: number;
  /** the factors of logp, for explaining the choice */
  readonly f: { abbrev: number; dropped: string[]; place: number; attach: number };
}

const END: Step = { end: true, chunk: "", comp: "", parent: "", wrapper: null, up: 0, repeat: 1, set: null, logp: 0, f: { abbrev: 0, dropped: [], place: 0, attach: 0 } };

interface Match { comp: string; logp: number; dropped: string[]; set: { prop: string; value: string } | null }

export class Expander {
  readonly names: string[];
  private readonly prior: Record<string, number> = {};
  private readonly total: Record<string, number> = {};
  private readonly hasKids: Record<string, number> = {};
  private readonly matchCache = new Map<string, Match[]>();

  constructor(readonly model: Model, readonly opts = { alpha: 0.5, wrapperCost: 0.3, dropCost: 0.15, upDecay: 0.3, rootSibling: 0.2, maxChunk: 14, minChunk: 2, perChunk: 5, minAbbrev: Math.log(2e-4), maxOpen: 4 }) {
    this.names = Object.keys(model.comps).filter((c) => model.comps[c]?.module);
    const sum = this.names.reduce((a, c) => a + (model.comps[c]?.count ?? 0), 0);
    for (const c of this.names) this.prior[c] = ((model.comps[c]?.count ?? 0) + 1) / (sum + this.names.length);
    for (const [p, e] of Object.entries(model.edges)) this.total[p] = Object.values(e).reduce((a, b) => a + b, 0);
    for (const c of this.names) {
      const st = model.comps[c] as CompStat;
      let withKids = 0, all = 0;
      for (const seqs of Object.values(st.seqs)) for (const [s, k] of Object.entries(seqs)) { all += k; if (s) withKids += k; }
      if (st.render) withKids = all = Math.max(all, st.count);
      this.hasKids[c] = (withKids + 0.1) / (all + 1);
    }
    this.hasKids[ROOT] = 1;
  }

  /** P(child | parent): observed share, smoothed toward overall frequency, times the chance parent has children at all. */
  childP(parent: string, child: string): number {
    const e = this.model.edges[parent]?.[child] ?? 0;
    const t = this.total[parent] ?? 0;
    const { alpha } = this.opts;
    return (this.hasKids[parent] ?? 0.01) * (e + alpha * (this.prior[child] ?? 0)) / (t + alpha);
  }

  /** Every component a piece of text could name, with log P(text | component). */
  matches(chunk: string): Match[] {
    const hit = this.matchCache.get(chunk);
    if (hit) return hit;
    const out: Match[] = [];
    for (const c of this.names) {
      const ps = parts(c);
      let best: Match | null = null;
      for (let d = 0; d < ps.length; d++) {
        const rest = ps.slice(d);
        const starts: number[] = [];
        rest.reduce((at, p) => (starts.push(at), at + p.length), 0);
        const lp = abbrevLogP(chunk, rest.join(""), starts);
        if (lp > -Infinity && (!best || lp > best.logp)) best = { comp: c, logp: lp, dropped: ps.slice(0, d), set: null };
        // Keep the full name too when it reads well: whether dropping is free depends on the parent.
        if (lp > -Infinity && d === 0) out.push({ comp: c, logp: lp, dropped: [], set: null });
      }
      if (best && best.dropped.length) out.push(best);
      // A piece can also name a value the component is often given: "pwd" is a
      // FormField with name="password", "dstr" a Button with variant="destructive".
      const st = this.model.comps[c] as CompStat;
      for (const [prop, ps2] of Object.entries(st.props)) {
        for (const [raw, n] of Object.entries(ps2.vals)) {
          const m = /^"([a-z][a-z-]{2,})"$/i.exec(raw);
          if (!m) continue;
          const value = m[1] as string;
          const lp = abbrevLogP(chunk, value.toLowerCase().replace(/-/g, ""));
          if (lp > -Infinity) out.push({ comp: c, logp: lp + Math.log(n / st.count), dropped: [], set: { prop, value } });
        }
      }
    }
    // the few components this piece reads best as: the rest would never win
    const kept = out.filter((m) => m.logp >= this.opts.minAbbrev).sort((a, b) => b.logp - a.logp).slice(0, this.opts.perChunk);
    this.matchCache.set(chunk, kept);
    return kept;
  }

  /** The prop value of a component that `typed` abbreviates best, like "out" → variant="outline". */
  valueMatch(comp: string, typed: string): { set: { prop: string; value: string }; logp: number } | null {
    const st = this.model.comps[comp] as CompStat;
    let best: { set: { prop: string; value: string }; logp: number } | null = null;
    for (const [prop, ps] of Object.entries(st.props))
      for (const raw of Object.keys(ps.vals)) {
        const m = /^"([a-z][a-z0-9-]*)"$/i.exec(raw);
        if (!m) continue;
        const lp = abbrevLogP(typed, (m[1] as string).toLowerCase().replace(/-/g, ""));
        if (lp > -Infinity && (!best || lp > best.logp)) best = { set: { prop, value: m[1] as string }, logp: lp };
      }
    return best;
  }

  /** Leading name parts may be left out when the parent's name starts with them: "hdr" inside Card is CardHeader. */
  private dropLogP(dropped: string[], parent: string): number {
    if (!dropped.length) return 0;
    const pp = parent === ROOT ? [] : parts(parent);
    const implied = dropped.every((p, i) => pp[i] === p);
    return implied ? 0 : dropped.length * Math.log(this.opts.dropCost);
  }

  /** The coalgebra: every way to read the rest of `text` from a state. */
  coalgebra(text: string): Coalgebra<string, Step> {
    return (state) => {
      const bar = state.indexOf("|");
      let i = Number(state.slice(0, bar));
      const path = state.slice(bar + 1) ? state.slice(bar + 1).split(">") : [];
      if (i >= text.length) return [{ label: END, kids: [] }];
      // an explicit > or + fixes where the next piece goes
      let only: number | null = null;
      if (text[i] === ">") { only = 0; i++; }
      else if (text[i] === "+") { only = 1; i++; }
      const out: Node<Step, string>[] = [];
      const L = path.length;
      const ups: number[] = [];
      for (let up = 0; up <= L; up++) if ((only === null || only === up) && !(L === 0 && up > 0)) ups.push(up);
      if (L === 0 && only !== null && !ups.includes(0)) ups.push(0);
      const z = ups.reduce((a, up) => a + Math.pow(this.opts.upDecay, up), 0);
      for (let j = i + this.opts.minChunk; j <= Math.min(text.length, i + this.opts.maxChunk); j++) {
        const chunk = text.slice(i, j);
        if (!/^[a-z0-9]+$/.test(chunk)) break;
        // an optional .value names a prop value of this piece ("btn.out" is an outline Button),
        // and an optional *n repeats it
        let next = j, repeat = 1;
        const mod = /^\.([a-z0-9]+)/.exec(text.slice(next));
        if (mod) next += mod[0].length;
        const rep = /^\*(\d+)/.exec(text.slice(next));
        if (rep) { repeat = Math.max(1, Math.min(20, Number(rep[1]))); next += rep[0].length; }
        for (const m0 of this.matches(chunk)) {
          let m = m0;
          if (mod) {
            if (m0.set) continue;
            const v = this.valueMatch(m0.comp, mod[1] as string);
            if (!v) continue;
            m = { ...m0, logp: m0.logp + v.logp, set: v.set };
          }
          for (const up of ups) {
            const parent = up >= L ? ROOT : (path[L - 1 - up] as string);
            // a second component at the top makes a fragment: possible, but rarely meant
            const attach = Math.log(Math.pow(this.opts.upDecay, up) / z) + (parent === ROOT && L > 0 ? Math.log(this.opts.rootSibling) : 0);
            const kept = path.slice(0, L - up);
            const step = (wrapper: string | null, place: number, under: string): void => {
              const dl = this.dropLogP(m.dropped, under);
              if (dl === -Infinity) return;
              const logp = m.logp + dl + place + attach;
              const label: Step = { end: false, chunk, comp: m.comp, parent, wrapper, up, repeat, set: m.set, logp, f: { abbrev: m.logp + dl, dropped: m.dropped, place, attach } };
              // only the innermost few open components can still take children
              const open = [...kept, ...(wrapper ? [wrapper] : []), m.comp].slice(-this.opts.maxOpen);
              out.push({ label, kids: [`${next}|${open.join(">")}`] });
            };
            step(null, Math.log(this.childP(parent, m.comp)), parent);
            // a usual child of the parent that usually holds this component
            for (const [w, n] of Object.entries(this.model.edges[parent] ?? {})) {
              if (w === m.comp || !this.names.includes(w) || n < 1) continue;
              const via = this.childP(parent, w) * this.childP(w, m.comp) * this.opts.wrapperCost;
              if ((this.model.edges[w]?.[m.comp] ?? 0) > 0) step(w, Math.log(via), w);
            }
          }
        }
      }
      return out;
    };
  }

  /**
   * Reads `text` every possible way and returns the readings' count, their
   * total probability, and the best few, each rendered as JSX.
   */
  expand(text: string, k = 3): Expansion {
    const t = text.toLowerCase().replace(/[^a-z0-9>+*.]/g, "");
    const best = topK<Step>(Math.max(8, k * 3), (l, kids) => (l.end ? 0 : l.logp + (kids[0] as number)));
    const total: GradedAlgebra<Step, number> = {
      zero: 0,
      plus: (a, b) => a + b,
      isZero: (x) => x === 0,
      alg: (n) => (n.label.end ? 1 : Math.exp(n.label.logp) * (n.kids[0] as number)),
    };
    const alg = ungraded(product(best, product(count<Step>(), total)));
    const [res, stats] = dyna(alg, this.coalgebra(t), "0|");
    const z = res.b.b;
    const seen = new Map<string, Result>();
    for (const e of res.a) {
      const steps = chain(e);
      const r = this.render(steps);
      if (!r.code) continue;
      const prob = z > 0 ? Math.exp(e.score) / z : 0;
      const s = seen.get(r.code);
      if (s) s.prob += prob;
      else seen.set(r.code, { ...r, prob, steps });
    }
    const results = [...seen.values()].sort((a, b) => b.prob - a.prob).slice(0, k);
    return { text: t, readings: res.b.a, total: z, states: stats.states, alternatives: stats.alternatives, results };
  }

  // ---------- Turning a reading into code ----------

  private render(steps: Step[]): Omit<Result, "prob" | "steps"> {
    interface T { name: string; repeat: number; typed: boolean; kids: T[]; parent: string; set?: { prop: string; value: string } | null; hint?: string }
    const root: T = { name: ROOT, repeat: 1, typed: true, kids: [], parent: "" };
    let path: T[] = [];
    for (const s of steps) {
      if (s.end) break;
      const L = path.length;
      const parent = s.up >= L ? root : (path[L - 1 - s.up] as T);
      path = path.slice(0, L - s.up);
      let at = parent;
      if (s.wrapper) {
        const w: T = { name: s.wrapper, repeat: 1, typed: false, kids: [], parent: parent.name };
        at.kids.push(w);
        path.push(w);
        at = w;
      }
      const node: T = { name: s.comp, repeat: s.repeat, typed: true, kids: [], parent: at.name, set: s.set, ...(s.set ? { hint: s.set.value } : at.hint ? { hint: at.hint } : {}) };
      at.kids.push(node);
      path.push(node);
    }
    // fill in what a component almost always holds, when nothing was typed inside it
    const filled: string[] = [];
    const fill = (n: T, depth: number): void => {
      if (n.kids.length === 0 && depth < 3 && n.name !== ROOT) {
        const st = this.model.comps[n.name];
        const seqs = st?.render ? st.renderSeqs ?? {} : pickSeqs(st, n.parent);
        const tot = Object.values(seqs).reduce((a, b) => a + b, 0);
        const [top, c] = Object.entries(seqs).sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
        if (top && tot > 0 && c / tot >= 0.5) {
          for (const name of top.split(",")) if (this.names.includes(name)) n.kids.push({ name, repeat: 1, typed: false, kids: [], parent: n.name, ...(n.hint ? { hint: n.hint } : {}) });
          if (n.kids.length) filled.push(`${n.name} usually holds ${top.split(",").join(", ")} (${c} of ${tot}): added`);
        }
      }
      for (const k of n.kids) fill(k, n.typed ? 0 : depth + 1);
    };
    fill(root, 0);
    const used: string[] = [];
    const lines: string[] = [];
    const preview: PreviewNode[] = [];
    const usedNames = new Set<string>();
    const bound = new Set<string>();
    const pad = (d: number) => "  ".repeat(d);
    // names a render prop hands its children ({ field }): usable only inside one
    const renderParams = new Set(Object.values(this.model.comps).flatMap((c) => (c.render ? c.render.params.replace(/[{}\s]/g, "").split(",").filter(Boolean) : [])));
    const scope = new Set<string>();
    const inScope = (k: string, v: string | null) => (this.model.exprUses?.[k.startsWith("...") ? k : (v ?? "")] ?? []).every((u) => !renderParams.has(u) || scope.has(u));
    const emit = (n: T, d: number, nth0 = 0, into: PreviewNode[] = preview): void => {
      if (!used.includes(n.name)) used.push(n.name);
      const st = this.model.comps[n.name] as CompStat;
      for (let r = 0; r < n.repeat; r++) {
      const use = propsFor(st, n.parent, n.set ?? null, n.hint, nth0 + r, inScope);
      const attrs = use.attrs;
      const open = `<${n.name}${attrs ? " " + attrs : ""}`;
      // the text seen with those props, unless it is a one-off title: then a placeholder
      const text = use.text && (textCount(st, use.text) >= 2 || st.count <= 2 || nth0 + r > 0 || (n.hint && use.text.toLowerCase() === n.hint.toLowerCase())) ? use.text : textFor(st, n.parent, n.name, n.hint);
      for (const [k, v] of use.pairs) for (const u of this.model.exprUses?.[k.startsWith("...") ? k : v] ?? []) usedNames.add(u);
      const pv: PreviewNode = { name: n.name, props: Object.fromEntries(use.pairs.map(([k, v]) => [k, /^"/.test(v) ? (JSON.parse(v) as string) : v])), text, kids: [] };
      into.push(pv);
        if (st.render) {
          const params = st.render.params.replace(/[{}\s]/g, "").split(",").filter(Boolean);
          for (const b of params) bound.add(b);
          lines.push(`${pad(d)}${open}`);
          lines.push(`${pad(d + 1)}${st.render.prop}={(${st.render.params.startsWith("{") ? st.render.params : st.render.params}) => (`);
          const added = params.filter((b) => !scope.has(b));
          added.forEach((b) => scope.add(b));
          if (n.kids.length === 1) emit(n.kids[0] as T, d + 2, 0, pv.kids);
          else {
            lines.push(`${pad(d + 2)}<>`);
            emitAll(n.kids, d + 3, pv.kids);
            lines.push(`${pad(d + 2)}</>`);
          }
          added.forEach((b) => scope.delete(b));
          lines.push(`${pad(d + 1)})}`);
          lines.push(`${pad(d)}/>`);
          continue;
        }
        if (n.kids.length === 0) {
          lines.push(text ? `${pad(d)}${open}>${text}</${n.name}>` : `${pad(d)}${open} />`);
          continue;
        }
        lines.push(`${pad(d)}${open}>`);
        const wrap = topOf(st.wrapper, 0.5);
        const inner = wrap ? d + 2 : d + 1;
        if (wrap) {
          lines.push(`${pad(d + 1)}${wrap}`);
          for (const u of this.model.exprUses?.[wrap] ?? []) usedNames.add(u);
        }
        emitAll(n.kids, inner, pv.kids);
        if (wrap) lines.push(`${pad(d + 1)}</${/^<([a-z0-9]+)/.exec(wrap)?.[1]}>`);
        lines.push(`${pad(d)}</${n.name}>`);
      }
    };
    function emitAll(kids: T[], d: number, into: PreviewNode[]): void {
      const seen: Record<string, number> = {};
      for (const k of kids) {
        emit(k, d, seen[k.name] ?? 0, into);
        seen[k.name] = (seen[k.name] ?? 0) + k.repeat;
      }
    }
    const tops = root.kids;
    if (tops.length > 1 || tops.some((n) => n.repeat > 1)) {
      lines.push("<>");
      for (const n of tops) emit(n, 1);
      lines.push("</>");
    } else for (const n of tops) emit(n, 0);
    const byModule = new Map<string, string[]>();
    for (const n of used) {
      const m = this.model.comps[n]?.module;
      if (m) byModule.set(m, [...(byModule.get(m) ?? []), n]);
    }
    const imports = [...byModule].map(([m, ns]) => `import { ${ns.join(", ")} } from "${m}";`);
    const fields = collectFields(preview);
    const comp = this.complete([...usedNames].filter((u) => !bound.has(u)), fields);
    const allImports = mergeImports(byModule, comp.imports);
    const name = `${tops[0]?.name ?? "My"}Example`;
    const sigText = comp.props.length ? `{ ${comp.props.map((p) => p.name).join(", ")} }: { ${comp.props.map((p) => `${p.name}: ${p.type}`).join("; ")} }` : "";
    const body = lines.map((l) => "    " + l).join("\n");
    const file = [
      allImports.join("\n"),
      ...(comp.module.length ? ["", comp.module.join("\n\n")] : []),
      "",
      `export function ${name}(${sigText}) {`,
      ...(comp.local.length ? [comp.local.map((t) => indent(t, "  ")).join("\n\n"), ""] : []),
      "  return (",
      body,
      "  );",
      "}",
    ].join("\n");
    return { code: lines.join("\n"), imports, filled, preview, file, declared: comp.why };
  }

  /**
   * Declares every name the JSX reads, the way this codebase declares it: the
   * hook or handler most often seen declaring it, then whatever that needs in
   * turn (form needs formSchema, which needs z). A name nobody declares becomes
   * a prop. Effects come along when everything they touch is already declared.
   */
  complete(names: string[], fields: string[]): { module: string[]; local: string[]; props: { name: string; type: string }[]; imports: Record<string, string>; why: string[] } {
    const decls = this.model.decls ?? {};
    const known = this.model.imports ?? {};
    const chosen = new Map<string, { key: string; d: Decl; text: string; v: DeclVariant }>();
    const props: { name: string; type: string }[] = [];
    const imports: Record<string, string> = {};
    const why: string[] = [];
    const declaredBy = (name: string) =>
      Object.entries(decls)
        .filter(([k, d]) => d.kind !== "prop" && !k.startsWith("effect:") && d.declares.includes(name))
        .sort((a, b) => total(b[1]) - total(a[1]))[0];
    const visit = (name: string, from: string): void => {
      if ([...chosen.values()].some((c) => c.d.declares.includes(name)) || props.some((p) => p.name === name)) return;
      if (name in known) { imports[name] = known[name] as string; return; }
      const hit = declaredBy(name);
      if (hit) {
        const [key, d] = hit;
        // variants that differ only in their form fields are the same declaration once fitted
        const fitted = new Map<string, { n: number; v: DeclVariant }>();
        for (const [t, v] of Object.entries(d.variants)) {
          const f = withFields(t, fields, this.model.fields ?? {});
          const cur = fitted.get(f);
          fitted.set(f, cur ? { n: cur.n + v.n, v: cur.v } : { n: v.n, v });
        }
        const [text, best] = [...fitted].sort((a, b) => b[1].n - a[1].n)[0] as [string, { n: number; v: DeclVariant }];
        const v = best.v;
        chosen.set(key, { key, d, text: d.kind === "local" ? dedent(text) : text, v });
        why.push(`${name}: declared the way ${best.n} of ${total(d)} components do it${from ? `, for ${from}` : ""}`);
        Object.assign(imports, v.imports);
        for (const u of v.uses) visit(u, d.declares.join(", "));
        return;
      }
      // nobody declares it: it comes in as a prop, typed as the code types it when that type stands alone
      const p = decls["prop:" + name];
      const t = p ? (Object.entries(p.variants).sort((a, b) => b[1].n - a[1].n)[0]?.[0] ?? "any") : "any";
      props.push({ name, type: /\b[A-Z]/.test(t) ? "any" : t });
      why.push(`${name}: no component declares it, so it is a prop`);
    };
    for (const n of names) visit(n, "");
    // effects whose local names are all declared now
    const have = new Set([...chosen.values()].flatMap((c) => c.d.declares));
    for (const [key, d] of Object.entries(decls)) {
      if (!key.startsWith("effect:")) continue;
      const [text, v] = Object.entries(d.variants).sort((a, b) => b[1].n - a[1].n)[0] as [string, DeclVariant];
      const locals = v.uses.filter((u) => !(u in known));
      if (locals.length && locals.every((u) => have.has(u))) {
        chosen.set(key, { key, d, text: dedent(text), v });
        Object.assign(imports, v.imports);
        why.push(`an effect that fills ${locals.join(", ")}, as in ${v.n} of ${total(d)} components`);
      }
    }
    const all = [...chosen.values()];
    const module = all.filter((c) => c.d.kind === "module").sort((a, b) => Number(/^(type|interface)/.test(b.text)) - Number(/^(type|interface)/.test(a.text))).map((c) => c.text);
    const local = all.filter((c) => c.d.kind === "local").sort((a, b) => a.v.pos / a.v.n - b.v.pos / b.v.n).map((c) => c.text);
    return { module, local, props, imports, why };
  }

  /** Plain-language reasons for each step of a reading. */
  why(steps: Step[]): string[] {
    const out: string[] = [];
    for (const s of steps) {
      if (s.end) break;
      const ps = parts(s.comp);
      const word = ps.slice(s.f.dropped.length).map(cap).join("");
      const implied = s.f.dropped.length ? `; "${s.f.dropped.map(cap).join("")}" implied by ${s.wrapper ?? s.parent}` : "";
      if (s.set) out.push(`"${s.chunk}" → ${s.comp} ${s.set.prop}="${s.set.value}": letters of "${s.set.value}", a ${s.set.prop} ${s.comp} often has`);
      else out.push(`"${s.chunk}" → ${s.comp}: letters of "${word}"${implied}${s.repeat > 1 ? `, ×${s.repeat}` : ""}`);
      const where = s.parent === ROOT ? "at the top" : `inside ${s.parent}`;
      if (s.wrapper) {
        const a = this.model.edges[s.parent]?.[s.wrapper] ?? 0, at = this.total[s.parent] ?? 0;
        const b = this.model.edges[s.wrapper]?.[s.comp] ?? 0, bt = this.total[s.wrapper] ?? 0;
        out.push(`   ${s.comp} rarely sits directly ${where}; ${s.wrapper} does (${a} of ${at}) and holds ${s.comp} (${b} of ${bt}): ${s.wrapper} added`);
      } else {
        const a = this.model.edges[s.parent]?.[s.comp] ?? 0, at = this.total[s.parent] ?? 0;
        out.push(`   ${where}: ${a} of ${at} uses${s.parent === ROOT ? " at the top" : ` of ${s.parent}'s children`} are ${s.comp}`);
      }
    }
    return out;
  }
}

/** One element of an expansion, for drawing a preview: props as written (strings unquoted, expressions in braces). */
export interface PreviewNode {
  name: string;
  props: Record<string, string>;
  text: string;
  kids: PreviewNode[];
}

export interface Result {
  code: string;
  /** the whole component: imports, declarations, hooks, and the JSX */
  file: string;
  /** why each declaration is there */
  declared: string[];
  preview: PreviewNode[];
  imports: string[];
  /** children added because the component almost always has them */
  filled: string[];
  /** share of the total probability of all readings */
  prob: number;
  steps: Step[];
}

export interface Expansion {
  text: string;
  /** how many ways the text can be read */
  readings: number;
  total: number;
  states: number;
  alternatives: number;
  results: Result[];
}

const total = (d: Decl) => Object.values(d.variants).reduce((a, v) => a + v.n, 0);
/** A statement copied out of a component body keeps its body's indentation on later lines: take that off. */
function dedent(text: string): string {
  const lines = text.split("\n");
  const rest = lines.slice(1).filter((l) => l.trim());
  const min = rest.length ? Math.min(...rest.map((l) => (/^ */.exec(l) as RegExpExecArray)[0].length)) : 0;
  const cut = Math.max(0, min - 0) && rest.some((l) => /^\s*[)}\]]/.test(l)) ? Math.min(min, 2) : 0;
  return [lines[0], ...lines.slice(1).map((l) => l.slice(Math.min(cut, (/^ */.exec(l) as RegExpExecArray)[0].length)))].join("\n");
}
const indent = (text: string, by: string) => text.split("\n").map((l) => (l ? by + l : l)).join("\n");

/** The form fields an expansion names, in order: name="email" on each FormField. */
function collectFields(nodes: PreviewNode[]): string[] {
  const out: string[] = [];
  const walk = (n: PreviewNode) => {
    if (n.name === "FormField" && n.props.name && /^[a-zA-Z]\w*$/.test(n.props.name) && !out.includes(n.props.name)) out.push(n.props.name);
    n.kids.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

/**
 * Fits a learned declaration to the fields asked for: a zod schema gets one
 * line per field (as this code defines that field, or z.string()), and
 * defaultValues one empty value per field.
 */
function withFields(text: string, fields: string[], defs: Record<string, Record<string, number>>): string {
  if (!fields.length) return text;
  let out = text;
  if (/z\.object\(\{/.test(out)) {
    const lines = fields.map((f) => `  ${f}: ${Object.entries(defs[f] ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "z.string()"},`);
    out = out.replace(/z\.object\(\{[\s\S]*?\n\}\)/, `z.object({\n${lines.join("\n")}\n})`);
  }
  if (/defaultValues: \{[^}]*\}/.test(out)) out = out.replace(/defaultValues: \{[^}]*\}/, `defaultValues: { ${fields.map((f) => `${f}: ""`).join(", ")} }`);
  return out;
}

/** Component imports and declaration imports, one line per module, React first. */
function mergeImports(components: Map<string, string[]>, other: Record<string, string>): string[] {
  const by = new Map<string, string[]>();
  for (const [n, m] of Object.entries(other)) by.set(m, [...(by.get(m) ?? []), n]);
  const order = [...by.keys()].sort((a, b) => Number(b === "react") - Number(a === "react"));
  return [
    ...order.map((m) => `import { ${(by.get(m) as string[]).join(", ")} } from "${m}";`),
    ...[...components].map(([m, ns]) => `import { ${ns.join(", ")} } from "${m}";`),
  ];
}

function chain(e: Entry<Step>): Step[] {
  const out: Step[] = [];
  let cur: Entry<Step> | undefined = e;
  while (cur) {
    out.push(cur.label);
    cur = cur.kids[0];
  }
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function topOf(o: Record<string, number> | undefined, share: number): string | null {
  if (!o) return null;
  const tot = Object.values(o).reduce((a, b) => a + b, 0);
  const [k, v] = Object.entries(o).sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  return k && tot > 0 && v / tot >= share ? k : null;
}

function pickSeqs(st: CompStat | undefined, parent: string): Record<string, number> {
  if (!st) return {};
  const here = st.seqs[parent];
  if (here && Object.values(here).reduce((a, b) => a + b, 0) >= 2) return here;
  const all: Record<string, number> = {};
  for (const s of Object.values(st.seqs)) for (const [k, v] of Object.entries(s)) all[k] = (all[k] ?? 0) + v;
  return all;
}

/**
 * The props and text for one use: the most common combination actually seen
 * on this component (under this parent when it has been seen there twice). A
 * value the user named replaces its prop's value; a value named further up
 * (name="password") picks a combination that agrees (type="password").
 */
function propsFor(st: CompStat, parent: string, set: { prop: string; value: string } | null, hint: string | undefined, nth = 0, keep: (k: string, v: string | null) => boolean = () => true): { attrs: string; text: string | null; pairs: [string, string][] } {
  type Sig = { p: [string, string | null][]; t: string };
  const pick = (sigs: Record<string, number> | undefined) => Object.entries(sigs ?? {}).map(([k, n]) => [JSON.parse(k) as Sig, n] as const);
  let cands = (st.byParent?.[parent] ?? 0) >= 2 ? pick(st.sigs?.[parent]) : [];
  if (!cands.length) cands = Object.values(st.sigs ?? {}).flatMap((x) => pick(x));
  const h = hint === undefined ? undefined : JSON.stringify(hint);
  // how often each combination of props (text aside) occurs
  const combo = new Map<string, number>();
  for (const [sig, n] of cands) combo.set(JSON.stringify(sig.p), (combo.get(JSON.stringify(sig.p)) ?? 0) + n);
  const score = (sig: Sig, n: number) => {
    let s = (combo.get(JSON.stringify(sig.p)) ?? 0) * 10 + n + (st.textBy?.[parent]?.[sig.t] ?? st.text[sig.t] ?? 0) * 0.1;
    if (set && sig.p.some(([k]) => k === set.prop && (!set.value || true))) s += 10000;
    if (set && sig.p.some(([k, v]) => k === set.prop && v === JSON.stringify(set.value))) s += 5000;
    if (h && (sig.p.some(([, v]) => v === h) || sig.t.toLowerCase() === (hint as string).toLowerCase())) s += 1000;
    return s;
  };
  const ranked = cands.slice().sort((a, b) => score(b[0], b[1]) - score(a[0], a[1]));
  // the nth use among siblings takes the nth most usual combination: Cancel, then Save
  const best = (ranked[Math.min(nth, ranked.length - 1)] ?? ranked[0])?.[0] ?? { p: [], t: "" };
  // a key only means something inside a .map(), which an expansion never has
  const sig = best.p.filter(([k, v]) => !(st.render && k === st.render.prop) && k !== "key" && keep(k, v));
  if (set && !sig.some(([k]) => k === set.prop)) sig.push([set.prop, JSON.stringify(set.value)]);
  const attrs = sig
    .map(([k, v]) => {
      if (k.startsWith("...")) return `{${k}}`;
      if (set && k === set.prop) return `${k}=${JSON.stringify(set.value)}`;
      return v === "true" ? k : `${k}=${v}`;
    })
    .join(" ");
  const pairs: [string, string][] = sig.map(([k, v]) => [k, set && k === set.prop ? JSON.stringify(set.value) : (v ?? "")]);
  return { attrs, text: best.t || null, pairs };
}

function textCount(st: CompStat, t: string): number {
  return st.text[t] ?? 0;
}

/** The usual text, or a placeholder when the component usually has text but it varies. */
function textFor(st: CompStat, parent: string, name: string, hint: string | undefined): string {
  const under = st.byParent?.[parent] ?? 0;
  const texts = under >= 2 && st.textBy?.[parent] ? st.textBy[parent] : st.text;
  const n = under >= 2 ? under : st.count;
  const entries = Object.entries(texts).sort((a, b) => b[1] - a[1]);
  if (!entries.length && (st.content ?? 0) / st.count >= 0.5) return parts(name).slice(-1).map(cap).join("");
  if (hint) {
    const same = entries.find(([t]) => t.toLowerCase() === hint.toLowerCase());
    if (same) return same[0];
  }
  const withText = entries.reduce((a, [, v]) => a + v, 0);
  if (!entries.length) return "";
  if ((entries[0] as [string, number])[1] >= 2) return (entries[0] as [string, number])[0];
  return withText / n >= 0.3 || (st.content ?? 0) / st.count >= 0.5 ? parts(name).slice(-1).map(cap).join("") : "";
}

export type { Pair };
