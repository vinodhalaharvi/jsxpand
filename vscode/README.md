# jsxpand

Type an abbreviation in JSX and get the code **your own project** would write: its components,
its props, its text, and the imports, hooks, schemas and props that code needs, each put where it
belongs in the file.

```
frm>usr+eml+btn
```

Inside a component, that becomes a react-hook-form form with your project's own zod schema and
messages. The schema lands above the component, `useForm` at the top of it, the imports merge
into the ones you have, and the JSX goes at the cursor.

## How it works

- **It learns from the open workspace.** It reads every `.tsx` file under `src/` (or the whole workspace when there's no `src/`): which
  component goes inside which, the props and text each one usually gets, and how each name the
  JSX reads is declared. With `node_modules` installed it also reads the types, for required
  props and for components that take no children. That takes a few seconds, in the background.
  The result is cached, and it learns again a minute after you save.
- **Abbreviations are scored, not looked up.** `cardhdrttlcont` has many readings. Each one is
  scored by how a person shortens words (keeping consonants more than vowels) and by how often
  your code puts one component inside another. The best few are offered, with the share of
  the total each one takes and the reasons for it.
- **The search is a dynamic program.** It runs on [@vhalaharvi/dyna](https://www.npmjs.com/package/@vhalaharvi/dyna),
  which finds the best readings, counts them all and adds up their probabilities in one pass.
- **Small projects borrow general knowledge.** jsxpand ships with what shadcn/ui-style code generally
  looks like (Card holds CardHeader and CardContent; SelectItem goes inside SelectContent). It
  adds that, at a fraction of the weight of your own code, for the components your project has.
- **It works offline and gives the same answer every time.** Nothing leaves your machine.

## Writing abbreviations

| you type | means |
|---|---|
| `cardhdr` | pieces of names, run together: Card, CardHeader |
| `a>b` | b inside a |
| `a+b` | b beside a |
| `a^b` | b one level up |
| `itm*3` | three of them |
| `btn.out` | a prop value: `variant="outline"` |

At the top level of a file, an abbreviation expands to a whole new component.

## Settings

- `jsxpand.results`: how many readings to offer (default 3).
- `jsxpand.sourceFolder`: the folder to learn from, if it isn't `src/` or the whole workspace.
- **jsxpand: Learn this workspace again**: run it after big changes (or click the status bar).

## Limits

- It knows what your project does, plus general shadcn/ui patterns. Outside those it has little
  to go on.
- It's React (JSX/TSX) only for now.
- A name nothing declares becomes a prop of the component you're in, typed `any` when its type
  can't be written on its own.

## Credits

The built-in patterns were learned from [shadcn-admin](https://github.com/satnaing/shadcn-admin)
(MIT, © 2024 Sat Naing) and a set of sample components.
