#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { timingSafeEqual } from "node:crypto";
import { createMcp, VERSION } from "./mcp";
import { mockBackend } from "./mock";
import { liveBackend } from "./square";

const help = `counter ${VERSION}: an MCP server for a Square account.

  counter                       stdio, using SQUARE_ACCESS_TOKEN (SQUARE_ENV=sandbox|production)
  counter --mock                fixture data for a small coffee shop, no account needed
  counter --http [--port 8765]  Streamable HTTP on http://127.0.0.1:<port>/mcp
          [--token secret]      require Authorization: Bearer <secret> (or set COUNTER_HTTP_TOKEN)

Write tools need COUNTER_ALLOW_WRITES=1 and confirm: true on each call.`;

function fail(msg: string): never {
  console.error(`counter: ${msg}`);
  process.exit(1);
}

let opts;
try {
  opts = parseArgs({
    args: process.argv.slice(2),
    options: {
      mock: { type: "boolean", default: false },
      http: { type: "boolean", default: false },
      port: { type: "string", default: "8765" },
      token: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  }).values;
} catch (e) {
  fail(`${(e as Error).message}\n\n${help}`);
}
if (opts.help) {
  console.log(help);
  process.exit(0);
}

const mock = opts.mock || process.env.COUNTER_MOCK === "1";
let backend;
try {
  backend = mock ? mockBackend() : liveBackend();
} catch (e) {
  fail((e as Error).message);
}
const allowWrites = process.env.COUNTER_ALLOW_WRITES === "1";
const respond = createMcp(backend, allowWrites);
const mode = `${mock ? "mock" : `square ${process.env.SQUARE_ENV ?? "sandbox"}`}, writes ${allowWrites ? "allowed with confirm" : "disabled"}`;

if (opts.http) serveHttp();
else await serveStdio();

async function serveStdio() {
  console.error(`counter ${VERSION} ready on stdio (${mode})`);
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const onLine = async (line: string) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const out = await respond(msg);
    if (out) send(out);
  };
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
}

function serveHttp() {
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port must be 0-65535, got ${opts.port}`);
  const token = opts.token ?? process.env.COUNTER_HTTP_TOKEN;
  const expected = token ? Buffer.from(`Bearer ${token}`) : null;
  const sessions = new Set<string>();
  const local = new Set(["localhost", "127.0.0.1", "[::1]"]);

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const rpcError = (status: number, code: number, message: string, headers?: Record<string, string>) =>
    json(status, { jsonrpc: "2.0", id: null, error: { code, message } }, headers);

  function authorized(req: Request) {
    if (!expected) return true;
    const got = Buffer.from(req.headers.get("authorization") ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  function allowedOrigin(req: Request) {
    const origin = req.headers.get("origin");
    if (!origin) return true;
    try {
      return local.has(new URL(origin).hostname) || local.has(`[${new URL(origin).hostname}]`);
    } catch {
      return false;
    }
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/mcp") return new Response("Not found. The MCP endpoint is /mcp.\n", { status: 404 });
      if (!allowedOrigin(req)) return rpcError(403, -32000, "Origin not allowed");
      if (!authorized(req)) return rpcError(401, -32001, "Unauthorized", { "www-authenticate": 'Bearer realm="counter"' });
      const sid = req.headers.get("mcp-session-id");

      if (req.method === "DELETE") {
        if (!sid || !sessions.delete(sid)) return rpcError(404, -32001, "Session not found");
        return new Response(null, { status: 204 });
      }
      if (req.method !== "POST") return new Response("Method not allowed. counter has no server-to-client stream; POST JSON-RPC to /mcp.\n", { status: 405, headers: { allow: "POST, DELETE" } });
      if (!(req.headers.get("content-type") ?? "").includes("application/json")) return rpcError(415, -32700, "Content-Type must be application/json");

      let body: any;
      try {
        body = await req.json();
      } catch {
        return rpcError(400, -32700, "Parse error");
      }
      const batch = Array.isArray(body);
      const messages: any[] = batch ? body : [body];
      if (!messages.length) return rpcError(400, -32600, "Empty batch");
      const initializing = messages.some((m) => m?.method === "initialize");
      const headers: Record<string, string> = {};
      if (initializing) {
        if (messages.length > 1) return rpcError(400, -32600, "initialize must be sent on its own");
        const id = crypto.randomUUID();
        sessions.add(id);
        headers["mcp-session-id"] = id;
      } else if (!sid) {
        return rpcError(400, -32000, "Missing Mcp-Session-Id header. Send initialize first.");
      } else if (!sessions.has(sid)) {
        return rpcError(404, -32001, "Session not found. Initialize again.");
      }

      const replies = (await Promise.all(messages.map(respond))).filter(Boolean);
      if (!replies.length) return new Response(null, { status: 202, headers });
      return json(200, batch ? replies : replies[0], headers);
    },
  });

  console.error(`counter ${VERSION} listening on http://127.0.0.1:${server.port}/mcp (${mode}, ${expected ? "bearer token required" : "no token"})`);
}
