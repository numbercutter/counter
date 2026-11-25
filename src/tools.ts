import type { Backend } from "./square";
import { addDays, isZone, startOfDay, wallClock, weekStart, WEEKDAYS } from "./zone";

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
const zoneSchema = {
  type: "string",
  description: "IANA time zone like America/Chicago, or a fixed offset like -06:00. Default: the location's own time zone.",
};
const rangeProps = {
  start: { type: "string", description: "First day, YYYY-MM-DD." },
  end: { type: "string", description: "Last day, YYYY-MM-DD, inclusive. Default: same as start." },
  location_id: { type: "string", description: "Limit to one location. Default: all active locations." },
  timezone: zoneSchema,
};

const cents = (m: any) => (m && typeof m.amount === "number" ? m.amount : 0);
const major = (c: number) => Math.round(c) / 100;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function boundary(value: string, zone: string, end = false) {
  if (!DAY.test(value)) {
    if (Number.isNaN(Date.parse(value))) throw new ToolError(`Not a date: ${value}`);
    return new Date(value).toISOString();
  }
  return new Date(startOfDay(end ? addDays(value, 1) : value, zone)).toISOString();
}

function lineKey(l: any) {
  return `${l.name}${l.variation_name ? ` (${l.variation_name})` : ""}`;
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

async function scope(backend: Backend, a: Args) {
  const all = await backend.listLocations();
  const active = all.filter((l) => l.status !== "INACTIVE");
  const ids = a.location_id ? [a.location_id] : active.map((l) => l.id);
  let zone = a.timezone;
  if (zone && !isZone(zone)) throw new ToolError(`Unknown time zone: ${zone}`);
  if (!zone) {
    const zones = [...new Set(all.filter((l) => ids.includes(l.id)).map((l) => l.timezone).filter(Boolean))];
    zone = zones.length === 1 ? zones[0] : "UTC";
  }
  return { ids, zone: zone as string };
}

async function ordersIn(backend: Backend, a: Args, first: string, last: string, known?: Awaited<ReturnType<typeof scope>>) {
  if (!DAY.test(first) || !DAY.test(last)) throw new ToolError("start and end must be YYYY-MM-DD");
  if (last < first) throw new ToolError("end is before start");
  const s = known ?? (await scope(backend, a));
  const startAt = boundary(first, s.zone);
  const endAt = boundary(last, s.zone, true);
  const { orders, truncated } = await backend.searchOrders({ locationIds: s.ids, startAt, endAt, states: ["COMPLETED", "CANCELED"], limit: 10000 });
  return { ...s, startAt, endAt, orders, done: orders.filter((o) => o.state === "COMPLETED"), truncated };
}

function itemTotals(orders: any[]) {
  const items = new Map<string, { name: string; variation_id: string | undefined; quantity: number; revenue: number }>();
  for (const o of orders) {
    for (const l of o.line_items ?? []) {
      const key = lineKey(l);
      const row = items.get(key) ?? { name: key, variation_id: l.catalog_object_id, quantity: 0, revenue: 0 };
      row.quantity += Number(l.quantity);
      row.revenue += cents(l.gross_sales_money) - cents(l.total_discount_money);
      items.set(key, row);
    }
  }
  return [...items.values()];
}

function refundSplit(order: any | undefined, amount: number) {
  if (!order) return { sales: amount, tax: 0, tips: 0 };
  const total = cents(order.total_money);
  if (!total) return { sales: amount, tax: 0, tips: 0 };
  const tax = (amount * cents(order.total_tax_money)) / total;
  const tips = (amount * cents(order.total_tip_money)) / total;
  return { sales: amount - tax - tips, tax, tips };
}

async function lowStock(backend: Backend, a: Args, threshold: number) {
  const [counts, items, locs] = await Promise.all([
    backend.inventoryCounts(a.variation_ids, a.location_id ? [a.location_id] : undefined),
    backend.searchCatalog(undefined, 1000),
    backend.listLocations(),
  ]);
  const names = new Map<string, string>();
  for (const it of items) {
    for (const v of it.item_data?.variations ?? []) names.set(v.id, `${it.item_data.name} (${v.item_variation_data?.name})`);
  }
  const locNames = new Map(locs.map((l: any) => [l.id, l.name]));
  return counts
    .map((c) => ({
      variation_id: c.catalog_object_id,
      name: names.get(c.catalog_object_id) ?? null,
      location_id: c.location_id,
      location: locNames.get(c.location_id) ?? null,
      in_stock: Number(c.quantity),
      as_of: c.calculated_at,
    }))
    .filter((c) => c.in_stock < threshold)
    .sort((x, y) => x.in_stock - y.in_stock);
}

export async function salesSummary(backend: Backend, a: Args) {
  const period = a.period ?? "day";
  const pre = await scope(backend, a);
  const day = a.date ?? wallClock(Date.now(), pre.zone).date;
  if (!DAY.test(day)) throw new ToolError("date must be YYYY-MM-DD");
  const first = period === "week" ? weekStart(day) : day;
  const last = period === "week" ? addDays(first, 6) : day;
  const r = await ordersIn(backend, a, first, last, pre);
  const refunds = await backend.listRefunds(r.startAt, r.endAt, r.ids);
  const byId = new Map(r.orders.map((o) => [o.id, o]));
  for (const f of refunds.slice(0, 100)) {
    if (f.order_id && !byId.has(f.order_id)) byId.set(f.order_id, await backend.getOrder(f.order_id).catch(() => null));
  }
  const sum = (f: (o: any) => number) => r.done.reduce((s, o) => s + f(o), 0);
  const gross = sum((o) => (o.line_items ?? []).reduce((s: number, l: any) => s + cents(l.gross_sales_money), 0));
  const discounts = sum((o) => cents(o.total_discount_money));
  const back = { total: 0, sales: 0, tax: 0, tips: 0 };
  const days = new Map<string, { date: string; orders: number; net_sales: number; refunds: number }>();
  for (let d = first; d <= last; d = addDays(d, 1)) days.set(d, { date: d, orders: 0, net_sales: 0, refunds: 0 });
  for (const f of refunds) {
    const amount = cents(f.amount_money);
    const split = refundSplit(byId.get(f.order_id) ?? undefined, amount);
    back.total += amount;
    back.sales += split.sales;
    back.tax += split.tax;
    back.tips += split.tips;
    const bucket = days.get(wallClock(Date.parse(f.created_at), r.zone).date);
    if (bucket) {
      bucket.refunds += amount;
      bucket.net_sales -= split.sales;
    }
  }
  for (const o of r.done) {
    const bucket = days.get(wallClock(Date.parse(o.created_at), r.zone).date);
    if (!bucket) continue;
    bucket.orders++;
    bucket.net_sales += (o.line_items ?? []).reduce((s: number, l: any) => s + cents(l.gross_sales_money) - cents(l.total_discount_money), 0);
  }
  const net = gross - discounts - back.sales;
  return {
    period,
    start: first,
    end: last,
    timezone: r.zone,
    start_at: r.startAt,
    end_at: r.endAt,
    hours: (Date.parse(r.endAt) - Date.parse(r.startAt)) / 3600000,
    currency: r.done[0]?.total_money?.currency ?? null,
    orders: r.done.length,
    canceled_orders: r.orders.length - r.done.length,
    gross_sales: major(gross),
    discounts: major(discounts),
    refunds: major(back.total),
    refund_count: refunds.length,
    net_sales: major(net),
    tax: major(sum((o) => cents(o.total_tax_money)) - back.tax),
    tips: major(sum((o) => cents(o.total_tip_money)) - back.tips),
    total_collected: major(sum((o) => cents(o.total_money)) - back.total),
    average_ticket: r.done.length ? major((gross - discounts) / r.done.length) : 0,
    top_items: itemTotals(r.done)
      .sort((x, y) => y.quantity - x.quantity || y.revenue - x.revenue)
      .slice(0, a.top ?? 5)
      .map(({ name, quantity, revenue }) => ({ name, quantity, sales: major(revenue) })),
    by_day: period === "week" ? [...days.values()].map((d) => ({ ...d, net_sales: major(d.net_sales), refunds: major(d.refunds) })) : undefined,
    truncated: r.truncated,
  };
}

export async function dailyBriefData(backend: Backend, a: Args) {
  const s = await scope(backend, a);
  const date = a.date ?? addDays(wallClock(Date.now(), s.zone).date, -1);
  if (!DAY.test(date)) throw new ToolError("date must be YYYY-MM-DD");
  const threshold = a.threshold ?? 10;
  const [summary, low] = await Promise.all([salesSummary(backend, { ...a, date, period: "day" }), lowStock(backend, a, threshold)]);
  return { date, threshold, summary, low_stock: low };
}

export async function lowStockData(backend: Backend, threshold = 10) {
  return lowStock(backend, {}, threshold);
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
      description: "List orders created in a date range, oldest first. Days follow the location's time zone. Amounts are in major currency units.",
      inputSchema: {
        type: "object",
        properties: {
          start: { type: "string", description: `Range start (inclusive), ${DATE}.` },
          end: { type: "string", description: `Range end. A date is inclusive of that whole day. ${DATE}. Default: same as start.` },
          location_id: rangeProps.location_id,
          state: { type: "string", enum: ["OPEN", "COMPLETED", "CANCELED"], description: "Only orders in this state." },
          timezone: zoneSchema,
          limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
        },
        required: ["start"],
        additionalProperties: false,
      },
      async run(a) {
        const s = await scope(backend, a);
        const { orders, truncated } = await backend.searchOrders({
          locationIds: s.ids,
          startAt: boundary(a.start, s.zone),
          endAt: boundary(a.end ?? a.start, s.zone, true),
          states: a.state ? [a.state] : undefined,
          limit: a.limit ?? 50,
        });
        return { count: orders.length, truncated, timezone: s.zone, orders: orders.map((o) => shapeOrder(o)) };
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
      description: "Current in-stock counts for inventory-tracked variations, with item and location names.",
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
        return lowStock(backend, a, a.low_stock_below ?? Infinity);
      },
    },
    {
      name: "low_stock",
      description: "Tracked variations whose in-stock count is below a threshold, lowest first. Use it to decide what to reorder.",
      inputSchema: {
        type: "object",
        properties: {
          threshold: { type: "integer", minimum: 1, default: 10, description: "Return counts below this number." },
          location_id: { type: "string" },
        },
        additionalProperties: false,
      },
      async run(a) {
        const threshold = a.threshold ?? 10;
        const rows = await lowStock(backend, a, threshold);
        return { threshold, count: rows.length, items: rows };
      },
    },
    {
      name: "sales_summary",
      description: "Sales for a day or a Monday-to-Sunday week in the location's time zone: gross sales, discounts, refunds, net sales, tax, tips, total collected, average ticket, top items and a per-day breakdown. Refunds count on the day they were issued.",
      inputSchema: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["day", "week"], default: "day" },
          date: { type: "string", description: "YYYY-MM-DD inside the period. Default: today in the location's time zone." },
          location_id: { type: "string" },
          timezone: zoneSchema,
          top: { type: "integer", minimum: 1, maximum: 50, default: 5 },
        },
        additionalProperties: false,
      },
      run: (a) => salesSummary(backend, a),
    },
    {
      name: "top_items",
      description: "Best-selling items over a date range, ranked by revenue (net of discounts) or by quantity, with each item's share.",
      inputSchema: {
        type: "object",
        properties: {
          ...rangeProps,
          by: { type: "string", enum: ["revenue", "quantity"], default: "revenue" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
        },
        required: ["start"],
        additionalProperties: false,
      },
      async run(a) {
        const by = a.by ?? "revenue";
        const r = await ordersIn(backend, a, a.start, a.end ?? a.start);
        const rows = itemTotals(r.done);
        const total = rows.reduce((s, x) => s + x[by as "revenue" | "quantity"], 0);
        return {
          start: a.start,
          end: a.end ?? a.start,
          timezone: r.zone,
          by,
          orders: r.done.length,
          items: rows
            .sort((x, y) => (by === "quantity" ? y.quantity - x.quantity || y.revenue - x.revenue : y.revenue - x.revenue || y.quantity - x.quantity))
            .slice(0, a.limit ?? 10)
            .map((x) => ({ ...x, revenue: major(x.revenue), share: total ? Math.round((x[by as "revenue" | "quantity"] / total) * 1000) / 1000 : 0 })),
          truncated: r.truncated,
        };
      },
    },
    {
      name: "hourly_heatmap",
      description: "Completed orders counted by weekday and local hour over a date range. counts[weekday][hour], weekdays Monday first. Use it for staffing and opening hours.",
      inputSchema: {
        type: "object",
        properties: rangeProps,
        required: ["start"],
        additionalProperties: false,
      },
      async run(a) {
        const r = await ordersIn(backend, a, a.start, a.end ?? a.start);
        const counts = WEEKDAYS.map(() => new Array(24).fill(0));
        for (const o of r.done) {
          const w = wallClock(Date.parse(o.created_at), r.zone);
          counts[w.weekday][w.hour]++;
        }
        const cells = counts.flatMap((row, d) => row.map((n, h) => ({ weekday: WEEKDAYS[d], hour: h, orders: n })));
        return {
          start: a.start,
          end: a.end ?? a.start,
          timezone: r.zone,
          orders: r.done.length,
          weekdays: WEEKDAYS,
          counts,
          busiest: cells.filter((c) => c.orders).sort((x, y) => y.orders - x.orders).slice(0, 5),
          truncated: r.truncated,
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
