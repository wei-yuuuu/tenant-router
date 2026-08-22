# Database Schema

This document is the field reference for every database file and table owned by `tenant-router`.

## SQLite Route Cache

Created by `createSqliteRouteCache({ path })` from `tenant-router/node`.

The SQLite database is a process-local cache, not the route source of truth. Entries may be deleted at any time by TTL expiry, route events, or `router.invalidate()`.

### `tenant_router_routes`

| Column | SQLite type | Nullable | Description |
| --- | --- | --- | --- |
| `tenant_id` | `TEXT` | No | Primary key. The normalized tenant identifier used for lookup. |
| `route_json` | `TEXT` | No | JSON-serialized `TenantRoute`, including `tenantId`, `shardId`, `routeVersion`, and optional route metadata. |
| `expires_at` | `INTEGER` | Yes | Unix epoch in milliseconds. `NULL` means no TTL. Expired entries are removed on lookup. |
| `updated_at` | `INTEGER` | No | Unix epoch in milliseconds when this cache entry was last written. |

The table uses SQLite `STRICT` mode. `tenant_id` is the only index because every cache operation is a point lookup by tenant id.

### Inspect Routes

Replace `data/tenant-routes.sqlite` with the `path` supplied to `createSqliteRouteCache`.

```sh
sqlite3 -header -column data/tenant-routes.sqlite "
  SELECT
    tenant_id,
    json_extract(route_json, '$.shardId') AS shard_id,
    json_extract(route_json, '$.routeVersion') AS route_version,
    CASE
      WHEN expires_at IS NULL THEN 'never'
      ELSE datetime(expires_at / 1000, 'unixepoch', 'localtime')
    END AS expires_at,
    datetime(updated_at / 1000, 'unixepoch', 'localtime') AS updated_at
  FROM tenant_router_routes
  ORDER BY updated_at DESC;
"
```

### Inspect One Tenant

```sh
sqlite3 -header -column data/tenant-routes.sqlite "
  SELECT
    tenant_id,
    route_json,
    expires_at,
    updated_at
  FROM tenant_router_routes
  WHERE tenant_id = 'acme';
"
```

## PostgreSQL Route Store

The PostgreSQL schema is defined in [`migrations/001_tenant_router.sql`](../migrations/001_tenant_router.sql). PostgreSQL is the route source of truth; SQLite remains a local API cache.

### `tenant_router_shards`

| Column | PostgreSQL type | Nullable | Description |
| --- | --- | --- | --- |
| `shard_id` | `TEXT` | No | Primary key used by tenant routes and application shard pools. |
| `name` | `TEXT` | Yes | Human-readable shard name. |
| `status` | `TEXT` | No | Shard lifecycle status, such as `active`, `draining`, or `disabled`. |
| `region` | `TEXT` | Yes | Deployment region or placement label. |
| `capacity` | `INTEGER` | Yes | Optional shard capacity limit. |
| `load_score` | `DOUBLE PRECISION` | Yes | Optional current load score used by operator tooling. |
| `metadata` | `JSONB` | No | Adapter-specific shard metadata. |
| `created_at` | `TIMESTAMPTZ` | No | Shard record creation time. |
| `updated_at` | `TIMESTAMPTZ` | No | Last shard record update time. |

### `tenant_router_routes`

| Column | PostgreSQL type | Nullable | Description |
| --- | --- | --- | --- |
| `tenant_id` | `TEXT` | No | Primary key and normalized tenant identifier. |
| `shard_id` | `TEXT` | No | Foreign key to `tenant_router_shards.shard_id`. |
| `route_version` | `BIGINT` | No | Monotonically increasing route version used to reject stale writes. |
| `tier` | `TEXT` | Yes | Tenant tier, such as `free`, `pro`, or `enterprise`. |
| `status` | `TEXT` | No | Tenant route status, such as `active`, `moving`, or `disabled`. |
| `reason` | `TEXT` | Yes | Operator or command reason for the latest route change. |
| `updated_at` | `TIMESTAMPTZ` | No | Last route update time. |
| `metadata` | `JSONB` | No | Adapter-specific tenant route metadata. |

### `tenant_router_route_events`

This is the PostgreSQL outbox. A tenant route or shard change and its pending event are inserted in the same transaction. `published_at` stays `NULL` until Redis accepts the event.

| Column | PostgreSQL type | Nullable | Description |
| --- | --- | --- | --- |
| `event_id` | `TEXT` | No | Idempotent event identifier, derived from tenant, route version, and event type. |
| `event_type` | `TEXT` | No | Route event type, such as `tenant.created` or `tenant.moved`. |
| `tenant_id` | `TEXT` | Yes | Tenant affected by the route event; `NULL` for shard events. |
| `route_version` | `BIGINT` | Yes | Route version carried by the event. |
| `event_json` | `JSONB` | No | Complete serialized `RouteEvent` payload. |
| `created_at` | `TIMESTAMPTZ` | No | Time the outbox event was created. |
| `published_at` | `TIMESTAMPTZ` | Yes | Time Redis accepted the event; `NULL` means pending retry. |

### Inspect Routes

```sh
psql "$ROUTING_DATABASE_URL" -c "
  SELECT
    tenant_id,
    shard_id,
    route_version,
    tier,
    status,
    reason,
    updated_at
  FROM tenant_router_routes
  ORDER BY updated_at DESC;
"
```

### Inspect Shards

```sh
psql "$ROUTING_DATABASE_URL" -c "
  SELECT
    shard_id,
    name,
    status,
    region,
    capacity,
    load_score,
    updated_at
  FROM tenant_router_shards
  ORDER BY shard_id;
"
```

### Inspect Pending Events

```sh
psql "$ROUTING_DATABASE_URL" -c "
  SELECT
    event_id,
    event_type,
    tenant_id,
    route_version,
    created_at
  FROM tenant_router_route_events
  WHERE published_at IS NULL
  ORDER BY created_at, event_id;
"
```

## Redis Route Events

The Redis adapter uses a stream as the durable event log. Its default key is `tenant-router:route-events`; configure `streamKey` to use a different key.

### Stream Entry Fields

| Field | Redis type | Description |
| --- | --- | --- |
| Redis entry id | Stream ID | Generated by Redis when the event is appended. |
| `event` | `TEXT` | JSON-serialized `RouteEvent`, including the route payload when a cache can be refreshed directly. |

Each API process reads the stream with its own cursor. This provides fan-out: one route event is delivered to every router instead of being divided between API instances in a shared consumer group.

### Inspect Recent Events

```sh
redis-cli XRANGE tenant-router:route-events - + COUNT 20
```
