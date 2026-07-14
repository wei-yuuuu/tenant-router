import { DatabaseSync } from "node:sqlite";

import type { RouteCache, TenantRoute } from "./index.ts";
import { TenantRouterError } from "./index.ts";

export interface SqliteRouteCacheOptions {
  path: string | URL;
  ttlMs?: number;
}

interface SqliteCacheRow {
  route_json: string;
}

export function createSqliteRouteCache<
  TRoute extends TenantRoute = TenantRoute
>(options: SqliteRouteCacheOptions): SqliteRouteCache<TRoute> {
  return new SqliteRouteCache(options);
}

/**
 * A durable, process-local RouteCache backed by Node's built-in SQLite module.
 * It is a cache only; RouteStore remains the authoritative route source.
 */
export class SqliteRouteCache<TRoute extends TenantRoute = TenantRoute>
  implements RouteCache<TRoute>
{
  private readonly database: DatabaseSync;
  private readonly ttlMs?: number;

  constructor(options: SqliteRouteCacheOptions) {
    if (!options || typeof options !== "object" || !options.path) {
      throw new TenantRouterError(
        "INVALID_SQLITE_CACHE_CONFIG",
        "SQLite route cache requires a database path."
      );
    }

    if (
      options.ttlMs !== undefined &&
      (!Number.isFinite(options.ttlMs) || options.ttlMs < 0)
    ) {
      throw new TenantRouterError(
        "INVALID_CACHE_TTL",
        "SQLite route cache ttlMs must be a non-negative finite number."
      );
    }

    this.database = new DatabaseSync(options.path);
    this.ttlMs = options.ttlMs;
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS tenant_router_routes (
        tenant_id TEXT PRIMARY KEY,
        route_json TEXT NOT NULL,
        expires_at INTEGER,
        updated_at INTEGER NOT NULL
      ) STRICT
    `);
  }

  get(tenantId: string): TRoute | null {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const now = Date.now();
    const row = this.database
      .prepare(
        `SELECT route_json
         FROM tenant_router_routes
         WHERE tenant_id = ? AND (expires_at IS NULL OR expires_at > ?)`
      )
      .get(normalizedTenantId, now) as SqliteCacheRow | undefined;

    if (row) {
      return JSON.parse(row.route_json) as TRoute;
    }

    this.database
      .prepare(
        "DELETE FROM tenant_router_routes WHERE tenant_id = ? AND expires_at IS NOT NULL AND expires_at <= ?"
      )
      .run(normalizedTenantId, now);
    return null;
  }

  set(route: TRoute): void {
    const tenantId = normalizeTenantId(route.tenantId);
    const now = Date.now();
    const expiresAt = this.ttlMs === undefined ? null : now + this.ttlMs;

    this.database
      .prepare(
        `INSERT INTO tenant_router_routes (tenant_id, route_json, expires_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
           route_json = excluded.route_json,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`
      )
      .run(tenantId, JSON.stringify(route), expiresAt, now);
  }

  delete(tenantId: string): void {
    this.database
      .prepare("DELETE FROM tenant_router_routes WHERE tenant_id = ?")
      .run(normalizeTenantId(tenantId));
  }

  clear(): void {
    this.database.exec("DELETE FROM tenant_router_routes");
  }

  close(): void {
    this.database.close();
  }
}

function normalizeTenantId(tenantId: string): string {
  const normalizedTenantId = String(tenantId ?? "").trim();
  if (!normalizedTenantId) {
    throw new TenantRouterError(
      "INVALID_TENANT_ID",
      "Tenant id must be a non-empty string."
    );
  }

  return normalizedTenantId;
}
