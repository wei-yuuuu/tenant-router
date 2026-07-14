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

`postgresRouteStore` is not implemented yet, so its physical tables and columns are intentionally not defined here. When it is added, its migration and complete field reference will be documented in this file before the adapter is released.
