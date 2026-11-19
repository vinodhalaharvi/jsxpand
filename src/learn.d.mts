import type ts from "typescript";
export function freeNames(node: ts.Node): string[];
/** Learns a model from the .tsx files under dir (see learn.mjs). */
export function learn(dir: string, opts?: { root?: string; alias?: { prefix: string; target: string } | null; compilerOptions?: ts.CompilerOptions; declarations?: string[] }): Record<string, unknown>;
