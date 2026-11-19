// Expands in the background so typing never waits on the search.
import { Expander, type Model } from "../../src/engine.js";
import modelJson from "../../src/model-admin.json";

const model = modelJson as unknown as Model;
const x = new Expander(model);
const modules = Object.fromEntries(Object.entries(model.comps).map(([k, c]) => [k, { module: c.module, as: c.as }]));
const stats = { files: model.files, components: x.names.length, uses: Object.values(model.edges).reduce((a, e) => a + Object.values(e).reduce((p, q) => p + q, 0), 0) };
postMessage({ kind: "ready", modules, stats });

onmessage = (ev: MessageEvent<{ id: number; q: string }>) => {
  const t0 = performance.now();
  const e = x.expand(ev.data.q, 3);
  const ms = performance.now() - t0;
  postMessage({
    kind: "result",
    id: ev.data.id,
    ms,
    text: e.text,
    readings: e.readings,
    states: e.states,
    results: e.results.map((r) => ({ prob: r.prob, file: r.file, preview: r.preview, why: x.why(r.steps), filled: [...new Set(r.filled)], declared: r.declared })),
  });
};
