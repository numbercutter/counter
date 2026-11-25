![counter](assets/banner.svg)

# counter

Give agents a seat at the counter.

counter is an MCP server that lets an AI agent read a small business's Square account: locations, catalog, orders, inventory and sales totals. It can also add catalog items and adjust stock, but only when you switch writes on and the agent confirms each change.

## Quick start

No Square account or API key needed. `--mock` serves a small two-location coffee shop with a full order history.

```sh
git clone https://github.com/numbercutter/counter && cd counter
bun examples/drive.ts
```

That starts the server over stdio, then again over HTTP with a bearer token, runs every tool, resource and prompt on both, and prints what comes back. To send one request yourself:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sales_summary","arguments":{"period":"week","date":"2026-11-18"}}}' \
  | bun src/server.ts --mock
```

Requires [Bun](https://bun.sh) 1.1 or later. No dependencies.

## Usage

### Claude Code

```sh
claude mcp add counter -- bun /absolute/path/to/counter/src/server.ts --mock
```

With a real account:

```sh
claude mcp add counter \
  -e SQUARE_ACCESS_TOKEN=your-token \
  -e SQUARE_ENV=sandbox \
  -- bun /absolute/path/to/counter/src/server.ts
```

### Claude Desktop

Add to `claude_desktop_config.json` (Settings > Developer > Edit Config):

```json
{
  "mcpServers": {
    "counter": {
      "command": "bun",
      "args": ["/absolute/path/to/counter/src/server.ts"],
      "env": {
        "SQUARE_ACCESS_TOKEN": "your-token",
        "SQUARE_ENV": "sandbox"
      }
    }
  }
}
```

Use `"args": [".../server.ts", "--mock"]` and drop `env` to try it on fixture data. If Claude Desktop can't find `bun`, use its full path (`which bun`).

### Over HTTP

```sh
COUNTER_HTTP_TOKEN=$(openssl rand -hex 16) bun src/server.ts --mock --http --port 8765
```

This serves MCP Streamable HTTP at `http://127.0.0.1:8765/mcp`, bound to loopback only. Clients send `Authorization: Bearer <token>` when a token is set (`--token` works too, but the environment keeps it out of `ps`). `initialize` returns an `Mcp-Session-Id` header that later requests must send back; `DELETE /mcp` ends the session. Replies are plain JSON, there is no server-to-client stream, so `GET /mcp` answers 405. Requests with an `Origin` header other than localhost are refused.

```sh
claude mcp add --transport http counter http://127.0.0.1:8765/mcp --header "Authorization: Bearer $COUNTER_HTTP_TOKEN"
```

### Tools

| tool | what it does |
|---|---|
| `list_locations` | Locations with id, timezone, currency and address. |
| `search_catalog` | Items and variations matching text, with prices and variation ids. |
| `list_orders` | Orders created between two dates, oldest first. Filter by location or state. |
| `get_order` | One order with line items, discounts, tax and tenders. |
| `inventory_counts` | In-stock counts with item and location names. |
| `low_stock` | Tracked variations below a threshold (default 10), lowest first. |
| `sales_summary` | Day or Monday-to-Sunday week: orders, gross sales, discounts, refunds, net sales, tax, tips, total collected, average ticket, top items, per-day rows. |
| `top_items` | Best sellers over a date range by revenue or quantity, with each item's share. |
| `hourly_heatmap` | Completed orders by weekday and local hour (7×24) over a date range, plus the five busiest slots. |
| `create_catalog_item` | Add an item with one priced variation. Write tool. |
| `adjust_inventory` | Add received stock or record waste. Write tool. |

Dates are `YYYY-MM-DD` or full timestamps. A day runs from local midnight to local midnight in the location's IANA time zone (from `list_locations`), so a week that crosses a daylight saving change is 167 or 169 hours long, as it should be. Pass `timezone` (`Europe/Berlin`, or a fixed offset like `-06:00`) to override it. When several locations with different zones are summed together and no `timezone` is given, days are UTC.

### Prompts and resources

| | |
|---|---|
| prompt `daily-brief` | Yesterday's sales summary (in the shop's zone) and everything below the low-stock threshold, with instructions to write a short morning brief. Arguments: `location_id`, `date`, `threshold`. |
| resource `counter://locations` | Same as `list_locations`. |
| resource `counter://low-stock` | Tracked variations with fewer than 10 in stock. |

### Configuration

| variable | default | |
|---|---|---|
| `SQUARE_ACCESS_TOKEN` | | Personal access token or OAuth token. Required unless `--mock`. |
| `SQUARE_ENV` | `sandbox` | `production` to use the live account. |
| `SQUARE_VERSION` | `2025-01-23` | `Square-Version` header sent with each request. |
| `COUNTER_ALLOW_WRITES` | unset | `1` turns on the two write tools. |
| `COUNTER_HTTP_TOKEN` | unset | Bearer token required by `--http`. Without it the HTTP endpoint is open to anything on this machine. |
| `SQUARE_BASE_URL` | | Send API calls to another host, such as a local stand-in server. |

### Writes

Write tools are listed but refuse to run unless both are true:

1. the server was started with `COUNTER_ALLOW_WRITES=1`, and
2. the call includes `"confirm": true`.

The tool descriptions tell the agent to ask the owner before setting `confirm`. That is a prompt, not a lock: if you don't want an agent changing the account, leave writes off. For the token itself, a sandbox token or an OAuth token limited to `ITEMS_READ ORDERS_READ INVENTORY_READ MERCHANT_PROFILE_READ` is the safest setup.

## How it works

`src/mcp.ts` answers JSON-RPC messages: tools, resources and prompts. `src/server.ts` carries those messages over stdio (one per line, logs on stderr) or over Streamable HTTP with `Bun.serve`. `src/tools.ts` defines the tools and turns Square objects into compact JSON with amounts in major units. `src/zone.ts` finds local midnight in any IANA zone with `Intl.DateTimeFormat`, no date library. `src/square.ts` calls the Square REST v2 API with `fetch` and follows pagination cursors. `src/mock.ts` implements the same interface from a seeded generator in the shop's own time zone, so any date returns the same orders and refunds every time.

`sales_summary` fetches every completed and canceled order in the period, plus every completed or pending refund issued in it (`GET /v2/refunds`). Net sales are line-item gross minus discounts minus the sales part of refunds. Each refund is split into sales, tax and tip in proportion to its order's totals, so tax and tips are net of refunds too. `total_collected` is what tenders took in, minus refunds.

## Limits

- `sales_summary` reads raw orders and refunds, not Square's reports. It will be close to the Square Dashboard but can differ: refunds are split by ratio rather than by the returned line items, refunds count on the day they were issued, and refunds against orders outside the period are looked up for at most 100 orders. It stops at 10,000 orders and says `truncated: true`.
- `top_items` and `hourly_heatmap` count orders by creation time and ignore refunds.
- Orders are searched across at most 10 locations at a time, which is Square's limit.
- HTTP replies are plain JSON. There is no SSE stream, so no server-sent notifications or progress. Sessions live in memory and end when the server stops. Binding is loopback only; put a proxy in front to reach it from elsewhere.
- `adjust_inventory` only does received stock (`NONE` to `IN_STOCK`) and waste (`IN_STOCK` to `WASTE`). Physical counts and transfers are not covered.
- Mock data is invented. Mock writes live in memory and reset when the server restarts.
- Not affiliated with Square.

Works with [nod](https://github.com/numbercutter/nod) to have a person approve each write before it runs, and [leash](https://github.com/numbercutter/leash) to give the agent a short-lived, scoped token instead of the Square key.

<sub>A numbercutter instrument · MIT</sub>
