import { SquareError, type Backend } from "./square";
import { buildTools, callTool, dailyBriefData, lowStockData, ToolError } from "./tools";

export const VERSION = "0.2.0";
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const RESOURCES = [
  { uri: "counter://locations", name: "locations", description: "Every location with id, time zone and currency.", mimeType: "application/json" },
  { uri: "counter://low-stock", name: "low-stock", description: "Tracked variations with fewer than 10 in stock, lowest first.", mimeType: "application/json" },
];

const PROMPTS = [
  {
    name: "daily-brief",
    description: "A short morning brief for the owner: yesterday's sales (net of refunds) and what is running low.",
    arguments: [
      { name: "location_id", description: "One location. Default: all active locations.", required: false },
      { name: "date", description: "Day to report, YYYY-MM-DD. Default: yesterday in the location's time zone.", required: false },
      { name: "threshold", description: "Low stock means fewer than this many. Default 10.", required: false },
    ],
  },
];

export class RpcError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

export function createMcp(backend: Backend, allowWrites: boolean) {
  const tools = buildTools(backend, allowWrites);
  const live = backend.mode === "live";

  async function readResource(uri: string) {
    if (uri === "counter://locations") return tools.find((t) => t.name === "list_locations")!.run({});
    if (uri === "counter://low-stock") return lowStockData(backend, 10);
    throw new RpcError(-32002, `Resource not found: ${uri}`);
  }

  async function getPrompt(name: string, args: Record<string, string> = {}) {
    if (name !== "daily-brief") throw new RpcError(-32602, `Unknown prompt: ${name}`);
    const threshold = args.threshold === undefined ? undefined : Number(args.threshold);
    if (threshold !== undefined && !(threshold > 0)) throw new RpcError(-32602, "threshold must be a positive number");
    const data = await dailyBriefData(backend, { location_id: args.location_id || undefined, date: args.date || undefined, threshold });
    const text = [
      `Write a short morning brief for the owner of this shop about ${data.date} (${data.summary.timezone}).`,
      "Lead with net sales and the order count, mention refunds if there were any, name the top sellers, then list what to reorder today. Plain sentences, no more than eight lines. Do not invent numbers that are not below.",
      "",
      "Sales summary:",
      JSON.stringify(data.summary, null, 2),
      "",
      `Low stock (fewer than ${data.threshold}):`,
      JSON.stringify(data.low_stock, null, 2),
    ].join("\n");
    return { description: `Daily brief for ${data.date}`, messages: [{ role: "user", content: { type: "text", text } }] };
  }

  async function handle(msg: any): Promise<unknown> {
    const p = msg.params ?? {};
    switch (msg.method) {
      case "initialize":
        return {
          protocolVersion: PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: "counter", version: VERSION },
          instructions: "Read tools are always on. create_catalog_item and adjust_inventory change the business's Square account: ask the owner first, then pass confirm: true.",
        };
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { readOnlyHint: !t.write, destructiveHint: Boolean(t.write), openWorldHint: live },
          })),
        };
      case "tools/call":
        try {
          const result = await callTool(tools, allowWrites, p.name, p.arguments ?? {});
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
          if (e instanceof ToolError || e instanceof SquareError) return { isError: true, content: [{ type: "text", text: e.message }] };
          throw e;
        }
      case "resources/list":
        return { resources: RESOURCES };
      case "resources/templates/list":
        return { resourceTemplates: [] };
      case "resources/read":
        return { contents: [{ uri: p.uri, mimeType: "application/json", text: JSON.stringify(await readResource(p.uri), null, 2) }] };
      case "prompts/list":
        return { prompts: PROMPTS };
      case "prompts/get":
        try {
          return await getPrompt(p.name, p.arguments);
        } catch (e) {
          if (e instanceof ToolError || e instanceof SquareError) throw new RpcError(-32602, e.message);
          throw e;
        }
      default:
        throw new RpcError(-32601, `Method not found: ${msg.method}`);
    }
  }

  return async function respond(msg: any): Promise<object | null> {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid request" } };
    if (msg.id === undefined || msg.id === null || !msg.method) return null;
    try {
      return { jsonrpc: "2.0", id: msg.id, result: await handle(msg) };
    } catch (e: any) {
      return { jsonrpc: "2.0", id: msg.id, error: { code: e instanceof RpcError ? e.code : -32603, message: e?.message ?? String(e) } };
    }
  };
}
