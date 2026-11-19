// The engine itself compiles under strict TypeScript.
import { expect, it } from "vitest";
import ts from "typescript";

it("engine.ts type-checks strictly", () => {
  const program = ts.createProgram(["src/engine.ts"], {
    strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, resolveJsonModule: true,
  });
  const msgs = ts.getPreEmitDiagnostics(program).map((d) => `${d.file?.fileName}:${d.start} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  expect(msgs).toEqual([]);
}, 60_000);
