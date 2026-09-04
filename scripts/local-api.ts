import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

import { Pool } from "pg";

import {
  TenantRouteNotFoundError,
  TenantShardClientNotFoundError,
  createRouteTopologyReader,
  createTenantRouter,
  createTenantShardClientResolver
} from "../src/index.ts";
import { createSqliteRouteCache } from "../src/node.ts";
import { createPostgresRouteStore } from "../src/postgres.ts";
import { createRedisRouteEvents } from "../src/redis.ts";

const port = readPort(process.env.PORT ?? "3000");
const instanceId = process.env.API_INSTANCE_ID ?? hostname();
const routingPoolMax = readPoolMax(process.env.ROUTING_POOL_MAX ?? "10");
const shardPoolMax = readPoolMax(process.env.SHARD_POOL_MAX ?? "10");
const routingDatabaseUrl =
  process.env.ROUTING_DATABASE_URL ??
  "postgres://tenant_router:tenant_router_local@routing-postgres:5432/tenant_router";
const redisUrl = process.env.REDIS_URL ?? "redis://redis:6379";
const streamKey = process.env.REDIS_STREAM_KEY ?? "tenant-router:route-events";
const sqlitePath =
  process.env.SQLITE_CACHE_PATH ?? `/tmp/tenant-router/${instanceId}.sqlite`;

mkdirSync(dirname(sqlitePath), { recursive: true });

const cache = createSqliteRouteCache({ path: sqlitePath });
const routeStore = createPostgresRouteStore({
  connectionString: routingDatabaseUrl,
  poolConfig: { max: routingPoolMax }
});
const events = createRedisRouteEvents({
  url: redisUrl,
  streamKey,
  onError: (error) => {
    console.error(`[${instanceId}] route event error`, error);
  }
});
const router = createTenantRouter({ routeStore, events, cache });
const topology = createRouteTopologyReader({
  routeStore,
  shardRegistry: routeStore
});
const shardPools = createShardPools(shardPoolMax);
const tenantClientResolver = createTenantShardClientResolver({
  routeResolver: router,
  shardClients: {
    getShardClient(shardId) {
      return shardPools.get(shardId) ?? null;
    }
  }
});

await router.warmup();

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`
    );

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      writeJson(response, 200, {
        ok: true,
        instanceId,
        pid: process.pid,
        cache: "sqlite",
        streamKey,
        routingPoolMax,
        shardPoolMax,
        shardCount: shardPools.size
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/topology") {
      writeJson(response, 200, await topology.getTopologySnapshot());
      return;
    }

    const routeMatch = /^\/route\/([^/]+)$/.exec(requestUrl.pathname);
    if (request.method === "GET" && routeMatch) {
      const tenantId = decodeURIComponent(routeMatch[1]);
      const explanation = await router.explain(tenantId);
      if (!explanation.route) {
        writeJson(response, 404, {
          error: "TENANT_ROUTE_NOT_FOUND",
          tenantId,
          instanceId
        });
        return;
      }

      const resolved = await tenantClientResolver.resolve(tenantId);
      writeJson(response, 200, {
        instanceId,
        cacheHit: explanation.cacheHit,
        source: explanation.source,
        route: resolved.route,
        shardClientAvailable: true
      });
      return;
    }

    writeJson(response, 404, { error: "NOT_FOUND", instanceId });
  } catch (error) {
    if (error instanceof TenantRouteNotFoundError) {
      writeJson(response, 404, {
        error: "TENANT_ROUTE_NOT_FOUND",
        tenantId: error.tenantId,
        instanceId
      });
      return;
    }

    if (error instanceof TenantShardClientNotFoundError) {
      writeJson(response, 503, {
        error: "SHARD_CLIENT_NOT_FOUND",
        tenantId: error.tenantId,
        shardId: error.shardId,
        instanceId
      });
      return;
    }

    console.error(`[${instanceId}] request error`, error);
    writeJson(response, 500, { error: "INTERNAL_ERROR", instanceId });
  }
});

await listen(server, port);
console.log(
  JSON.stringify({
    ok: true,
    instanceId,
    port,
    sqlitePath,
    streamKey,
    routingPoolMax,
    shardPoolMax
  })
);

let closing = false;
async function close(): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await router.close();
  await events.close();
  await Promise.all([...shardPools.values()].map((pool) => pool.end()));
  await routeStore.close();
  cache.close();
}

process.once("SIGINT", () => {
  void close().then(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void close().then(() => process.exit(0));
});

function createShardPools(poolMax: number): Map<string, Pool> {
  const pools = new Map<string, Pool>();
  const defaultPorts = new Map([
    ["shard-1", 5541],
    ["shard-2", 5542],
    ["shard-3", 5543],
    ["shard-4", 5544]
  ]);

  for (const [shardId, port] of defaultPorts) {
    const environmentKey = `${shardId.replace("-", "_").toUpperCase()}_DATABASE_URL`;
    const databaseUrl =
      process.env[environmentKey] ??
      `postgres://shard:shard_local@localhost:${port}/${shardId.replace("-", "_")}`;
    pools.set(shardId, new Pool({ connectionString: databaseUrl, max: poolMax }));
  }
  return pools;
}

function readPort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return parsed;
}

function readPoolMax(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid pool max: ${value}`);
  }
  return parsed;
}

function writeJson(
  response: import("node:http").ServerResponse,
  statusCode: number,
  value: unknown
): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function listen(
  serverToStart: import("node:http").Server,
  portToUse: number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    serverToStart.once("error", reject);
    serverToStart.listen(portToUse, "0.0.0.0", () => {
      serverToStart.off("error", reject);
      resolve();
    });
  });
}
