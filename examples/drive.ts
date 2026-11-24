import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../src/server.ts", import.meta.url));

function start(env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", server, "--mock"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, ...env },
  });
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
    request(method: string, params?: unknown): Promise<any> {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        write({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method: string) {
      write({ jsonrpc: "2.0", method });
    },
    async call(name: string, args: Record<string, unknown> = {}) {
      const res = await this.request("tools/call", { name, arguments: args });
      if (res.error) throw new Error(res.error.message);
      const text = res.result.content[0].text;
      return { isError: Boolean(res.result.isError), text, data: res.result.isError ? null : JSON.parse(text) };
    },
    close() {
      proc.stdin.end();
      return proc.exited;
    },
  };
}

function check(ok: unknown, label: string) {
  if (!ok) {
    console.error(`FAIL ${label}`);
    process.exit(1);
  }
  console.log(`ok   ${label}`);
}

const c = start();
const init = await c.request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "drive", version: "0" },
});
c.notify("notifications/initialized");
console.log(`server: ${init.result.serverInfo.name} ${init.result.serverInfo.version}, protocol ${init.result.protocolVersion}`);

const list = await c.request("tools/list");
console.log(`tools: ${list.result.tools.map((t: any) => t.name).join(", ")}`);
check(list.result.tools.length === 8, "tools/list returns 8 tools");

const locs = (await c.call("list_locations")).data;
console.log(locs.map((l: any) => `  ${l.id}  ${l.name}`).join("\n"));
check(locs.length === 2, "list_locations");

const lattes = (await c.call("search_catalog", { query: "latte" })).data;
console.log(lattes.map((i: any) => `  ${i.name}: ${i.variations.map((v: any) => `${v.name} $${v.price.toFixed(2)}`).join(", ")}`).join("\n"));
check(lattes.length === 2, "search_catalog 'latte'");

const orders = (await c.call("list_orders", { start: "2026-11-21", location_id: "LMAIN01", limit: 3 })).data;
console.log(orders.orders.map((o: any) => `  ${o.id}  $${o.total.toFixed(2)}  ${o.items.join(", ")}`).join("\n"));
check(orders.count === 3 && orders.truncated, "list_orders with limit");

const order = (await c.call("get_order", { order_id: orders.orders[0].id })).data;
check(order.id === orders.orders[0].id && order.line_items.length > 0, "get_order round-trips an id from list_orders");

const day = (await c.call("sales_summary", { period: "day", date: "2026-11-21" })).data;
console.log(`  Sat 2026-11-21: ${day.orders} orders, net $${day.net_sales.toFixed(2)}, tips $${day.tips.toFixed(2)}, avg ticket $${day.average_ticket.toFixed(2)}`);
console.log(`  top: ${day.top_items.map((i: any) => `${i.name} x${i.quantity}`).join(", ")}`);
check(day.orders > 0 && day.net_sales > 0, "sales_summary day");

const week = (await c.call("sales_summary", { period: "week", date: "2026-11-18" })).data;
console.log(`  week ${week.start}..${week.end}: ${week.orders} orders, net $${week.net_sales.toFixed(2)}`);
console.log(week.by_day.map((d: any) => `    ${d.date}  ${String(d.orders).padStart(3)} orders  $${d.net_sales.toFixed(2)}`).join("\n"));
const dayTotal = week.by_day.reduce((s: number, d: any) => s + d.orders, 0);
check(week.by_day.length === 7 && dayTotal === week.orders, "sales_summary week, per-day rows add up");

const low = (await c.call("inventory_counts", { location_id: "LKIOSK02", low_stock_below: 10 })).data;
console.log(low.map((r: any) => `  ${r.name}: ${r.in_stock}`).join("\n"));
check(low.every((r: any) => r.in_stock < 10), "inventory_counts low stock filter");

const blocked = await c.call("adjust_inventory", { variation_id: "VAR_CROIS", location_id: "LMAIN01", quantity_delta: 12, confirm: true });
console.log(`  ${blocked.text}`);
check(blocked.isError, "writes refused without COUNTER_ALLOW_WRITES=1");
await c.close();

const w = start({ COUNTER_ALLOW_WRITES: "1" });
await w.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "drive", version: "0" } });
const unconfirmed = await w.call("create_catalog_item", { name: "Pumpkin Loaf", price: 4.25 });
console.log(`  ${unconfirmed.text}`);
check(unconfirmed.isError, "writes refused without confirm: true");

const created = (await w.call("create_catalog_item", { name: "Pumpkin Loaf", price: 4.25, confirm: true })).data;
check(created.created.variations[0].price === 4.25, "create_catalog_item with confirm");
const found = (await w.call("search_catalog", { query: "pumpkin" })).data;
check(found.length === 1, "new item is searchable");

const before = (await w.call("inventory_counts", { location_id: "LMAIN01", variation_ids: ["VAR_CROIS"] })).data[0].in_stock;
const after = (await w.call("adjust_inventory", { variation_id: "VAR_CROIS", location_id: "LMAIN01", quantity_delta: 12, confirm: true })).data;
check(after.counts[0].quantity === before + 12, `adjust_inventory ${before} -> ${after.counts[0].quantity}`);
await w.close();

console.log("all checks passed");
