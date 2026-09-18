/**
 * MCP server wiring.
 *
 * stdout is the JSON-RPC channel — nothing else may ever be written to it.
 * All diagnostics go to stderr via `log()`.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { VERSION, storageRoot, projectRoot } from "./config.mjs";
import { ctxExecute, ctxExecuteFile, ctxBatch, ctxIndex, ctxSearch, ctxStats, ctxDoctor } from "./tools.mjs";
import { supportedLanguages } from "./sandbox.mjs";

export function log(...parts) {
  process.stderr.write(`[context-budget] ${parts.join(" ")}\n`);
}

const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });

export const TOOL_DEFS = [
  {
    name: "ctx_execute",
    description:
      "Run code in an isolated subprocess. ONLY stdout returns to the conversation; file contents, logs and API payloads the script touches never enter context.\n\n" +
      "USE THIS when you intend to PROCESS data — filter, count, aggregate, parse, transform, compare, search. Program the analysis instead of computing it by reading raw data into context.\n\n" +
      "DO NOT USE for: editing files (use the native edit tool so the change is visible and approved), running state-changing commands (git commit, npm install), or observing a short fixed output you already know is small.\n\n" +
      "The script may read files and make network calls. Add \"intent\" when the output may be large and you want only the matching sections back.",
    inputSchema: {
      type: "object",
      properties: {
        language: { ...str(`Runtime. One of: ${supportedLanguages().join(", ")}.`), default: "javascript" },
        code: str("The program to run. console.log() only the answer."),
        intent: str("Optional. What you are looking for. If output is large it is indexed and only matching sections are returned."),
        timeout_ms: num("Wall-clock budget. Default 30000."),
        max_output_bytes: num("Cap on returned stdout. Default 8192."),
      },
      required: ["language", "code"],
    },
  },
  {
    name: "ctx_execute_file",
    description:
      "Read a workspace file inside the sandbox and analyze it with code. The file's contents are bound to the variable `content` (and its path to `filePath`); only what you console.log() enters the conversation.\n\n" +
      "USE THIS whenever you intend to analyze, summarize, extract from or count within a file. A 50 KB file costs roughly 13,000 tokens if read directly.\n\n" +
      "DO NOT USE when you intend to EDIT the file — the editor needs the exact bytes in context to match against. Use the native read tool for that.",
    inputSchema: {
      type: "object",
      properties: {
        path: str("Workspace-relative (or absolute, inside the workspace) path to the file."),
        language: { ...str("Runtime. Defaults to javascript."), default: "javascript" },
        code: str("Analysis code. `content` holds the file text, `filePath` its absolute path."),
        timeout_ms: num("Wall-clock budget. Default 30000."),
        max_output_bytes: num("Cap on returned stdout. Default 8192."),
      },
      required: ["path", "language", "code"],
    },
  },
  {
    name: "ctx_batch",
    description:
      "Run several shell commands in ONE call, index every output, and answer your questions about them in the same round trip. One call replaces ten.\n\n" +
      "USE THIS as the primary research tool: git history, test runs, build output, log scans, API queries, multi-file greps. Pass queries and the matching sections come back with the run results.\n\n" +
      "Set concurrency to 4-8 for I/O-bound work (network, multiple repos). Leave it at 1 for CPU-bound work (build, test, lint) or commands sharing state.\n\n" +
      "Commands that would be catastrophic are refused before execution.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "Each entry: { label, command }. The label becomes the searchable section title, so make it descriptive.",
          items: {
            type: "object",
            properties: { label: str("Short descriptive header."), command: str("Shell command."), cwd: str("Optional working directory inside the workspace.") },
            required: ["label", "command"],
          },
        },
        queries: { type: "array", items: { type: "string" }, description: "Questions to answer from the captured output. Batched into one search." },
        concurrency: num("1-8. Default 1."),
        timeout_ms: num("Per-command budget. Default 30000."),
      },
      required: ["tasks"],
    },
  },
  {
    name: "ctx_index",
    description:
      "Store a document in the searchable knowledge base instead of pasting it into the conversation. Web pages, issue threads, specs, long logs.\n\n" +
      "Content is chunked by heading with code blocks kept intact, then indexed for ctx_search. The raw text never enters context — only this confirmation does.",
    inputSchema: {
      type: "object",
      properties: {
        source: str("Short stable label, e.g. \"react-useEffect-docs\" or a URL. Used to filter and to replace on re-index."),
        content: str("The document text (markdown preferred)."),
        title: str("Optional title for the whole document."),
      },
      required: ["source", "content"],
    },
  },
  {
    name: "ctx_search",
    description:
      "Search everything already indexed — earlier captures, session memory, documents. Ask every related question in ONE call as an array.\n\n" +
      "Returns smart snippets extracted around your query terms, not whole documents.",
    inputSchema: {
      type: "object",
      properties: {
        queries: { type: "array", items: { type: "string" }, description: "All your questions, batched." },
        source: str("Optional. Restrict to one indexed source."),
        limit: num("Candidates per query before dedup. Default 6."),
        per_query: num("Max results per source per query. Default 2."),
        mode: str("\"and\" (default, precise) or \"or\" (broad)."),
      },
      required: ["queries"],
    },
  },
  {
    name: "ctx_stats",
    description: "Show how many bytes and tokens this tooling has kept out of the context window, per tool and in total.",
    inputSchema: { type: "object", properties: { session: { type: "boolean", description: "Only this session instead of project lifetime." } } },
  },
  {
    name: "ctx_doctor",
    description: "Diagnose the installation: available runtimes, SQLite/FTS5, storage paths, workspace.",
    inputSchema: { type: "object", properties: {} },
  },
];

const HANDLERS = {
  ctx_execute: ctxExecute,
  ctx_execute_file: ctxExecuteFile,
  ctx_batch: ctxBatch,
  ctx_index: ctxIndex,
  ctx_search: ctxSearch,
  ctx_stats: ctxStats,
  ctx_doctor: ctxDoctor,
};

export function createServer() {
  const server = new Server(
    { name: "context-budget", version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params?.name;
    const args = request.params?.arguments ?? {};
    const handler = HANDLERS[name];
    if (!handler) {
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    }
    try {
      const text = await handler(args);
      return { content: [{ type: "text", text: String(text) }] };
    } catch (error) {
      log(`tool ${name} threw:`, error?.stack ?? String(error));
      return {
        content: [{ type: "text", text: `${name} failed: ${error?.message ?? String(error)}` }],
        isError: true,
      };
    }
  });

  return server;
}

export async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready · v${VERSION} · project ${projectRoot()} · storage ${storageRoot()}`);
}
