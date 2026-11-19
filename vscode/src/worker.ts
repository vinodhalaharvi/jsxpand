// Runs off the editor's thread: learns a workspace and expands abbreviations.
import { parentPort } from "node:worker_threads";
import { relative } from "node:path";
import { Expander, type Model } from "../../src/engine.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { edits, locate } from "./insert.js";
import { modelFor } from "./project.js";

// what shadcn/ui-style code generally looks like, shipped beside this file
let prior: Record<string, unknown> | null = null;
try {
  prior = JSON.parse(readFileSync(join(__dirname, "prior.json"), "utf8"));
} catch {
  /* built without one */
}

export type Request =
  | { type: "learn"; root: string; src?: string }
  | { type: "load"; root: string; model: string }
  | { type: "expand"; id: number; text: string; offset: number; file: string; k: number };

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
  | { type: "error"; id?: number; message: string };

let x: Expander | null = null;
let root = "";
const port = parentPort!;

port.on("message", (m: Request) => {
  try {
    if (m.type === "learn") {
      const t = Date.now();
      root = m.root;
      const model = modelFor(m.root, prior, m.src) as unknown as Model & { files: number; types?: { lib: boolean } };
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
        return {
          abbrev: where.abbrev,
          mode: where.mode,
          prob: r.prob,
          tops: [...new Set(r.preview.map((p) => p.name))],
          code: where.mode === "component" ? e.main.text : r.file,
          why: [...x!.why(r.steps), ...r.declared],
          main: e.main,
          extra: e.extra,
        };
      });
      port.postMessage({ type: "expanded", id: m.id, items } satisfies Reply);
    }
  } catch (err) {
    port.postMessage({ type: "error", id: (m as { id?: number }).id, message: err instanceof Error ? err.stack ?? err.message : String(err) } satisfies Reply);
  }
});
