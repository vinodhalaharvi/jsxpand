// The readings jsxpand gives for a fixed set of inputs, run-together, Emmet-style and mixed, on a
// real project's model. Any change to what comes out, or how likely, shows up here.
import { describe, expect, it } from "vitest";
import { Expander, type Model } from "../src/engine.js";
import admin from "../src/model-admin.json" with { type: "json" };

const INPUTS = [
  // run-together
  "dlgtrigbtnhdrftr", "dlgtrigbtn", "dlgtrig", "cardhdrttlcont", "ddmtrigbtncontitm", "frmemlbtn", "sheettrigbtncont",
  "avtrbdg", "tltptrigbtn", "popovtrigbtn", "alrtdlgtrigbtn", "colltrig", "usractdlg", "usrdltdlg", "tskimpdlg",
  "chvrghicn", "dttblclmhdr", "drpmntrg", "sep", "chkbx", "swtch", "skel", "alrt",
  // Emmet-style
  "dlg>trig>btn", "dlg>cont>hdr+ftr>btn", "tabs>list>trig*3^cont", "tbl>hdr>row>head*4", "sel>trig^cont>itm*3",
  "frm>usr+eml+btn", "rdgrp>itm*3", "cmd>inpt+lst>grp>itm*3", "card*4", "btn.out", "bdg.sec", "btn.dstr",
  // mixed
  "dlgtrig>btn", "card>hdrttl+cont", "ddmcont>itm*2+sep",
];

describe("readings", () => {
  it("are what they were", async () => {
    const x = new Expander(admin as unknown as Model);
    const out: Record<string, string[]> = {};
    for (const q of INPUTS) {
      const rs = x.expand(q, 3).results;
      out[q] = rs.map((r) => `${(r.prob * 100).toFixed(1)}% ${r.steps.filter((s) => !s.end).map((s) => "^".repeat(s.up) + s.comp + (s.wrapper ? `[${s.wrapper}]` : "") + (s.repeat > 1 ? `*${s.repeat}` : "")).join(" > ")}`);
      // and the code the first reading writes
      out[q + " (code)"] = (rs[0]?.file ?? "").split("\n");
    }
    await expect(JSON.stringify(out, null, 1) + "\n").toMatchFileSnapshot("./__snapshots__/readings.json");
  });
});
