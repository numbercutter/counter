import type { Backend } from "./square";

type Args = Record<string, any>;
type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  write?: boolean;
  run: (args: Args) => Promise<unknown>;
};

export class ToolError extends Error {}

const DATE = "YYYY-MM-DD, or a full RFC 3339 timestamp";
const offsetSchema = {
  type: "string",
  description: "UTC offset used to turn dates into day boundaries, like -06:00. Default +00:00.",
  pattern: "^[+-]\\d{2}:\\d{2}$",
};

const cents = (m: any) => (m && typeof m.amount === "number" ? m.amount : 0);
const major = (c: number) => Math.round(c) / 100;

function boundary(value: string, offset: string, end = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (Number.isNaN(Date.parse(value))) throw new ToolError(`Not a date: ${value}`);
    return new Date(value).toISOString();
  }
  const t = Date.parse(`${value}T00:00:00${offset === "+00:00" ? "Z" : offset}`);
  if (Number.isNaN(t)) throw new ToolError(`Not a date: ${value}`);
  return new Date(t + (end ? 86400000 : 0)).toISOString();
}

function localDay(iso: string, offset: string) {
  const sign = offset.startsWith("-") ? -1 : 1;
  const [h, m] = offset.slice(1).split(":").map(Number);
  return new Date(Date.parse(iso) + sign * (h * 60 + m) * 60000).toISOString().slice(0, 10);
}

function today(offset: string) {
  return localDay(new Date().toISOString(), offset);
}

function shapeItem(o: any) {
  const d = o.item_data ?? {};
  return {
    id: o.id,
    name: d.name,
    description: d.description || undefined,
    categories: (d.categories ?? []).map((c: any) => c.name ?? c.id),
    variations: (d.variations ?? []).map((v: any) => {
      const vd = v.item_variation_data ?? {};
      return {
        id: v.id,
        name: vd.name,
        price: vd.price_money ? major(vd.price_money.amount) : null,
        currency: vd.price_money?.currency,
        sku: vd.sku,
        track_inventory: vd.track_inventory ?? false,
      };
    }),
  };
}

function shapeOrder(o: any, full = false) {
  const base = {
    id: o.id,
    location_id: o.location_id,
    state: o.state,
    created_at: o.created_at,
    currency: o.total_money?.currency,
    total: major(cents(o.total_money)),
    tax: major(cents(o.total_tax_money)),
    tip: major(cents(o.total_tip_money)),
    discount: major(cents(o.total_discount_money)),
    items: (o.line_items ?? []).map((l: any) => `${l.quantity}x ${l.name}${l.variation_name ? ` (${l.variation_name})` : ""}`),
  };
  if (!full) return base;
  return {
    ...base,
    closed_at: o.closed_at,
    source: o.source?.name,
    line_items: (o.line_items ?? []).map((l: any) => ({
      name: l.name,
      variation: l.variation_name,
      catalog_object_id: l.catalog_object_id,
      quantity: Number(l.quantity),
      unit_price: major(cents(l.base_price_money)),
      gross: major(cents(l.gross_sales_money)),
      discount: major(cents(l.total_discount_money)),
      tax: major(cents(l.total_tax_money)),
      total: major(cents(l.total_money)),
    })),
    tenders: (o.tenders ?? []).map((t: any) => ({ type: t.type, amount: major(cents(t.amount_money)), tip: major(cents(t.tip_money)) })),
  };
}

async function locationIds(backend: Backend, id?: string) {
  if (id) return [id];
  return (await backend.listLocations()).filter((l) => l.status !== "INACTIVE").map((l) => l.id);
}

function weekStart(day: string) {
  const d = new Date(`${day}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - shift * 86400000).toISOString().slice(0, 10);
}

function addDays(day: string, n: number) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

export function buildTools(backend: Backend, allowWrites: boolean): Tool[] {
  const writeNote = allowWrites
    ? "Changes the live account. Requires confirm: true."
    : "Disabled: the server was started without COUNTER_ALLOW_WRITES=1.";

  return [
    {
      name: "list_locations",
      description: "List the business's Square locations with id, name, timezone, currency and address.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() {
        return (await backend.listLocations()).map((l) => ({
          id: l.id,
          name: l.name,
          status: l.status,
          timezone: l.timezone,
          currency: l.currency,
          address: [l.address?.address_line_1, l.address?.locality, l.address?.administrative_district_level_1].filter(Boolean).join(", "),
        }));
      },
    },
    {
      name: "search_catalog",
      description: "Search catalog items by text (name, description, category). Returns items with their variations, prices and variation ids. Omit query to list items.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to match, like 'latte' or 'bakery'." },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        },
        additionalProperties: false,
      },
      async run(a) {
        return (await backend.searchCatalog(a.query, a.limit ?? 50)).map(shapeItem);
      },
    },
    {
      name: "list_orders",
      description: "List orders created in a date range, oldest first. Amounts are in major currency units.",
      inputSchema: {
        type: "object",
        properties: {
          start: { type: "string", description: `Range start (inclusive), ${DATE}.` },
          end: { type: "string", description: `Range end. A date is inclusive of that whole day. ${DATE}. Default: same as start.` },
          location_id: { type: "string", description: "Limit to one location. Default: all active locations." },
          state: { type: "string", enum: ["OPEN", "COMPLETED", "CANCELED"], description: "Only orders in this state." },
          utc_offset: offsetSchema,
          limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
        },
        required: ["start"],
        additionalProperties: false,
      },
      async run(a) {
        const offset = a.utc_offset ?? "+00:00";
        const { orders, truncated } = await backend.searchOrders({
          locationIds: await locationIds(backend, a.location_id),
          startAt: boundary(a.start, offset),
          endAt: boundary(a.end ?? a.start, offset, true),
          states: a.state ? [a.state] : undefined,
          limit: a.limit ?? 50,
        });
        return { count: orders.length, truncated, orders: orders.map((o) => shapeOrder(o)) };
      },
    },
    {
      name: "get_order",
      description: "Get one order with line items, discounts, tax and tenders.",
      inputSchema: {
        type: "object",
        properties: { order_id: { type: "string" } },
        required: ["order_id"],
        additionalProperties: false,
      },
      async run(a) {
        const order = await backend.getOrder(a.order_id);
        if (!order) throw new ToolError(`No order with id ${a.order_id}`);
        return shapeOrder(order, true);
      },
    },
    {
      name: "inventory_counts",
      description: "Current in-stock counts for inventory-tracked variations, with item names.",
      inputSchema: {
        type: "object",
        properties: {
          location_id: { type: "string" },
          variation_ids: { type: "array", items: { type: "string" } },
          low_stock_below: { type: "integer", minimum: 0, description: "Only return counts below this number." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const [counts, items] = await Promise.all([
          backend.inventoryCounts(a.variation_ids, a.location_id ? [a.location_id] : undefined),
          backend.searchCatalog(undefined, 1000),
        ]);
        const names = new Map<string, string>();
        for (const it of items) {
          for (const v of it.item_data?.variations ?? []) names.set(v.id, `${it.item_data.name} (${v.item_variation_data?.name})`);
        }
        return counts
          .map((c) => ({
            variation_id: c.catalog_object_id,
            name: names.get(c.catalog_object_id) ?? null,
            location_id: c.location_id,
            in_stock: Number(c.quantity),
            as_of: c.calculated_at,
          }))
          .filter((c) => a.low_stock_below === undefined || c.in_stock < a.low_stock_below)
          .sort((x, y) => x.in_stock - y.in_stock);
      },
    },
    {
      name: "sales_summary",
      description: "Sales totals for a day or a Monday-to-Sunday week, computed from completed orders: order count, gross and net sales, tax, tips, average ticket, top items and a per-day breakdown.",
      inputSchema: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["day", "week"], default: "day" },
          date: { type: "string", description: "YYYY-MM-DD inside the period. Default: today at utc_offset." },
          location_id: { type: "string" },
          utc_offset: offsetSchema,
          top: { type: "integer", minimum: 1, maximum: 50, default: 5 },
        },
        additionalProperties: false,
      },
      async run(a) {
        const offset = a.utc_offset ?? "+00:00";
        const day = a.date ?? today(offset);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ToolError("date must be YYYY-MM-DD");
        const period = a.period ?? "day";
        const first = period === "week" ? weekStart(day) : day;
        const last = period === "week" ? addDays(first, 6) : day;
        const cap = 10000;
        const { orders, truncated } = await backend.searchOrders({
          locationIds: await locationIds(backend, a.location_id),
          startAt: boundary(first, offset),
          endAt: boundary(last, offset, true),
          states: ["COMPLETED", "CANCELED"],
          limit: cap,
        });
        const done = orders.filter((o) => o.state === "COMPLETED");
        const sum = (f: (o: any) => number) => done.reduce((s, o) => s + f(o), 0);
        const gross = sum((o) => (o.line_items ?? []).reduce((s: number, l: any) => s + cents(l.gross_sales_money), 0));
        const discounts = sum((o) => cents(o.total_discount_money));
        const items = new Map<string, { name: string; quantity: number; sales: number }>();
        const days = new Map<string, { date: string; orders: number; net_sales: number }>();
        for (let d = first; d <= last; d = addDays(d, 1)) days.set(d, { date: d, orders: 0, net_sales: 0 });
        for (const o of done) {
          let net = 0;
          for (const l of o.line_items ?? []) {
            const key = `${l.name}${l.variation_name ? ` (${l.variation_name})` : ""}`;
            const row = items.get(key) ?? { name: key, quantity: 0, sales: 0 };
            const lineNet = cents(l.gross_sales_money) - cents(l.total_discount_money);
            row.quantity += Number(l.quantity);
            row.sales += lineNet;
            net += lineNet;
            items.set(key, row);
          }
          const bucket = days.get(localDay(o.created_at, offset));
          if (bucket) {
            bucket.orders++;
            bucket.net_sales += net;
          }
        }
        return {
          period,
          start: first,
          end: last,
          utc_offset: offset,
          currency: done[0]?.total_money?.currency ?? null,
          orders: done.length,
          canceled_orders: orders.length - done.length,
          gross_sales: major(gross),
          discounts: major(discounts),
          net_sales: major(gross - discounts),
          tax: major(sum((o) => cents(o.total_tax_money))),
          tips: major(sum((o) => cents(o.total_tip_money))),
          total_collected: major(sum((o) => cents(o.total_money))),
          average_ticket: done.length ? major((gross - discounts) / done.length) : 0,
          top_items: [...items.values()]
            .sort((x, y) => y.quantity - x.quantity || y.sales - x.sales)
            .slice(0, a.top ?? 5)
            .map((r) => ({ ...r, sales: major(r.sales) })),
          by_day: period === "week" ? [...days.values()].map((d) => ({ ...d, net_sales: major(d.net_sales) })) : undefined,
          truncated,
        };
      },
    },
    {
      name: "create_catalog_item",
      write: true,
      description: `Create a catalog item with one priced variation. ${writeNote}`,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          price: { type: "number", exclusiveMinimum: 0, description: "Price in major units, like 4.75." },
          currency: { type: "string", default: "USD" },
          variation_name: { type: "string", default: "Regular" },
          description: { type: "string" },
          confirm: { type: "boolean", description: "Must be true. Ask the owner before setting it." },
        },
        required: ["name", "price", "confirm"],
        additionalProperties: false,
      },
      async run(a) {
        const obj = await backend.createCatalogItem({
          name: a.name,
          description: a.description,
          variationName: a.variation_name ?? "Regular",
          priceCents: Math.round(a.price * 100),
          currency: a.currency ?? "USD",
        });
        return { created: shapeItem(obj) };
      },
    },
    {
      name: "adjust_inventory",
      write: true,
      description: `Add received stock (positive quantity_delta) or record waste (negative). ${writeNote}`,
      inputSchema: {
        type: "object",
        properties: {
          variation_id: { type: "string" },
          location_id: { type: "string" },
          quantity_delta: { type: "integer", description: "Non-zero. Positive adds to IN_STOCK, negative moves stock to WASTE." },
          confirm: { type: "boolean", description: "Must be true. Ask the owner before setting it." },
        },
        required: ["variation_id", "location_id", "quantity_delta", "confirm"],
        additionalProperties: false,
      },
      async run(a) {
        if (!Number.isInteger(a.quantity_delta) || a.quantity_delta === 0) throw new ToolError("quantity_delta must be a non-zero integer");
        const counts = await backend.adjustInventory({ variationId: a.variation_id, locationId: a.location_id, delta: a.quantity_delta });
        return { adjusted: a.quantity_delta, counts: counts.map((c: any) => ({ variation_id: c.catalog_object_id, location_id: c.location_id, state: c.state, quantity: Number(c.quantity) })) };
      },
    },
  ];
}

export async function callTool(tools: Tool[], allowWrites: boolean, name: string, args: Args) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new ToolError(`Unknown tool: ${name}`);
  if (tool.write) {
    if (!allowWrites) throw new ToolError(`${name} is disabled. Restart counter with COUNTER_ALLOW_WRITES=1 to allow writes.`);
    if (args.confirm !== true) throw new ToolError(`${name} changes the Square account. Confirm with the owner, then call again with confirm: true.`);
  }
  for (const key of (tool.inputSchema.required as string[] | undefined) ?? []) {
    if (args[key] === undefined) throw new ToolError(`Missing argument: ${key}`);
  }
  return tool.run(args);
}
