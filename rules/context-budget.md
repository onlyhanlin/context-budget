# context-budget — routing rules

A sandbox and a searchable index are available. They exist because every byte a
tool returns enters the conversation and is re-sent on every later turn.

The point is simple: **program the analysis, do not perform it by reading raw
data into the conversation.**

## Think in Code

To count, filter, aggregate, parse, compare, transform or search data — write
code and `console.log()` only the answer.

```js
// Instead of reading 40 files to count something:
ctx_execute("javascript", \`
  const fs = require("node:fs");
  const files = fs.readdirSync("src").filter(f => f.endsWith(".ts"));
  for (const f of files) {
    const n = (fs.readFileSync("src/" + f, "utf8").match(/deprecatedApi/g) || []).length;
    if (n) console.log(f + ": " + n);
  }
\`)
```

One script replaces ten tool calls, and the raw files never enter context.

## Tool selection, in order

| Order | Tool | Use it for |
|---|---|---|
| 1 | `ctx_batch(tasks, queries)` | Primary research. Several commands in ONE call; outputs are indexed and your questions answered in the same round trip. |
| 2 | `ctx_search(queries)` | Follow-ups about anything already indexed. Batch every question into one array. |
| 3 | `ctx_execute(language, code)` | Derive an answer from data. Only stdout returns. |
| 4 | `ctx_execute_file(path, language, code)` | Analyze one workspace file. Content arrives as the variable `content`. |
| 5 | `ctx_index(source, content)` | Store a document for later instead of pasting it in. |

## When NOT to use the sandbox

- **You are about to EDIT a file** → use the native read tool. The editor needs
  the exact bytes in context to match against.
- **The output is short and you already know it** (`pwd`, `git status` on a
  clean tree, `whoami`) → run it directly; the sandbox adds overhead.
- **The command changes state** (`git commit`, `npm install`, `mkdir`) → native
  tool, so the user sees and approves it. The sandbox runs in your project with
  your permissions; it is a context boundary, not a filesystem jail.
- **You need a browser interaction**, not a page fetch → native browser tool.

## Web fetches

Prefer `ctx_execute` over the native page-fetch tool. It has full network
access and only what you `console.log()` enters the conversation:

```js
ctx_execute("javascript", \`
  const res = await fetch("https://example.com/spec");
  const html = await res.text();
  console.log(html.match(/<h2[^>]*>(.*?)<\\/h2>/g)?.slice(0, 20).join("\\n") ?? "no headings");
\`)
```

If you will need the whole document for several later questions, fetch it once
and `ctx_index` it rather than returning it.

## Output discipline

- Large artifacts go to files. Return a path plus a one-line description.
- When an answer is long, prefer writing it to a file and reporting the path.
