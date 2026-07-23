# tenant-router

Framework-neutral core API for resolving `tenantId -> shardId` routes.

The core package defines the contracts used by its first-class stack:

- `RouteStore`: source of truth for tenant routes
- `RouteEventBus`: route-change events and cache invalidation
- `RouteCache`: local low-latency route cache

The supported production shape is SQLite for the local cache, Redis for route events, and PostgreSQL for the route source of truth. The in-memory adapters remain useful for tests and single-process development.

See [the database schema reference](docs/database.md) for every persisted SQLite cache field and ready-to-run inspection queries.

## Architecture

```mermaid
flowchart TB
  subgraph ControlPlane["Control plane"]
    direction RL
    Operator["Operator / TenantRouteCommands"] -->|"write route or provision shard"| Store["PostgreSQL RouteStore"]
    Operator -->|"publish RouteEvent"| Redis["Redis route events"]
    Redis -->|"consume event"| Broker["RouteEventBus broker"]
  end

  subgraph DataPlane["API process"]
    direction LR
    Client["Client"] --> API["Application service"]
    API -->|"resolve(tenantId)"| Router["TenantShardRouter"]
    Router -->|"cache get/set"| Cache["SQLite RouteCache"]
    Router -->|"cache miss"| Store
    Router -->|"shardId"| Shards["PostgreSQL shards"]
  end

  Broker -->|"invalidate or refresh"| Router
```

This is the first complete library slice: the core router owns lookup flow, cache behavior, event-driven invalidation, and the contracts for its SQLite, Redis, and PostgreSQL adapters.

## Core Usage

```ts
import {
  createMemoryRouteEvents,
  createMemoryRouteStore,
  createTenantRouter
} from "tenant-router";

const routeStore = createMemoryRouteStore({
  routes: [
    {
      tenantId: "acme",
      shardId: "shard-a",
      routeVersion: 1,
      tier: "pro",
      reason: "initial assignment"
    }
  ]
});

const events = createMemoryRouteEvents();
const router = createTenantRouter({
  routeStore,
  events,
  cache: { ttlMs: 30_000 }
});

const route = await router.resolve("acme");

console.log(route.shardId); // "shard-a"
```

## Route Changes

The router caches route lookups locally. When a route changes, publish an event to invalidate or refresh that cache:

```ts
routeStore.setTenantRoute({
  tenantId: "acme",
  shardId: "shard-b",
  routeVersion: 2,
  tier: "pro",
  reason: "moved away from a noisy shard"
});

await events.publish({
  type: "tenant.moved",
  tenantId: "acme",
  shardId: "shard-b",
  routeVersion: 2
});
```

## Core API

- `createTenantRouter(config)` creates a shard route resolver.
- `router.resolve(tenantId)` returns the active `TenantRoute` or throws `TenantRouteNotFoundError`.
- `router.getRoute(tenantId)` returns the active route or `null`.
- `router.explain(tenantId)` reports whether the route came from cache or store.
- `router.invalidate(tenantId)` manually clears one cached route.
- `router.close()` unsubscribes from route events.

## Route Commands

`TenantRouteCommands` is the control-plane API. It writes a route first, then publishes an event that refreshes each subscribed router cache.

```ts
import { createTenantRouteCommands } from "tenant-router";

const commands = createTenantRouteCommands({
  routeRegistry,
  shardRegistry,
  events
});

await commands.provisionShard({ id: "shard-a", region: "ap-northeast-1" });
await commands.createTenant({
  tenantId: "acme",
  shardId: "shard-a",
  tier: "pro"
});
await commands.moveTenantToShard({
  tenantId: "acme",
  shardId: "shard-b",
  reason: "rebalance"
});
```

Commands also provide `assignTenantToShard`, `changeTenantTier`, and `disableTenant`. The PostgreSQL adapter will use a transaction/outbox so the route write and eventual Redis event publication remain recoverable.

Official adapters should implement the core interfaces:

- `sqliteRouteCache(...)` implements `RouteCache` and is available from `tenant-router/node`.
- `postgresRouteStore(...)` will implement `RouteStore`.
- `redisRouteEvents(...)` will implement `RouteEventBus`.

## SQLite Cache

Use the Node-only SQLite adapter when a process should retain its local cache across restarts. It remains a cache: PostgreSQL will remain the authoritative `RouteStore`.

```ts
import { createSqliteRouteCache } from "tenant-router/node";

const cache = createSqliteRouteCache({
  path: "./tenant-routes.db",
  ttlMs: 30_000
});

const router = createTenantRouter({ routeStore, events, cache });
```

## Tenant Request Matching

The package also includes a small matcher for request-like input. This is useful at API boundaries where a tenant id is inferred from a host, path, or header before resolving the tenant route.

```ts
import { createTenantMatcher } from "tenant-router";

const matcher = createTenantMatcher({
  baseDomain: "example.com",
  fallbackTenantId: "public",
  tenants: [
    { id: "public", domains: ["example.com"] },
    {
      id: "acme",
      domains: ["acme.example.com"],
      pathPrefixes: ["/acme"],
      headers: { "x-tenant-id": "acme" }
    }
  ]
});

const match = matcher.resolve({
  host: "acme.example.com",
  path: "/dashboard"
});

if (match.tenantId) {
  const route = await router.resolve(match.tenantId);
}
```

Matcher rules are evaluated in this order:

1. Header values
2. Host/domain rules
3. Path prefixes
4. Fallback tenant
