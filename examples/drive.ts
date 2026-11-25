import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "drive", version: "0" } };

type Client = {
  request(method: string, params?: unknown): Promise<any>;
  notify(method: string): Promise<void>;
  close(): Promise<unknown>;
};

function stdio(env: Record<string, string> = {}): Client {
  const proc = Bun.spawn(["bun", server, "--mock"], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...process.env, ...env } });
  const pending = new Map<number, (msg: any) => void>();
  let nextId = 1;
  (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    }
  })();
  const write = (msg: unknown) => {
    proc.stdin.write(JSON.stringify(msg) + "\n");
    proc.stdin.flush();
  };
  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        write({ jsonrpc: "2.0", id, method, params });
      });
    },
    async notify(method) {
      write({ jsonrpc: "2.0", method });
    },
    close() {
      proc.stdin.end();
      return proc.exited;
    },
  };
}

async function http(token: string) {
  const proc = Bun.spawn(["bun", server, "--mock", "--http", "--port", "0"], {
    stdout: "inherit",
    stderr: "pipe",
    env: { ...process.env, COUNTER_HTTP_TOKEN: token },
  });
  const reader = proc.stderr.getReader();
  let log = "";
  while (!/listening on (\S+)/.test(log)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`server exited: ${log}`);
    log += new TextDecoder().decode(value);
  }
  process.stderr.write(log);
  const url = /listening on (\S+)/.exec(log)![1];
  let session: string | null = null;
  let nextId = 1;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "mcp-protocol-version": INIT.protocolVersion, ...(session ? { "mcp-session-id": session } : {}), ...headers },
      body: JSON.stringify(body),
    });
  const client: Client & { url: string; post: typeof post; session(): string | null } = {
    url,
    post,
    session: () => session,
    async request(method, params) {
      const res = await post({ jsonrpc: "2.0", id: nextId++, method, params });
      session = res.headers.get("mcp-session-id") ?? session;
      return res.json();
    },
    async notify(method) {
      const res = await post({ jsonrpc: "2.0", method });
      if (res.status !== 202) throw new Error(`notification got ${res.status}`);
    },
    async close() {
      await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${token}`, "mcp-session-id": session ?? "" } });
      proc.kill();
      return proc.exited;
    },
  };
  return client;
}

function check(ok: unknown, label: string) {
  if (!ok) {
    console.error(`FAIL ${label}`);
    process.exit(1);
  }
  console.log(`ok   ${label}`);
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await c.request("tools/call", { name, arguments: args });
  if (res.error) throw new Error(res.error.message);
  const text = res.result.content[0].text;
  return { isError: Boolean(res.result.isError), text, data: res.result.isError ? null : JSON.parse(text) };
}

async function readSuite(c: Client, t: string) {
  console.log(`\n== ${t}`);
  const init = await c.request("initialize", INIT);
  await c.notify("notifications/initialized");
  console.log(`server: ${init.result.serverInfo.name} ${init.result.serverInfo.version}, protocol ${init.result.protocolVersion}`);
  check(init.result.capabilities.prompts && init.result.capabilities.resources, `${t}: initialize advertises tools, resources and prompts`);

  const list = await c.request("tools/list");
  console.log(`tools: ${list.result.tools.map((x: any) => x.name).join(", ")}`);
  check(list.result.tools.length === 11, `${t}: tools/list returns 11 tools`);

  const locs = (await call(c, "list_locations")).data;
  console.log(locs.map((l: any) => `  ${l.id}  ${l.name}  ${l.timezone}`).join("\n"));
  check(locs.length === 2, `${t}: list_locations`);

  const lattes = (await call(c, "search_catalog", { query: "latte" })).data;
  check(lattes.length === 2, `${t}: search_catalog 'latte'`);

  const orders = (await call(c, "list_orders", { start: "2026-11-21", location_id: "LMAIN01", limit: 3 })).data;
  console.log(orders.orders.map((o: any) => `  ${o.id}  ${o.created_at}  $${o.total.toFixed(2)}  ${o.items.join(", ")}`).join("\n"));
  check(orders.count === 3 && orders.truncated && orders.timezone === "America/Chicago", `${t}: list_orders uses the location's time zone`);

  const order = (await call(c, "get_order", { order_id: orders.orders[0].id })).data;
  check(order.id === orders.orders[0].id && order.line_items.length > 0, `${t}: get_order round-trips an id from list_orders`);

  const day = (await call(c, "sales_summary", { period: "day", date: "2026-11-21" })).data;
  console.log(`  Sat 2026-11-21: ${day.orders} orders, gross $${day.gross_sales}, refunds $${day.refunds} (${day.refund_count}), net $${day.net_sales}, tax $${day.tax}, tips $${day.tips}`);
  check(day.refunds > 0 && day.net_sales < day.gross_sales - day.discounts, `${t}: sales_summary subtracts refunds from net sales`);

  const dst = (await call(c, "sales_summary", { period: "week", date: "2026-10-28" })).data;
  console.log(`  week ${dst.start}..${dst.end} ${dst.timezone}: ${dst.start_at} -> ${dst.end_at} = ${dst.hours} hours`);
  const net = Math.round(dst.by_day.reduce((s: number, d: any) => s + d.net_sales, 0) * 100) / 100;
  check(dst.hours === 169, `${t}: week across the DST change (Nov 1) is 169 hours`);
  check(dst.by_day.reduce((s: number, d: any) => s + d.orders, 0) === dst.orders && Math.abs(net - dst.net_sales) < 0.02, `${t}: per-day rows add up to the week`);

  const summer = (await call(c, "sales_summary", { date: "2026-07-04" })).data;
  const winter = (await call(c, "sales_summary", { date: "2026-12-05" })).data;
  check(summer.start_at.endsWith("T05:00:00.000Z") && winter.start_at.endsWith("T06:00:00.000Z"), `${t}: local midnight is 05:00Z in July and 06:00Z in December`);
  const fixed = (await call(c, "sales_summary", { date: "2026-07-04", timezone: "-06:00" })).data;
  check(fixed.start_at.endsWith("T06:00:00.000Z"), `${t}: a fixed offset still works when asked for`);
  const bad = await call(c, "sales_summary", { timezone: "Mars/Olympus" });
  check(bad.isError, `${t}: unknown time zone is refused`);

  const top = (await call(c, "top_items", { start: "2026-11-16", end: "2026-11-22", by: "revenue", limit: 3 })).data;
  console.log(top.items.map((i: any) => `  ${i.name}: $${i.revenue} (${Math.round(i.share * 100)}%), ${i.quantity} sold`).join("\n"));
  check(top.items.length === 3 && top.items[0].revenue >= top.items[1].revenue, `${t}: top_items by revenue`);
  const topQ = (await call(c, "top_items", { start: "2026-11-16", end: "2026-11-22", by: "quantity", limit: 3 })).data;
  check(topQ.items[0].quantity >= topQ.items[1].quantity, `${t}: top_items by quantity`);

  const heat = (await call(c, "hourly_heatmap", { start: "2026-11-16", end: "2026-11-22" })).data;
  const cells = heat.counts.flat().reduce((s: number, n: number) => s + n, 0);
  console.log(`  busiest: ${heat.busiest.map((b: any) => `${b.weekday} ${String(b.hour).padStart(2, "0")}:00 (${b.orders})`).join(", ")}`);
  const early = heat.counts.flatMap((row: number[]) => row.slice(0, 7)).reduce((s: number, n: number) => s + n, 0);
  check(heat.counts.length === 7 && cells === heat.orders && early === 0, `${t}: hourly_heatmap is 7x24, adds up, nothing before the 7am opening`);

  const low = (await call(c, "low_stock", { threshold: 10 })).data;
  console.log(low.items.map((r: any) => `  ${r.name} @ ${r.location}: ${r.in_stock}`).join("\n"));
  check(low.count > 0 && low.items.every((r: any) => r.in_stock < 10), `${t}: low_stock below 10`);

  const resources = await c.request("resources/list");
  check(resources.result.resources.some((r: any) => r.uri === "counter://low-stock"), `${t}: resources/list`);
  const read = await c.request("resources/read", { uri: "counter://low-stock" });
  check(JSON.parse(read.result.contents[0].text).length === low.count, `${t}: resources/read counter://low-stock matches low_stock`);

  const prompts = await c.request("prompts/list");
  check(prompts.result.prompts[0].name === "daily-brief", `${t}: prompts/list has daily-brief`);
  const brief = await c.request("prompts/get", { name: "daily-brief", arguments: { date: "2026-11-21" } });
  const text = brief.result.messages[0].content.text;
  console.log(text.split("\n").slice(0, 2).map((l: string) => `  ${l}`).join("\n"));
  check(text.includes(`"net_sales": ${day.net_sales}`) && text.includes("Low stock"), `${t}: daily-brief prompt carries the day's summary and low stock`);
  const yesterday = await c.request("prompts/get", { name: "daily-brief" });
  check(yesterday.result.description.startsWith("Daily brief for "), `${t}: daily-brief defaults to yesterday (${yesterday.result.description.slice(16)})`);

  const blocked = await call(c, "adjust_inventory", { variation_id: "VAR_CROIS", location_id: "LMAIN01", quantity_delta: 12, confirm: true });
  check(blocked.isError, `${t}: writes refused without COUNTER_ALLOW_WRITES=1`);
}

const s = stdio();
await readSuite(s, "stdio");
await s.close();

const token = crypto.randomUUID();
const h = await http(token);
await readSuite(h, "http");

console.log("\n== http transport rules");
const sid = h.session();
const noToken = await fetch(h.url, { method: "POST", headers: { "content-type": "application/json", "mcp-session-id": sid! }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
check(noToken.status === 401, `request without the bearer token gets 401`);
const foreign = await h.post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://example.com" });
check(foreign.status === 403, `request from a foreign Origin gets 403`);
const noSession = await fetch(h.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
check(noSession.status === 400, `request without Mcp-Session-Id gets 400`);
const get = await fetch(h.url, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } });
check(get.status === 405, `GET (no server stream) gets 405`);
const batch = await h.post([{ jsonrpc: "2.0", id: 7, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 8, method: "tools/list" }]);
const batchBody = await batch.json();
check(Array.isArray(batchBody) && batchBody.length === 2, `batch of 3 (one notification) returns 2 replies`);
await fetch(h.url, { method: "DELETE", headers: { authorization: `Bearer ${token}`, "mcp-session-id": sid! } });
const ended = await h.post({ jsonrpc: "2.0", id: 1, method: "ping" });
check(ended.status === 404, `DELETE ends the session; later requests get 404`);
await h.close();

console.log("\n== writes (stdio, COUNTER_ALLOW_WRITES=1)");
const w = stdio({ COUNTER_ALLOW_WRITES: "1" });
await w.request("initialize", INIT);
const unconfirmed = await call(w, "create_catalog_item", { name: "Pumpkin Loaf", price: 4.25 });
console.log(`  ${unconfirmed.text}`);
check(unconfirmed.isError, "writes refused without confirm: true");
const created = (await call(w, "create_catalog_item", { name: "Pumpkin Loaf", price: 4.25, confirm: true })).data;
check(created.created.variations[0].price === 4.25, "create_catalog_item with confirm");
check((await call(w, "search_catalog", { query: "pumpkin" })).data.length === 1, "new item is searchable");
const before = (await call(w, "inventory_counts", { location_id: "LMAIN01", variation_ids: ["VAR_CROIS"] })).data[0].in_stock;
const after = (await call(w, "adjust_inventory", { variation_id: "VAR_CROIS", location_id: "LMAIN01", quantity_delta: 12, confirm: true })).data;
check(after.counts[0].quantity === before + 12, `adjust_inventory ${before} -> ${after.counts[0].quantity}`);
await w.close();

console.log("\nall checks passed");
