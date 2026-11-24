#!/usr/bin/env bun
import { mockBackend } from "./mock";
import { liveBackend, SquareError } from "./square";
import { buildTools, callTool, ToolError } from "./tools";

const VERSION = "0.1.0";
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`counter ${VERSION}: an MCP server for a Square account, over stdio.

  counter            use SQUARE_ACCESS_TOKEN (SQUARE_ENV=sandbox|production, default sandbox)
  counter --mock     serve fixture data for a small coffee shop, no account needed

Write tools need COUNTER_ALLOW_WRITES=1 and confirm: true on each call.`);
  process.exit(0);
}

const mock = argv.includes("--mock") || process.env.COUNTER_MOCK === "1";
let backend;
try {
  backend = mock ? mockBackend() : liveBackend();
} catch (e) {
  console.error(`counter: ${(e as Error).message}`);
  process.exit(1);
}
const allowWrites = process.env.COUNTER_ALLOW_WRITES === "1";
const tools = buildTools(backend, allowWrites);

console.error(`counter ${VERSION} ready (${mock ? "mock" : `square ${process.env.SQUARE_ENV ?? "sandbox"}`}, writes ${allowWrites ? "allowed with confirm" : "disabled"})`);

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(msg: any): Promise<unknown> {
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "counter", version: VERSION },
        instructions: "Read tools are always on. create_catalog_item and adjust_inventory change the business's Square account: ask the owner first, then pass confirm: true.",
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: !t.write, destructiveHint: Boolean(t.write), openWorldHint: !mock },
        })),
      };
    case "tools/call": {
      const { name, arguments: args = {} } = msg.params ?? {};
      try {
        const result = await callTool(tools, allowWrites, name, args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        if (e instanceof ToolError || e instanceof SquareError) return { isError: true, content: [{ type: "text", text: e.message }] };
        throw e;
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
  }
}

async function onLine(line: string) {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  if (msg.id === undefined || msg.id === null) return;
  try {
    send({ jsonrpc: "2.0", id: msg.id, result: await handle(msg) });
  } catch (e: any) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? -32603, message: e.message ?? String(e) } });
  }
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    await onLine(line);
  }
}
if (buffer.trim()) await onLine(buffer);
