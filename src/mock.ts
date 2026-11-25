import type { Backend } from "./square";
import { addDays, startOfDay } from "./zone";

const TAX_RATE = 0.0825;

const locations = [
  {
    id: "LMAIN01",
    name: "Juniper Coffee - Main St",
    status: "ACTIVE",
    timezone: "America/Chicago",
    currency: "USD",
    address: { address_line_1: "412 Main St", locality: "Austin", administrative_district_level_1: "TX", postal_code: "78701" },
    business_hours: "Mon-Sun 07:00-17:00",
  },
  {
    id: "LKIOSK02",
    name: "Juniper Coffee - Market Kiosk",
    status: "ACTIVE",
    timezone: "America/Chicago",
    currency: "USD",
    address: { address_line_1: "900 Farmers Market Ln", locality: "Austin", administrative_district_level_1: "TX", postal_code: "78702" },
    business_hours: "Fri-Sun 08:00-14:00",
  },
];

type Seed = { id: string; name: string; category: string; weight: number; tracked?: boolean; variations: [string, string, number][] };

const seeds: Seed[] = [
  { id: "ITM_DRIP", name: "Drip Coffee", category: "Coffee", weight: 22, variations: [["VAR_DRIP_12", "12 oz", 300], ["VAR_DRIP_16", "16 oz", 350]] },
  { id: "ITM_LATTE", name: "Latte", category: "Coffee", weight: 26, variations: [["VAR_LATTE_12", "12 oz", 475], ["VAR_LATTE_16", "16 oz", 525]] },
  { id: "ITM_CAPP", name: "Cappuccino", category: "Coffee", weight: 9, variations: [["VAR_CAPP_12", "12 oz", 450]] },
  { id: "ITM_COLD", name: "Cold Brew", category: "Coffee", weight: 12, variations: [["VAR_COLD_16", "16 oz", 475]] },
  { id: "ITM_CHAI", name: "Chai Latte", category: "Tea", weight: 7, variations: [["VAR_CHAI_12", "12 oz", 475]] },
  { id: "ITM_CROIS", name: "Butter Croissant", category: "Bakery", weight: 10, tracked: true, variations: [["VAR_CROIS", "Regular", 375]] },
  { id: "ITM_MUFF", name: "Blueberry Muffin", category: "Bakery", weight: 7, tracked: true, variations: [["VAR_MUFF", "Regular", 350]] },
  { id: "ITM_BURR", name: "Breakfast Burrito", category: "Kitchen", weight: 6, tracked: true, variations: [["VAR_BURR", "Regular", 795]] },
  { id: "ITM_BEAN", name: "House Blend Whole Bean", category: "Retail", weight: 1, tracked: true, variations: [["VAR_BEAN_12", "12 oz bag", 1600]] },
];

function catalogObject(s: Seed) {
  return {
    type: "ITEM",
    id: s.id,
    updated_at: "2026-11-01T15:00:00Z",
    item_data: {
      name: s.name,
      description: `${s.category} item`,
      categories: [{ id: `CAT_${s.category.toUpperCase()}`, name: s.category }],
      variations: s.variations.map(([id, name, price]) => ({
        type: "ITEM_VARIATION",
        id,
        item_variation_data: {
          item_id: s.id,
          name,
          pricing_type: "FIXED_PRICING",
          price_money: { amount: price, currency: "USD" },
          track_inventory: Boolean(s.tracked),
        },
      })),
    },
  };
}

function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T extends { weight: number }>(list: T[], r: () => number): T {
  const total = list.reduce((s, x) => s + x.weight, 0);
  let n = r() * total;
  for (const x of list) if ((n -= x.weight) < 0) return x;
  return list[list.length - 1];
}

function money(amount: number) {
  return { amount, currency: "USD" };
}

function ordersFor(locationId: string, day: string, items: Seed[]) {
  const loc = locations.find((l) => l.id === locationId);
  if (!loc) return [];
  const midnight = startOfDay(day, loc.timezone);
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  const kiosk = locationId === "LKIOSK02";
  if (kiosk && ![0, 5, 6].includes(weekday)) return [];
  const r = rng(`${locationId}:${day}`);
  const weekend = weekday === 0 || weekday === 6;
  const base = kiosk ? 16 : 40;
  const count = Math.round(base * (weekend ? 1.2 : 1) + r() * (kiosk ? 9 : 16));
  const openMin = kiosk ? 8 * 60 : 7 * 60;
  const span = kiosk ? 6 * 60 : 10 * 60;
  const out = [];
  for (let n = 0; n < count; n++) {
    const minute = openMin + Math.floor(((n + r()) / count) * span);
    const created = new Date(midnight + minute * 60000 + Math.floor(r() * 60) * 1000);
    const lines = [];
    const lineCount = r() < 0.55 ? 1 : r() < 0.8 ? 2 : 3;
    for (let l = 0; l < lineCount; l++) {
      const seed = pick(items, r);
      const [varId, varName, price] = seed.variations[Math.floor(r() * seed.variations.length)];
      const qty = r() < 0.9 ? 1 : 2;
      const gross = price * qty;
      lines.push({
        uid: `L${l + 1}`,
        name: seed.name,
        variation_name: varName,
        catalog_object_id: varId,
        quantity: String(qty),
        base_price_money: money(price),
        gross_sales_money: money(gross),
        total_discount_money: money(0),
        total_tax_money: money(Math.round(gross * TAX_RATE)),
        total_money: money(gross + Math.round(gross * TAX_RATE)),
      });
    }
    if (r() < 0.06) {
      const line = lines[0];
      const off = Math.round(line.gross_sales_money.amount * 0.1);
      const net = line.gross_sales_money.amount - off;
      line.total_discount_money = money(off);
      line.total_tax_money = money(Math.round(net * TAX_RATE));
      line.total_money = money(net + line.total_tax_money.amount);
    }
    const discount = lines.reduce((s, x) => s + x.total_discount_money.amount, 0);
    const tax = lines.reduce((s, x) => s + x.total_tax_money.amount, 0);
    const subtotal = lines.reduce((s, x) => s + x.total_money.amount, 0);
    const card = r() < 0.86;
    const tip = card && r() < 0.62 ? Math.round(subtotal * [0.1, 0.15, 0.18, 0.2][Math.floor(r() * 4)]) : 0;
    const canceled = r() < 0.02;
    const seq = String(n + 1).padStart(3, "0");
    const id = `MOCK-${locationId}-${day.replaceAll("-", "")}-${seq}`;
    const refunds = [];
    const rr = rng(`refund:${id}`);
    if (!canceled && rr() < 0.025) {
      const full = rr() < 0.6;
      const amount = full ? subtotal + tip : lines[0].total_money.amount;
      const delay = rr() < 0.7 ? 20 + Math.floor(rr() * 200) : 24 * 60 + Math.floor(rr() * 120);
      refunds.push({
        id: `RF-${id}`,
        order_id: id,
        location_id: locationId,
        status: "COMPLETED",
        reason: full ? "Wrong order" : "Item unavailable",
        amount_money: money(amount),
        created_at: new Date(created.getTime() + delay * 60000).toISOString(),
      });
    }
    out.push({
      id,
      location_id: locationId,
      state: canceled ? "CANCELED" : "COMPLETED",
      source: { name: kiosk ? "Square POS (Kiosk)" : "Square POS" },
      created_at: created.toISOString(),
      closed_at: new Date(created.getTime() + 90000).toISOString(),
      line_items: lines,
      total_discount_money: money(discount),
      total_tax_money: money(tax),
      total_tip_money: money(tip),
      total_money: money(subtotal + tip),
      tenders: canceled ? [] : [{ type: card ? "CARD" : "CASH", amount_money: money(subtotal + tip), tip_money: money(tip) }],
      refunds: refunds.length ? refunds : undefined,
    });
  }
  return out;
}

function eachDay(startAt: string, endAt: string, before = 0) {
  const days: string[] = [];
  const last = new Date(Date.parse(endAt) + 86400000).toISOString().slice(0, 10);
  for (let d = addDays(new Date(startAt).toISOString().slice(0, 10), -1 - before); d <= last; d = addDays(d, 1)) days.push(d);
  return days;
}

export function mockBackend(): Backend {
  const items = seeds.map((s) => ({ ...s, variations: [...s.variations] }));
  const extra: any[] = [];
  const stock = new Map<string, number>();
  for (const loc of locations) {
    for (const s of seeds.filter((x) => x.tracked)) {
      for (const [varId] of s.variations) {
        const r = rng(`stock:${loc.id}:${varId}`);
        stock.set(`${loc.id}|${varId}`, loc.id === "LKIOSK02" ? Math.floor(4 + r() * 12) : Math.floor(8 + r() * 30));
      }
    }
  }

  const allItems = () => [...items.map(catalogObject), ...extra];
  const countRow = (locationId: string, varId: string) => ({
    catalog_object_id: varId,
    catalog_object_type: "ITEM_VARIATION",
    state: "IN_STOCK",
    location_id: locationId,
    quantity: String(stock.get(`${locationId}|${varId}`) ?? 0),
    calculated_at: new Date().toISOString(),
  });

  return {
    mode: "mock",
    async listLocations() {
      return locations;
    },
    async searchCatalog(text, limit) {
      const q = text?.toLowerCase().trim();
      const list = allItems().filter((o) => {
        if (!q) return true;
        const d = o.item_data;
        return [d.name, d.description, ...(d.categories ?? []).map((c: any) => c.name)].some((s) => s?.toLowerCase().includes(q));
      });
      return list.slice(0, limit);
    },
    async searchOrders(q) {
      const orders = [];
      for (const day of eachDay(q.startAt, q.endAt)) {
        for (const loc of q.locationIds) orders.push(...ordersFor(loc, day, seeds));
      }
      const start = Date.parse(q.startAt);
      const end = Date.parse(q.endAt);
      const filtered = orders
        .filter((o) => Date.parse(o.created_at) >= start && Date.parse(o.created_at) < end)
        .filter((o) => !q.states?.length || q.states.includes(o.state))
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      return { orders: filtered.slice(0, q.limit), truncated: filtered.length > q.limit };
    },
    async listRefunds(startAt, endAt, locationIds) {
      const start = Date.parse(startAt);
      const end = Date.parse(endAt);
      const out = [];
      for (const day of eachDay(startAt, endAt, 2)) {
        for (const loc of locationIds) {
          for (const o of ordersFor(loc, day, seeds)) {
            for (const r of o.refunds ?? []) if (Date.parse(r.created_at) >= start && Date.parse(r.created_at) < end) out.push(r);
          }
        }
      }
      return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
    },
    async getOrder(id) {
      const m = /^MOCK-(\w+)-(\d{4})(\d{2})(\d{2})-\d{3}$/.exec(id);
      if (!m) return null;
      return ordersFor(m[1], `${m[2]}-${m[3]}-${m[4]}`, seeds).find((o) => o.id === id) ?? null;
    },
    async inventoryCounts(variationIds, locationIds) {
      const locs = locationIds?.length ? locationIds : locations.map((l) => l.id);
      const keys = [...stock.keys()].map((k) => k.split("|") as [string, string]);
      return keys
        .filter(([loc, v]) => locs.includes(loc) && (!variationIds?.length || variationIds.includes(v)))
        .map(([loc, v]) => countRow(loc, v));
    },
    async createCatalogItem(item) {
      const n = extra.length + 1;
      const obj = {
        type: "ITEM",
        id: `ITM_NEW_${n}`,
        updated_at: new Date().toISOString(),
        item_data: {
          name: item.name,
          description: item.description,
          variations: [
            {
              type: "ITEM_VARIATION",
              id: `VAR_NEW_${n}`,
              item_variation_data: {
                item_id: `ITM_NEW_${n}`,
                name: item.variationName,
                pricing_type: "FIXED_PRICING",
                price_money: { amount: item.priceCents, currency: item.currency },
              },
            },
          ],
        },
      };
      extra.push(obj);
      return obj;
    },
    async adjustInventory(a) {
      const key = `${a.locationId}|${a.variationId}`;
      stock.set(key, Math.max(0, (stock.get(key) ?? 0) + a.delta));
      return [countRow(a.locationId, a.variationId)];
    },
  };
}
