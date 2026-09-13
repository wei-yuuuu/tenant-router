# tenant-router

Framework-neutral core API for resolving `tenantId -> shardId` routes.

The core package defines the contracts used by its first-class stack:

- `RouteStore`: source of truth for tenant routes
- `RouteEventBus`: route-change events and cache invalidation
- `RouteCache`: local low-latency route cache

The supported production shape is SQLite for the local cache, Redis for route events, and PostgreSQL for the route source of truth. The in-memory adapters remain useful for tests and single-process development.

See [the database schema reference](docs/database.md) for every persisted SQLite cache field and ready-to-run inspection queries.

## Local Stack

The repository includes a Docker Compose stack for the first-class local dependencies:

- One React + React Flow control panel
- One local API runner, which can be scaled to multiple API instances
- PostgreSQL metadata store with the route and outbox tables
- Redis Streams
- Four PostgreSQL shard databases

Start everything with:

```sh
docker compose up -d
docker compose ps
npm run smoke:local
```

Open the control panel at `http://localhost:5173/`. The API runner publishes container port `3000` to a random host port for direct inspection:

```sh
open http://localhost:5173/
curl "http://$(docker compose port api 3000)/health"
curl "http://$(docker compose port api 3000)/route/acme"
```

To simulate three API pods, scale the same runner. Each container gets its own SQLite cache, Redis stream cursor, and shard client pools:

```sh
docker compose up -d --scale api=3
# Scale API replicas freely — demo QPS is shared via Redis (no DEMO_API_REPLICAS):
# docker compose up -d --scale api=3
# Each replica registers in Redis; GET /instances lists them so the control panel
# can draw one API node per instance (resolve edge follows the answering replica).
docker compose port --index 1 api 3000
docker compose port --index 2 api 3000
docker compose port --index 3 api 3000
```

`smoke:local` requires the Compose stack to be healthy. It creates a temporary tenant, verifies PostgreSQL persistence, Redis event propagation into the SQLite cache, and topology queries, then removes the tenant route.

Local connection settings:

```sh
ROUTING_DATABASE_URL=postgres://tenant_router:tenant_router_local@localhost:5432/tenant_router
REDIS_URL=redis://localhost:6379
SHARD_1_DATABASE_URL=postgres://shard:shard_local@localhost:5541/shard_1
SHARD_2_DATABASE_URL=postgres://shard:shard_local@localhost:5542/shard_2
SHARD_3_DATABASE_URL=postgres://shard:shard_local@localhost:5543/shard_3
SHARD_4_DATABASE_URL=postgres://shard:shard_local@localhost:5544/shard_4
ROUTING_POOL_MAX=10
SHARD_POOL_MAX=10
```

`SHARD_POOL_MAX` is the maximum number of PostgreSQL connections per API instance, per shard. With three API instances and `SHARD_POOL_MAX=10`, each shard can receive up to `3 x 10 = 30` client connections. Pool connections are created lazily, so this is a ceiling rather than an allocation at startup. Override it when starting the local stack:

```sh
SHARD_POOL_MAX=5 docker compose up -d --build --scale api=3
```

The metadata database runs [`migrations/001_tenant_router.sql`](migrations/001_tenant_router.sql) and seeds four local shard definitions on first initialization. To reset all local data, use `docker compose down -v`. The API runner and React control panel are local verification and control processes; they are not framework adapters, and the package remains framework-neutral without requiring either process in production.

## Inspect Local Services

The local stack can be inspected with standard Docker Compose commands. These commands work with any Docker-compatible environment.

### Inspect API Instances

View all service instances and their status:

```sh
docker compose ps
docker compose top api
```

View API startup and runtime logs:

```sh
docker compose logs --tail=100 api
docker compose logs -f api
```

Open a shell in a specific API instance:

```sh
docker compose exec --index 1 api sh
```

Inspect the application files and each instance's local SQLite cache from inside the container:

```sh
find /app -maxdepth 3 -type f | sort
find /tmp/tenant-router -ls
env | sort
```

The API runner exposes `/health`, `/topology`, and `/route/:tenantId`. Its container port is `3000`, published to a random host port so multiple API instances can run together:

```sh
docker compose port --index 1 api 3000
# Example output: 0.0.0.0:32768
curl http://localhost:32768/health
curl http://localhost:32768/topology
curl http://localhost:32768/route/acme
```

`/route/:tenantId` returns `404` when the tenant has no route. A successful response includes the API instance id, cache source, route version, resolved shard, and whether an application-owned shard client is available.

### Use the React Control Panel

Open `http://localhost:5173/`. The panel is a separate Compose service from `apps/control-panel` (bind-mounted for Vite HMR; edit `apps/control-panel/src` and refresh happens automatically), with React Flow rendering the command and data paths. It reads `/health` and `/topology` through its same-origin `/api` proxy and sends commands to the API service. It can create a tenant route, move a tenant, change its tier, disable it, and register shard metadata.

The command endpoints are intentionally small and map directly to `TenantRouteCommands`:

```sh
curl -X POST http://localhost:32768/tenants \
  -H 'content-type: application/json' \
  -d '{"tenantId":"acme","shardId":"shard-1","tier":"pro"}'

curl -X POST http://localhost:32768/tenants/acme/move \
  -H 'content-type: application/json' \
  -d '{"shardId":"shard-2","reason":"rebalance"}'

curl -X POST http://localhost:32768/tenants/acme/tier \
  -H 'content-type: application/json' \
  -d '{"tier":"enterprise"}'

curl -X POST http://localhost:32768/tenants/acme/disable \
  -H 'content-type: application/json' \
  -d '{"reason":"account closed"}'

curl -X POST http://localhost:32768/shards \
  -H 'content-type: application/json' \
  -d '{"id":"shard-5","region":"ap-northeast-1","capacity":1000,"loadScore":0.25}'

# Or omit id to allocate the next free shard-N (fills gaps up to the demo cap):
curl -X POST http://localhost:32768/shards \
  -H 'content-type: application/json' \
  -d '{}'

curl -X DELETE http://localhost:32768/shards/shard-5
```

Empty shards can be removed with `DELETE /shards/:id` (or the shard **×** control). At least one shard is kept. Active tenants block deletion (`SHARD_NOT_EMPTY`).

The local demo caps RouteStore at **10 shards** (`MAX_DEMO_SHARDS`, default 10). The control panel **RouteStore +** control calls the same endpoint. `provisionShard` itself never needs `SHARD_N_DATABASE_URL` — it only writes RouteStore metadata. Compose ships physical Postgres pools for `shard-1`…`shard-4`; `shard-5`…`shard-10` stay metadata-only until you set `SHARD_N_DATABASE_URL` (and run a matching DB) if you also want live data queries. MoveTenant onto a metadata-only shard works; `GET /route/...` returns `SHARD_CLIENT_NOT_FOUND` until a pool is wired.

These endpoints are for local control and verification. The React control panel is intentionally separate from the core package and does not become a runtime dependency of `tenant-router`. Production applications should put their own authentication, authorization, audit policy, and request validation in front of `TenantRouteCommands`.

### Inspect PostgreSQL

Inspect routing metadata:

```sh
docker compose exec routing-postgres psql -U tenant_router -d tenant_router -c "
  SELECT tenant_id, shard_id, route_version, status
  FROM tenant_router_routes
  ORDER BY updated_at DESC;
"
```

Inspect connections on a shard:

```sh
docker compose exec shard-1 psql -U shard -d shard_1 -c "
      SELECT pid, usename, state, application_name
      FROM pg_stat_activity;
"
```

The API pool settings are also included in `/health` as `routingPoolMax`, `shardPoolMax`, and `shardCount`.

### Inspect Redis

```sh
docker compose exec redis redis-cli PING
docker compose exec redis redis-cli XRANGE tenant-router:route-events - + COUNT 20
```

## Architecture

```mermaid
flowchart TB
  subgraph ControlPlane["Control plane"]
    direction RL
    Operator["TenantRouteCommands (operator)"] -->|"[1] create tenant / move tenant / provision shard"| Store["PostgresRouteStore (RouteStore + outbox)"]
    Operator -->|"[read] shard load / topology"| Queries["RouteTopologyReader"]
    Queries -->|"list route + shard metadata"| Store
    Store -->|"pending outbox events"| Worker["PostgresOutboxWorker"]
    Worker -->|"[2] publish RouteEvent"| Redis["Redis route events"]
    Redis -->|"consume event"| Broker["RouteEventBus (broker)"]
  end

  subgraph DataPlane["API process"]
    direction LR
    Client["Client"] --> API["Application service"]
    API -->|"resolve(tenantId) -> TenantRoute { shardId }"| Router["TenantShardRouter"]
    Router -->|"cache get/set/invalidate"| Cache["SQLite RouteCache"]
    Router -->|"cache miss"| Store
  end

  Broker -->|"RouteEvent"| Router

  subgraph ShardFleet["PostgreSQL shard fleet"]
    direction TB
    Shard1["Shard 1"]
    Shard2["Shard 2"]
    Shard3["Shard 3"]
    Shard4["Shard 4"]
  end

  Store -. "route and shard metadata" .-> Shard1
  Store -. "route and shard metadata" .-> Shard2
  Store -. "route and shard metadata" .-> Shard3
  Store -. "route and shard metadata" .-> Shard4
  API -->|"resolve shard client"| ClientResolver["TenantShardClientResolver"]
  ClientResolver -->|"query selected shard (example)"| Shard2

  Legend["Solid arrow: runtime data flow<br/>Dashed arrow: stored metadata relationship"]
```

The React control panel is a thin client of `TenantRouteCommands`; it is not a separate route store. This is the first complete library slice: the core router owns lookup flow, cache behavior, event-driven invalidation, and the contracts for its SQLite, Redis, and PostgreSQL adapters.

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

Route versions are monotonic per tenant. An API process serializes event handling and ignores an older event that arrives after a newer route has been observed, so an out-of-order Redis event cannot downgrade or delete a newer cache entry.

## Core API

- `createTenantRouter(config)` creates a shard route resolver.
- `router.resolve(tenantId)` returns the active `TenantRoute` or throws `TenantRouteNotFoundError`.
- `router.getRoute(tenantId)` returns the active route or `null`.
- `router.warmup()` preloads all routes when the store implements `listTenantRoutes()`.
- `router.explain(tenantId)` reports whether the route came from cache or store.
- `router.invalidate(tenantId)` manually clears one cached route.
- `router.close()` unsubscribes from route events.

`TenantShardRouter` only resolves routing metadata. Use `TenantShardClientResolver` to bind that result to an application-owned shard pool or client:

```ts
import {
  createTenantShardClientResolver,
  createTenantRouter
} from "tenant-router";

const shardClients = new Map([
  ["shard-a", { name: "postgres pool for shard-a" }],
  ["shard-b", { name: "postgres pool for shard-b" }]
]);
const tenantClientResolver = createTenantShardClientResolver({
  routeResolver: router,
  shardClients: {
    getShardClient(shardId) {
      return shardClients.get(shardId) ?? null;
    }
  }
});

const { route, client } = await tenantClientResolver.resolve("acme");
// client is the application-owned client for route.shardId.
```

The library resolves route metadata and looks up an application-owned shard client. It does not create business-data pools, choose their pool sizes, or execute tenant SQL. The API service owns pool creation, reuse, and shutdown, so the router remains framework-neutral and can work with `pg.Pool`, another database client, or a test double.

Route warmup is optional. It is useful for memory caches during startup; the SQLite cache already persists entries across process restarts.

## Operator Queries

`RouteTopologyReader` is the read-only control-plane view used by operator tooling. It combines `tenant_router_routes` with `tenant_router_shards` and does not change routing.

```ts
import { createRouteTopologyReader } from "tenant-router";

const topologyReader = createRouteTopologyReader({
  routeStore,
  shardRegistry: routeStore
});

const shardLoad = await topologyReader.getShardLoad("shard-a");
const snapshot = await topologyReader.getTopologySnapshot();

console.log(shardLoad?.tenantCount, shardLoad?.loadScore);
console.log(snapshot.shards, snapshot.unassignedRoutes);
```

`tenantCount` counts current tenant-to-shard mappings. In the **local demo API**, topology `loadScore` is overwritten from **real** tenant query traffic: `POST /tenants/:id/query` runs shard `SELECT 1`s and records hits in Redis; QPS is hits over `DEMO_QPS_WINDOW_SEC` (default 5) ÷ `DEMO_LOAD_QPS_CAP` (default 100 = 100%; may exceed 1.0; never blocks placement). The control panel DB-icon query control (and the noisy-neighbour demo bursts) drive that traffic. Shared Redis counters keep `--scale api=N` gauges consistent. The library itself still treats persisted shard `loadScore` as an optional ops field and does not auto-route on it.

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

Commands also provide `assignTenantToShard`, `changeTenantTier`, and `disableTenant`. Tenant route changes and shard provisioning use a PostgreSQL transaction/outbox so the metadata write and eventual Redis event publication remain recoverable.

Shard definitions may include `capacity` and `loadScore` (`0.0` to `1.0`) for operator observability. These values do not currently change routing automatically; `TenantRoute.shardId` remains the routing source.

When the shard registry supports `getShard()`, route commands reject assignments to unknown shards. Shard provisioning trims the shard id and validates that `loadScore` stays between `0.0` and `1.0`.

Official adapters should implement the core interfaces:

- `createSqliteRouteCache(...)` implements `RouteCache` and is available from `tenant-router/node`.
- `createPostgresRouteStore(...)` implements `RouteStore`, `TenantRouteRegistry`, and `ShardRegistry`, and is available from `tenant-router/postgres`.
- `createRedisRouteEvents(...)` implements `RouteEventBus` through Redis Streams and is available from `tenant-router/redis`.

```ts
import {
  createPostgresOutboxWorker,
  createPostgresRouteStore
} from "tenant-router/postgres";
import { createTenantRouteCommands } from "tenant-router";
import { createRedisRouteEvents } from "tenant-router/redis";

const routeStore = createPostgresRouteStore({
  connectionString: process.env.ROUTING_DATABASE_URL
});
const events = createRedisRouteEvents({
  url: process.env.REDIS_URL,
  streamKey: "tenant-router:route-events"
});

const commands = createTenantRouteCommands({
  routeRegistry: routeStore,
  shardRegistry: routeStore,
  events
});
```

Apply [`migrations/001_tenant_router.sql`](migrations/001_tenant_router.sql) before using the PostgreSQL adapter.

The Redis adapter writes each event to a stream and gives every API process its own cursor, so every router receives every route change. If a subscribed handler fails, the adapter calls the optional `onError` callback and continues consuming later events.

When PostgreSQL is used as the registry, tenant route changes and shard provisioning are also written to its outbox in the same transaction. Use the worker to retry events whose Redis publish did not complete:

```ts
const outboxWorker = createPostgresOutboxWorker(routeStore, events, {
  intervalMs: 5_000,
  batchSize: 100,
  onError: (error) => console.error("route outbox publish failed", error)
});
outboxWorker.start();

// During graceful shutdown:
await outboxWorker.stop();
await events.close();
await routeStore.close();
```

The PostgreSQL outbox publisher claims rows inside a transaction with `FOR UPDATE SKIP LOCKED`, so multiple worker instances can process separate batches. Delivery remains at-least-once: a crash after Redis accepts an event but before PostgreSQL marks it published can produce a duplicate, which consumers should handle through `eventId` and route-version checks.

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
