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
import { createClient } from "redis";

import { createRedisRouteEvents } from "../src/redis.ts";

const port = readPort(process.env.PORT ?? "3000");
const instanceId = process.env.API_INSTANCE_ID ?? hostname();
const routingPoolMax = readPoolMax(process.env.ROUTING_POOL_MAX ?? "10");
const shardPoolMax = readPoolMax(process.env.SHARD_POOL_MAX ?? "10");
/** Local demo only: RouteStore may hold at most this many shards. */
const maxDemoShards = readPoolMax(process.env.MAX_DEMO_SHARDS ?? "10");
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
        maxDemoShards,
        shardPoolCount: shardPools.size
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/topology") {
      writeJson(response, 200, await withDemoLoadScores(await topology.getTopologySnapshot()));
      return;
    }

    const routeMatch = /^\/route\/([^/]+)$/.exec(requestUrl.pathname);
    if (request.method === "GET" && routeMatch) {
      const tenantId = decodeURIComponent(routeMatch[1]);
      const bypassCache =
        requestUrl.searchParams.get("bypassCache") === "1" ||
        requestUrl.searchParams.get("bypassCache") === "true";
      const explanation = await router.explain(tenantId, { bypassCache });
      if (!explanation.route) {
        writeJson(response, 404, {
          error: "TENANT_ROUTE_NOT_FOUND",
          tenantId,
          instanceId
        });
        return;
      }

      let shardClientAvailable = false;
      try {
        await tenantClientResolver.resolve(tenantId);
        shardClientAvailable = true;
      } catch (error) {
        if (!(error instanceof TenantShardClientNotFoundError)) {
          throw error;
        }
      }

      writeJson(response, 200, {
        instanceId,
        cacheHit: explanation.cacheHit,
        source: explanation.source,
        routeVersion: explanation.routeVersion,
        route: explanation.route,
        shardClientAvailable
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
      const shard = await provisionDemoShard(body);
      writeJson(response, 201, { shard, instanceId });
      return;
    }

    const deleteShardMatch = /^\/shards\/([^/]+)$/.exec(requestUrl.pathname);
    if (request.method === "DELETE" && deleteShardMatch) {
      const shardId = decodeURIComponent(deleteShardMatch[1]);
      const existing = await routeStore.listShards();
      if (existing.length <= 1) {
        throw new TenantRouterError(
          "SHARD_DELETE_FORBIDDEN",
          "Local demo keeps at least one shard."
        );
      }
      await commands.deleteShard(shardId);
      writeJson(response, 200, { deleted: shardId, instanceId });
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

    const queryMatch = /^\/tenants\/([^/]+)\/query$/.exec(requestUrl.pathname);
    if (request.method === "POST" && queryMatch) {
      const tenantId = decodeURIComponent(queryMatch[1]);
      const body = await readJsonBody(request);
      const count = Math.min(
        50,
        Math.max(1, Math.floor(optionalNumber(body, "count") ?? 1))
      );
      const resolved = await tenantClientResolver.resolve(tenantId);
      const pool = resolved.client as Pool;
      // Real shard traffic for the demo gauge (not synthetic background chatter).
      for (let i = 0; i < count; i += 1) {
        await pool.query("SELECT 1");
      }
      await recordDemoShardHits(resolved.route.shardId, count);
      writeJson(response, 200, {
        tenantId,
        shardId: resolved.route.shardId,
        queries: count,
        instanceId,
        route: resolved.route
      });
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

/**
 * Demo load = real tenant query rate (POST /tenants/:id/query → shard SELECT).
 * Hits are stored in Redis so every API replica reports the same QPS.
 * Soft cap DEMO_LOAD_QPS_CAP (default 100) ⇒ 100%; may exceed 1.0. Never blocks create/move.
 */
const demoLoadQpsCap = readPositiveInt("DEMO_LOAD_QPS_CAP", process.env.DEMO_LOAD_QPS_CAP ?? "100", 1);
const demoQpsWindowSec = readPositiveInt("DEMO_QPS_WINDOW_SEC", process.env.DEMO_QPS_WINDOW_SEC ?? "5", 2);
const demoHitsKeyPrefix = process.env.DEMO_HITS_KEY_PREFIX ?? "tenant-router:demo-hits";

const demoRedis = createClient({ url: redisUrl });
demoRedis.on("error", (error) => {
  console.error(`[${instanceId}] demo redis error`, error);
});
await demoRedis.connect();

function demoHitsKey(shardId: string, epochSec: number): string {
  return `${demoHitsKeyPrefix}:${shardId}:${epochSec}`;
}

async function recordDemoShardHits(shardId: string, count: number): Promise<void> {
  if (!Number.isFinite(count) || count <= 0) {
    return;
  }
  const epoch = Math.floor(Date.now() / 1000);
  const key = demoHitsKey(shardId, epoch);
  const next = await demoRedis.incrBy(key, Math.floor(count));
  if (next === Math.floor(count)) {
    // First write in this second — expire after the window (+skew).
    await demoRedis.expire(key, demoQpsWindowSec + 2);
  }
}

async function readDemoShardQps(shardId: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const keys = [];
  for (let i = 0; i < demoQpsWindowSec; i += 1) {
    keys.push(demoHitsKey(shardId, now - i));
  }
  const values = await demoRedis.mGet(keys);
  let hits = 0;
  for (const value of values) {
    const n = Number(value ?? 0);
    if (Number.isFinite(n)) {
      hits += n;
    }
  }
  return hits / demoQpsWindowSec;
}

async function withDemoLoadScores(
  snapshot: Awaited<ReturnType<typeof topology.getTopologySnapshot>>
) {
  const qpsByShard = new Map<string, number>();
  await Promise.all(
    snapshot.shards.map(async (entry) => {
      const shardId = entry.shard.id;
      if (!shardPools.has(shardId)) {
        qpsByShard.set(shardId, 0);
        return;
      }
      try {
        qpsByShard.set(shardId, await readDemoShardQps(shardId));
      } catch (error) {
        console.error(`[${instanceId}] demo qps read failed for ${shardId}`, error);
        qpsByShard.set(shardId, 0);
      }
    })
  );

  return {
    ...snapshot,
    shards: snapshot.shards.map((entry) => {
      const active = entry.tenants.filter((tenant) => tenant.status !== "disabled");
      const shardId = entry.shard.id;
      const qps = qpsByShard.get(shardId) ?? 0;
      const loadScore = qps / demoLoadQpsCap;
      const demoQps = Math.round(qps * 10) / 10;
      return {
        ...entry,
        tenantCount: active.length,
        shard: {
          ...entry.shard,
          loadScore,
          demoQps
        }
      };
    })
  };
}

await listen(server, port);
console.log(
  JSON.stringify({
    ok: true,
    instanceId,
    port,
    sqlitePath,
    streamKey,
    routingPoolMax,
    shardPoolMax,
    demoLoadQpsCap,
    demoQpsWindowSec
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
  try {
    await demoRedis.quit();
  } catch {
    // ignore quit races during shutdown
  }
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
  // Compose ships physical DBs for shard-1…4. shard-5…maxDemoShards are
  // RouteStore metadata unless SHARD_N_DATABASE_URL is set.
  const defaultPorts = new Map([
    ["shard-1", 5541],
    ["shard-2", 5542],
    ["shard-3", 5543],
    ["shard-4", 5544]
  ]);

  for (let n = 1; n <= maxDemoShards; n += 1) {
    const shardId = `shard-${n}`;
    const environmentKey = `SHARD_${n}_DATABASE_URL`;
    const fromEnv = process.env[environmentKey];
    const port = defaultPorts.get(shardId);
    if (!fromEnv && port === undefined) {
      continue;
    }
    const databaseUrl =
      fromEnv ??
      `postgres://shard:shard_local@localhost:${port}/${shardId.replace("-", "_")}`;
    pools.set(shardId, new Pool({ connectionString: databaseUrl, max: poolMax }));
  }
  return pools;
}

async function provisionDemoShard(
  body: Record<string, unknown>
): Promise<ShardDefinition> {
  const existing = await routeStore.listShards();
  const byId = new Map(existing.map((shard) => [shard.id, shard]));
  const requestedId = optionalString(body, "id");
  const shardId =
    requestedId !== undefined && requestedId.length > 0
      ? requestedId
      : nextFreeDemoShardId(existing);

  if (!byId.has(shardId) && existing.length >= maxDemoShards) {
    throw new TenantRouterError(
      "SHARD_LIMIT_REACHED",
      `Local demo allows at most ${maxDemoShards} shards (RouteStore metadata).`
    );
  }

  const definitionBody: Record<string, unknown> = { ...body, id: shardId };
  if (optionalString(definitionBody, "name") === undefined) {
    const n = /^shard-(\d+)$/.exec(shardId)?.[1];
    definitionBody.name = n ? `Local shard ${n}` : `Local ${shardId}`;
  }
  if (optionalString(definitionBody, "region") === undefined) {
    definitionBody.region = "local";
  }
  if (optionalString(definitionBody, "status") === undefined) {
    definitionBody.status = "active";
  }
  if (optionalNumber(definitionBody, "capacity") === undefined) {
    definitionBody.capacity = 1000;
  }
  if (optionalNumber(definitionBody, "loadScore") === undefined && !byId.has(shardId)) {
    definitionBody.loadScore = 0;
  }

  return commands.provisionShard(readShardDefinition(definitionBody));
}

function nextFreeDemoShardId(existing: ShardDefinition[]): string {
  const used = new Set(existing.map((shard) => shard.id));
  for (let n = 1; n <= maxDemoShards; n += 1) {
    const candidate = `shard-${n}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  throw new TenantRouterError(
    "SHARD_LIMIT_REACHED",
    `Local demo allows at most ${maxDemoShards} shards (RouteStore metadata).`
  );
}

function readPort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return parsed;
}

function readPositiveInt(label: string, value: string, minimum = 1): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return Math.floor(parsed);
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
