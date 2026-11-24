export type Money = { amount: number; currency: string };

export type OrderQuery = {
  locationIds: string[];
  startAt: string;
  endAt: string;
  states?: string[];
  limit: number;
};

export type NewItem = {
  name: string;
  description?: string;
  variationName: string;
  priceCents: number;
  currency: string;
};

export type Adjustment = {
  variationId: string;
  locationId: string;
  delta: number;
};

export interface Backend {
  mode: "live" | "mock";
  listLocations(): Promise<any[]>;
  searchCatalog(text: string | undefined, limit: number): Promise<any[]>;
  searchOrders(q: OrderQuery): Promise<{ orders: any[]; truncated: boolean }>;
  getOrder(id: string): Promise<any | null>;
  inventoryCounts(variationIds: string[] | undefined, locationIds: string[] | undefined): Promise<any[]>;
  createCatalogItem(item: NewItem): Promise<any>;
  adjustInventory(a: Adjustment): Promise<any>;
}

export class SquareError extends Error {
  constructor(public status: number, public detail: unknown) {
    super(`Square API ${status}: ${JSON.stringify(detail)}`);
  }
}

export function liveBackend(env = process.env): Backend {
  const token = env.SQUARE_ACCESS_TOKEN;
  if (!token) throw new Error("SQUARE_ACCESS_TOKEN is not set. Use --mock to try counter without a Square account.");
  const base = (env.SQUARE_ENV ?? "sandbox") === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
  const version = env.SQUARE_VERSION ?? "2025-01-23";

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Square-Version": version,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new SquareError(res.status, json.errors ?? json);
    return json;
  }

  return {
    mode: "live",
    async listLocations() {
      return (await call("GET", "/v2/locations")).locations ?? [];
    },
    async searchCatalog(text, limit) {
      const items: any[] = [];
      let cursor: string | undefined;
      do {
        const body: any = { limit: Math.min(100, limit - items.length), cursor };
        if (text) body.text_filter = text;
        const r = await call("POST", "/v2/catalog/search-catalog-items", body);
        items.push(...(r.items ?? []));
        cursor = r.cursor;
      } while (cursor && items.length < limit);
      return items.slice(0, limit);
    },
    async searchOrders(q) {
      const orders: any[] = [];
      let cursor: string | undefined;
      do {
        const filter: any = { date_time_filter: { created_at: { start_at: q.startAt, end_at: q.endAt } } };
        if (q.states?.length) filter.state_filter = { states: q.states };
        const r = await call("POST", "/v2/orders/search", {
          location_ids: q.locationIds.slice(0, 10),
          query: { filter, sort: { sort_field: "CREATED_AT", sort_order: "ASC" } },
          limit: Math.min(500, q.limit - orders.length),
          cursor,
        });
        orders.push(...(r.orders ?? []));
        cursor = r.cursor;
      } while (cursor && orders.length < q.limit);
      return { orders: orders.slice(0, q.limit), truncated: Boolean(cursor) };
    },
    async getOrder(id) {
      try {
        return (await call("GET", `/v2/orders/${encodeURIComponent(id)}`)).order ?? null;
      } catch (e) {
        if (e instanceof SquareError && e.status === 404) return null;
        throw e;
      }
    },
    async inventoryCounts(variationIds, locationIds) {
      const counts: any[] = [];
      let cursor: string | undefined;
      do {
        const r = await call("POST", "/v2/inventory/counts/batch-retrieve", {
          catalog_object_ids: variationIds,
          location_ids: locationIds,
          states: ["IN_STOCK"],
          cursor,
        });
        counts.push(...(r.counts ?? []));
        cursor = r.cursor;
      } while (cursor && counts.length < 2000);
      return counts;
    },
    async createCatalogItem(item) {
      const r = await call("POST", "/v2/catalog/object", {
        idempotency_key: crypto.randomUUID(),
        object: {
          type: "ITEM",
          id: "#item",
          item_data: {
            name: item.name,
            description: item.description,
            variations: [
              {
                type: "ITEM_VARIATION",
                id: "#variation",
                item_variation_data: {
                  name: item.variationName,
                  pricing_type: "FIXED_PRICING",
                  price_money: { amount: item.priceCents, currency: item.currency },
                },
              },
            ],
          },
        },
      });
      return r.catalog_object;
    },
    async adjustInventory(a) {
      const incoming = a.delta > 0;
      const r = await call("POST", "/v2/inventory/changes/batch-create", {
        idempotency_key: crypto.randomUUID(),
        changes: [
          {
            type: "ADJUSTMENT",
            adjustment: {
              catalog_object_id: a.variationId,
              location_id: a.locationId,
              from_state: incoming ? "NONE" : "IN_STOCK",
              to_state: incoming ? "IN_STOCK" : "WASTE",
              quantity: String(Math.abs(a.delta)),
              occurred_at: new Date().toISOString(),
            },
          },
        ],
      });
      return r.counts ?? [];
    },
  };
}
