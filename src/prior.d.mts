type M = Record<string, unknown>;
/** The prior from learned models: library components, literal props and text only. */
export function makePrior(models: M[]): M;
/** A project's model with the prior added at weight w, for the components the project has. */
export function withPrior(project: M, prior: M, resolve: (module: string) => string | null, w?: number): M;
