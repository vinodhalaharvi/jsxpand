// Runs off the editor's thread: learns a workspace and expands abbreviations.
import { parentPort } from "node:worker_threads";
import { relative } from "node:path";
import { Expander, type MapNode, type Model } from "../../src/engine.js";
import { edits, locate, slot } from "./insert.js";
import { modelFor } from "./project.js";


export type Request =
  | { type: "learn"; root: string; src?: string }
  | { type: "load"; root: string; model: string }
  | { type: "expand"; id: number; text: string; offset: number; file: string; k: number }
  | { type: "next"; id: number; text: string; offset: number; file: string; k: number }
  | { type: "map"; id: number; comp: string };

/** A component for an empty spot: how often it goes there, what to type for it, and the code that picking it puts in. */
export type NextItem = {
  comp: string;
  p: number;
  type: string | null;
  code: string;
  main: { start: number; end: number; text: string };
  extra: { start: number; end: number; text: string }[];
};

export type Item = {
  abbrev: string;
  mode: "jsx" | "component";
  prob: number;
  /** the top-level components, for the label */
  tops: string[];
  code: string;
  why: string[];
  main: { start: number; end: number; text: string };
  extra: { start: number; end: number; text: string }[];
};

export type Reply =
  | { type: "learned"; model: string; files: number; comps: number; ms: number; typesRead: boolean }
  | { type: "loaded"; files: number; comps: number }
  | { type: "expanded"; id: number; items: Item[] }
  | { type: "next"; id: number; items: NextItem[]; parent: string }
  | { type: "map"; id: number; map: MapNode | null }
  | { type: "error"; id?: number; message: string };

/** The components of a reading, in order of appearance, each once. */
function componentsIn(nodes: { name: string; kids: unknown[] }[]): string[] {
  const out: string[] = [];
  const walk = (ns: { name: string; kids: unknown[] }[]): void => {
    for (const n of ns) {
      if (/^[A-Z]/.test(n.name) && !out.includes(n.name)) out.push(n.name);
      walk(n.kids as { name: string; kids: unknown[] }[]);
    }
  };
  walk(nodes);
  return out;
}

let x: Expander | null = null;
let root = "";
const port = parentPort!;

port.on("message", (m: Request) => {
  try {
    if (m.type === "learn") {
      const t = Date.now();
      root = m.root;
      const model = modelFor(m.root, m.src) as unknown as Model & { files: number; types?: { lib: boolean } };
      x = new Expander(model);
      port.postMessage({ type: "learned", model: JSON.stringify(model), files: model.files, comps: Object.keys(model.comps).length, ms: Date.now() - t, typesRead: !!model.types?.lib } satisfies Reply);
    } else if (m.type === "load") {
      root = m.root;
      const model = JSON.parse(m.model) as Model & { files: number };
      x = new Expander(model);
      port.postMessage({ type: "loaded", files: model.files, comps: Object.keys(model.comps).length } satisfies Reply);
    } else if (m.type === "expand") {
      const where = x ? locate(m.text, m.offset, m.file) : null;
      if (!x || !where) return port.postMessage({ type: "expanded", id: m.id, items: [] } satisfies Reply);
      const fileRel = relative(root, m.file).split("\\").join("/");
      const items: Item[] = x.expand(where.abbrev, m.k, where.inside).results.map((r) => {
        const e = edits(m.text, where, r.parts, fileRel);
        // typed as <abbrev: the < goes too
        if (where.mode === "jsx" && m.text[e.main.start - 1] === "<") e.main = { ...e.main, start: e.main.start - 1 };
        return {
          abbrev: where.abbrev,
          mode: where.mode,
          prob: r.prob,
          // what sets the readings apart: the components in it, in order (Card · CardHeader · CardTitle · …)
          tops: componentsIn(r.preview),
          code: where.mode === "component" ? e.main.text : r.file,
          why: [...x!.why(r.steps), ...r.declared],
          main: e.main,
          extra: e.extra,
        };
      });
      port.postMessage({ type: "expanded", id: m.id, items } satisfies Reply);
    } else if (m.type === "next") {
      const at = x ? slot(m.text, m.offset, m.file) : null;
      if (!x || !at) return port.postMessage({ type: "next", id: m.id, items: [], parent: "" } satisfies Reply);
      const fileRel = relative(root, m.file).split("\\").join("/");
      const items: NextItem[] = [];
      for (const n of x.next(at.parent, at.prev, at.grand, m.k)) {
        // the code: what typing its short form there would give, when that reads as this component
        for (const abbrev of [n.type, n.comp.toLowerCase()]) {
          if (!abbrev) continue;
          const text = m.text.slice(0, at.start) + abbrev + m.text.slice(at.end);
          const where = locate(text, at.start + abbrev.length, m.file);
          const r = where && x.expand(abbrev, 3, where.inside).results.find((r) => r.steps.find((s) => !s.end)?.comp === n.comp && !r.steps.find((s) => !s.end)?.up);
          if (!where || !r) continue;
          const e = edits(text, where, r.parts, fileRel);
          // back to the file as it is: the abbreviation was not there, the "<" (if any) was
          const shift = abbrev.length - (at.end - at.start);
          const back = (o: number) => (o >= at.start + abbrev.length ? o - shift : o);
          items.push({ comp: n.comp, p: n.p, type: n.type, code: r.file, main: { start: at.start, end: at.end, text: e.main.text }, extra: e.extra.map((d) => ({ start: back(d.start), end: back(d.end), text: d.text })) });
          break;
        }
      }
      port.postMessage({ type: "next", id: m.id, items, parent: at.parent } satisfies Reply);
    } else if (m.type === "map") {
      port.postMessage({ type: "map", id: m.id, map: x && x.model.comps[m.comp] ? x.map(m.comp) : null } satisfies Reply);
    }
  } catch (err) {
    port.postMessage({ type: "error", id: (m as { id?: number }).id, message: err instanceof Error ? err.stack ?? err.message : String(err) } satisfies Reply);
  }
});
