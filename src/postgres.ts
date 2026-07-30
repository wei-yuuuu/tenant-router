import { Pool, type PoolConfig, type QueryResultRow } from "pg";

import type {
  RouteStore,
  RouteEvent,
  RouteEventPublisher,
  ShardDefinition,
  ShardRegistry,
  TenantRoute,
  TenantRouteRegistry,
  AtomicTenantRouteRegistry
} from "./index.ts";
import { TenantRouterError } from "./index.ts";

export interface PostgresRouteStoreOptions {
  connectionString?: string;
  pool?: Pool;
  poolConfig?: Omit<PoolConfig, "connectionString">;
}

interface RouteRow extends QueryResultRow {
  tenant_id: string;
  shard_id: string;
  route_version: string | number;
  tier: string | null;
  status: string | null;
  reason: string | null;
  updated_at: Date;
  metadata: Record<string, unknown> | null;
}

interface ShardRow extends QueryResultRow {
  shard_id: string;
  name: string | null;
  status: string | null;
  region: string | null;
  capacity: number | null;
  load_score: number | null;
  metadata: Record<string, unknown> | null;
}

export function createPostgresRouteStore(
  options: PostgresRouteStoreOptions
): PostgresRouteStore {
  return new PostgresRouteStore(options);
}

export class PostgresRouteStore
  implements
    RouteStore,
    TenantRouteRegistry,
    AtomicTenantRouteRegistry,
    ShardRegistry
{
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(options: PostgresRouteStoreOptions) {
    if (!options || typeof options !== "object") {
      throw new TenantRouterError(
        "INVALID_POSTGRES_CONFIG",
        "Postgres route store options must be an object."
      );
    }

    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
      return;
    }

    if (!options.connectionString) {
      throw new TenantRouterError(
        "INVALID_POSTGRES_CONFIG",
        "Postgres route store requires a connectionString or pool."
      );
    }

    this.pool = new Pool({
      ...options.poolConfig,
      connectionString: options.connectionString
    });
    this.ownsPool = true;
  }

  async getTenantRoute(tenantId: string): Promise<TenantRoute | null> {
    const result = await this.pool.query<RouteRow>(
      `SELECT tenant_id, shard_id, route_version, tier, status, reason,
              updated_at, metadata
         FROM tenant_router_routes
        WHERE tenant_id = $1`,
      [normalizeId(tenantId, "tenant")]
    );

    return result.rows[0] ? mapRoute(result.rows[0]) : null;
  }

  async listTenantRoutes(): Promise<TenantRoute[]> {
    const result = await this.pool.query<RouteRow>(
      `SELECT tenant_id, shard_id, route_version, tier, status, reason,
              updated_at, metadata
         FROM tenant_router_routes
        ORDER BY tenant_id`
    );

    return result.rows.map(mapRoute);
  }

  async setTenantRoute(route: TenantRoute): Promise<void> {
    await this.pool.query(
      `INSERT INTO tenant_router_routes
        (tenant_id, shard_id, route_version, tier, status, reason, updated_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET
         shard_id = EXCLUDED.shard_id,
         route_version = EXCLUDED.route_version,
         tier = EXCLUDED.tier,
         status = EXCLUDED.status,
         reason = EXCLUDED.reason,
         updated_at = EXCLUDED.updated_at,
         metadata = EXCLUDED.metadata
       WHERE tenant_router_routes.route_version < EXCLUDED.route_version`,
      [
        normalizeId(route.tenantId, "tenant"),
        normalizeId(route.shardId, "shard"),
        route.routeVersion,
        route.tier ?? null,
        route.status ?? "active",
        route.reason ?? null,
        toDate(route.updatedAt),
        JSON.stringify(route.metadata ?? {})
      ]
    );
  }

  async deleteTenantRoute(tenantId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM tenant_router_routes WHERE tenant_id = $1",
      [normalizeId(tenantId, "tenant")]
    );
  }

  async persistRouteChange(route: TenantRoute, event: RouteEvent): Promise<void> {
    const client = await this.pool.connect();
    const eventId = event.eventId ?? `${route.tenantId}:${route.routeVersion}:${event.type}`;

    try {
      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO tenant_router_routes
          (tenant_id, shard_id, route_version, tier, status, reason, updated_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (tenant_id) DO UPDATE SET
           shard_id = EXCLUDED.shard_id,
           route_version = EXCLUDED.route_version,
           tier = EXCLUDED.tier,
           status = EXCLUDED.status,
           reason = EXCLUDED.reason,
           updated_at = EXCLUDED.updated_at,
           metadata = EXCLUDED.metadata
         WHERE tenant_router_routes.route_version < EXCLUDED.route_version
         RETURNING tenant_id`,
        [
          normalizeId(route.tenantId, "tenant"),
          normalizeId(route.shardId, "shard"),
          route.routeVersion,
          route.tier ?? null,
          route.status ?? "active",
          route.reason ?? null,
          toDate(route.updatedAt),
          JSON.stringify(route.metadata ?? {})
        ]
      );

      if ((result.rowCount ?? 0) > 0) {
        await client.query(
          `INSERT INTO tenant_router_route_events
            (event_id, event_type, tenant_id, route_version, event_json)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (event_id) DO NOTHING`,
          [
            eventId,
            event.type,
            route.tenantId,
            route.routeVersion,
            JSON.stringify({ ...event, eventId })
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markRouteEventPublished(eventId: string): Promise<void> {
    await this.pool.query(
      `UPDATE tenant_router_route_events
          SET published_at = now()
        WHERE event_id = $1 AND published_at IS NULL`,
      [eventId]
    );
  }

  async listPendingRouteEvents(): Promise<RouteEvent[]> {
    const result = await this.pool.query<{ event_json: RouteEvent }>(
      `SELECT event_json
         FROM tenant_router_route_events
        WHERE published_at IS NULL
        ORDER BY created_at, event_id`
    );

    return result.rows.map((row) => row.event_json);
  }

  async publishPendingRouteEvents(
    publisher: RouteEventPublisher
  ): Promise<number> {
    const pending = await this.listPendingRouteEvents();
    let published = 0;

    for (const event of pending) {
      await publisher.publish(event);
      if (event.eventId) {
        await this.markRouteEventPublished(event.eventId);
      }
      published += 1;
    }

    return published;
  }

  async setShard(shard: ShardDefinition): Promise<void> {
    await this.pool.query(
      `INSERT INTO tenant_router_shards
        (shard_id, name, status, region, capacity, load_score, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (shard_id) DO UPDATE SET
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         region = EXCLUDED.region,
         capacity = EXCLUDED.capacity,
         load_score = EXCLUDED.load_score,
         metadata = EXCLUDED.metadata,
         updated_at = now()`,
      [
        normalizeId(shard.id, "shard"),
        shard.name ?? null,
        shard.status ?? "active",
        shard.region ?? null,
        shard.capacity ?? null,
        shard.loadScore ?? null,
        JSON.stringify(shard.metadata ?? {})
      ]
    );
  }

  async getShard(shardId: string): Promise<ShardDefinition | null> {
    const result = await this.pool.query<ShardRow>(
      `SELECT shard_id, name, status, region, capacity, load_score, metadata
         FROM tenant_router_shards
        WHERE shard_id = $1`,
      [normalizeId(shardId, "shard")]
    );

    return result.rows[0] ? mapShard(result.rows[0]) : null;
  }

  async listShards(): Promise<ShardDefinition[]> {
    const result = await this.pool.query<ShardRow>(
      `SELECT shard_id, name, status, region, capacity, load_score, metadata
         FROM tenant_router_shards
        ORDER BY shard_id`
    );

    return result.rows.map(mapShard);
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}

function mapRoute(row: RouteRow): TenantRoute {
  return {
    tenantId: row.tenant_id,
    shardId: row.shard_id,
    routeVersion: Number(row.route_version),
    ...(row.tier === null ? {} : { tier: row.tier }),
    ...(row.status === null ? {} : { status: row.status }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    updatedAt: row.updated_at,
    metadata: row.metadata ?? {}
  };
}

function mapShard(row: ShardRow): ShardDefinition {
  return {
    id: row.shard_id,
    ...(row.name === null ? {} : { name: row.name }),
    ...(row.status === null ? {} : { status: row.status }),
    ...(row.region === null ? {} : { region: row.region }),
    ...(row.capacity === null ? {} : { capacity: row.capacity }),
    ...(row.load_score === null ? {} : { loadScore: row.load_score }),
    metadata: row.metadata ?? {}
  };
}

function normalizeId(value: string, kind: "tenant" | "shard"): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new TenantRouterError(
      kind === "tenant" ? "INVALID_TENANT_ID" : "INVALID_SHARD_ID",
      `${kind} id must be a non-empty string.`
    );
  }

  return normalized;
}

function toDate(value: Date | string | number | undefined): Date {
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TenantRouterError(
      "INVALID_ROUTE_DATE",
      "Route updatedAt must be a valid date."
    );
  }

  return date;
}
