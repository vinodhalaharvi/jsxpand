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

- **It reads only your folder and what it has installed.**
  - Your code (`.tsx` under `src/`, or the whole workspace when there's no `src/`) shows how *you*
    build things: which component goes inside which, and the props, text and imports you use.
  - Every component your files export, and every component your React dependencies export from
    their public entry points (as each package declares them in its `package.json`), can be offered,
    even if you've never used it. Never-used ones rank at the bottom and come with the props their
    types require. Anything a library marks `@internal` is left out.
  - Nothing else: no built-in patterns, no other repos, no network. It learns in a few seconds in the
    background, caches the result, and learns again a minute after you save.
- **Abbreviations are scored, not looked up.** `cardhdrttlcont` has many readings. Each one is
  scored by how a person shortens words (keeping consonants more than vowels) and by how often
  your code puts one component inside another. The best few are offered, with the share of
  the total each one takes and the reasons for it.
- **The search is a dynamic program.** It runs on [@vhalaharvi/dyna](https://www.npmjs.com/package/@vhalaharvi/dyna),
  which finds the best readings, counts them all and adds up their probabilities in one pass.
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

- It knows only what your project does and what it has installed. A component you've never used
  is offered (at the bottom) with its required props, but without a learned shape.
- It's React (JSX/TSX) only for now.
- A name nothing declares becomes a prop of the component you're in, typed `any` when its type
  can't be written on its own.
