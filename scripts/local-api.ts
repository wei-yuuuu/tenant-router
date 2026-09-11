import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

import { Pool } from "pg";

import {
  createTenantRouteCommands,
  TenantRouteNotFoundError,
  TenantShardClientNotFoundError,
  TenantRouterError,
  createRouteTopologyReader,
  createTenantRouter,
  createTenantShardClientResolver
} from "../src/index.ts";
import type {
  AssignTenantToShardInput,
  ChangeTenantTierInput,
  DisableTenantInput,
  ShardDefinition
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
const commands = createTenantRouteCommands({
  routeRegistry: routeStore,
  shardRegistry: routeStore,
  events
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

    if (request.method === "POST" && requestUrl.pathname === "/tenants") {
      const body = await readJsonBody(request);
      const route = await commands.createTenant(readTenantAssignment(body));
      writeJson(response, 201, { route, instanceId });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/shards") {
      const body = await readJsonBody(request);
      const shard = await commands.provisionShard(readShardDefinition(body));
      writeJson(response, 201, { shard, instanceId });
      return;
    }

    const commandMatch = /^\/tenants\/([^/]+)\/(move|tier|disable)$/.exec(
      requestUrl.pathname
    );
    if (request.method === "POST" && commandMatch) {
      const tenantId = decodeURIComponent(commandMatch[1]);
      const body = await readJsonBody(request);

      if (commandMatch[2] === "move") {
        const route = await commands.moveTenantToShard({
          ...readTenantMove(body),
          tenantId
        });
        writeJson(response, 200, { route, instanceId });
        return;
      }

      if (commandMatch[2] === "tier") {
        const route = await commands.changeTenantTier({
          ...readTenantTierChange(body),
          tenantId
        });
        writeJson(response, 200, { route, instanceId });
        return;
      }

      const route = await commands.disableTenant({
        ...readTenantDisable(body),
        tenantId
      });
      writeJson(response, 200, { route, instanceId });
      return;
    }

    writeJson(response, 404, { error: "NOT_FOUND", instanceId });
  } catch (error) {
    if (error instanceof TenantRouterError) {
      writeJson(response, 400, {
        error: error.code,
        message: error.message,
        instanceId
      });
      return;
    }

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

async function readJsonBody(
  request: import("node:http").IncomingMessage
): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (body.length > 1_000_000) {
      throw new TenantRouterError(
        "REQUEST_BODY_TOO_LARGE",
        "Request body must be smaller than 1 MB."
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    throw new TenantRouterError(
      "INVALID_JSON",
      "Request body must contain valid JSON."
    );
  }

  if (!isRecord(parsed)) {
    throw new TenantRouterError(
      "INVALID_REQUEST",
      "Request body must be a JSON object."
    );
  }

  return parsed;
}

function readTenantAssignment(
  body: Record<string, unknown>
): AssignTenantToShardInput {
  const input: AssignTenantToShardInput = {
    tenantId: requiredString(body, "tenantId"),
    shardId: requiredString(body, "shardId")
  };
  const tier = optionalString(body, "tier");
  const reason = optionalString(body, "reason");
  const metadata = optionalRecord(body, "metadata");

  if (tier !== undefined) {
    input.tier = tier;
  }
  if (reason !== undefined) {
    input.reason = reason;
  }
  if (metadata !== undefined) {
    input.metadata = metadata;
  }

  return input;
}

function readTenantMove(
  body: Record<string, unknown>
): Omit<AssignTenantToShardInput, "tenantId"> {
  const input: Omit<AssignTenantToShardInput, "tenantId"> = {
    shardId: requiredString(body, "shardId")
  };
  const tier = optionalString(body, "tier");
  const reason = optionalString(body, "reason");
  const metadata = optionalRecord(body, "metadata");

  if (tier !== undefined) {
    input.tier = tier;
  }
  if (reason !== undefined) {
    input.reason = reason;
  }
  if (metadata !== undefined) {
    input.metadata = metadata;
  }

  return input;
}

function readTenantTierChange(
  body: Record<string, unknown>
): Omit<ChangeTenantTierInput, "tenantId"> {
  return {
    tier: requiredString(body, "tier"),
    reason: optionalString(body, "reason")
  };
}

function readTenantDisable(
  body: Record<string, unknown>
): Omit<DisableTenantInput, "tenantId"> {
  return { reason: optionalString(body, "reason") };
}

function readShardDefinition(
  body: Record<string, unknown>
): ShardDefinition {
  const shard: ShardDefinition = { id: requiredString(body, "id") };
  const name = optionalString(body, "name");
  const status = optionalString(body, "status");
  const region = optionalString(body, "region");
  const capacity = optionalNumber(body, "capacity");
  const loadScore = optionalNumber(body, "loadScore");
  const metadata = optionalRecord(body, "metadata");

  if (name !== undefined) {
    shard.name = name;
  }
  if (status !== undefined) {
    shard.status = status;
  }
  if (region !== undefined) {
    shard.region = region;
  }
  if (capacity !== undefined) {
    shard.capacity = capacity;
  }
  if (loadScore !== undefined) {
    shard.loadScore = loadScore;
  }
  if (metadata !== undefined) {
    shard.metadata = metadata;
  }

  return shard;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new TenantRouterError(
      "INVALID_REQUEST",
      `Request field "${key}" must be a non-empty string.`
    );
  }
  return value;
}

function optionalString(
  body: Record<string, unknown>,
  key: string
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TenantRouterError(
      "INVALID_REQUEST",
      `Request field "${key}" must be a string.`
    );
  }
  return value;
}

function optionalNumber(
  body: Record<string, unknown>,
  key: string
): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TenantRouterError(
      "INVALID_REQUEST",
      `Request field "${key}" must be a finite number.`
    );
  }
  return value;
}

function optionalRecord(
  body: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new TenantRouterError(
      "INVALID_REQUEST",
      `Request field "${key}" must be a JSON object.`
    );
  }
  return value;
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
