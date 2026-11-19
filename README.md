# jsxpand

Type an abbreviation in JSX and get the code **your own project** would write. It's like Emmet,
except it learns from your codebase: its components, how they nest, their props, text and
imports, and the hooks and declarations that code needs.

```
frm>usr+eml+btn   →   a react-hook-form form with your project's own zod schema,
                      useForm at the top of the component, imports merged in
```

- **VS Code extension:** [`vscode/`](vscode/) (also on Open VSX for Cursor, Windsurf and VSCodium).
- **How it works:** each abbreviation has many readings (`cardhdrttlcont` could be Card › CardHeader ›
  CardTitle + CardContent, or something else). Each reading is scored by a model of how people
  shorten words and by how often your code puts one component inside another. A dynamic
  program over the abbreviation ([@vhalaharvi/dyna](https://www.npmjs.com/package/@vhalaharvi/dyna))
  finds the best few, counts every reading, and adds up their probabilities in one pass.
- **What it reads:** only your folder and what you've installed. Your code teaches it how you build
  things. Every component your files and your React dependencies export (from their public entry
  points) can be offered. Nothing else, nothing over the network.

## Layout

| path | what |
|---|---|
| `src/engine.ts` | the expander: abbreviation model, search, rendering, declarations |
| `src/learn.mjs` | the learner: reads a project with the TypeScript compiler |
| `vscode/` | the editor extension: worker, completions, placing each piece in the file |
| `test/` | tests, including type-checking generated code inside real projects |
| `page/` | browser demos (sample components, and a dashboard project) |

## Develop

```bash
npm install
npm test                                   # unit tests
JSXPAND_PROJECTS=~/src/real npm test       # plus real projects (see test/insert.test.ts)
cd vscode && npm install && npm run package  # builds jsxpand-<version>.vsix
```

## Credits

The dashboard demo and its tests use [shadcn-admin](https://github.com/satnaing/shadcn-admin)
(MIT, © 2024 Sat Naing): `real-ui/` holds its components (with its license), and
`src/model-admin.json` was learned from it. The extension itself ships nothing learned from it.

MIT © Vinod Halaharvi
