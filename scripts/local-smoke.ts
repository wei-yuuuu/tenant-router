import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRouteTopologyReader,
  createTenantRouteCommands,
  createTenantRouter
} from "../src/index.ts";
import { createSqliteRouteCache } from "../src/node.ts";
import { createPostgresRouteStore } from "../src/postgres.ts";
import { createRedisRouteEvents } from "../src/redis.ts";

const routingDatabaseUrl =
  process.env.ROUTING_DATABASE_URL ??
  "postgres://tenant_router:tenant_router_local@localhost:5432/tenant_router";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const tenantId = `local-smoke-${randomUUID()}`;
const streamKey = `tenant-router:local-smoke:${randomUUID()}`;
const directory = mkdtempSync(join(tmpdir(), "tenant-router-smoke-"));
const cache = createSqliteRouteCache({
  path: join(directory, "routes.sqlite")
});
const routeStore = createPostgresRouteStore({
  connectionString: routingDatabaseUrl
});
const events = createRedisRouteEvents({
  url: redisUrl,
  streamKey,
  blockMs: 50,
  onError: (error) => {
    throw error;
  }
});
const router = createTenantRouter({
  routeStore,
  events,
  cache
});
const commands = createTenantRouteCommands({
  routeRegistry: routeStore,
  shardRegistry: routeStore,
  events
});
const topology = createRouteTopologyReader({
  routeStore,
  shardRegistry: routeStore
});

async function waitFor(
  check: () => boolean,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms while waiting for local smoke state.`
  );
}

try {
  await commands.createTenant({
    tenantId,
    shardId: "shard-1",
    tier: "pro",
    reason: "local smoke test"
  });
  await waitFor(() => cache.get(tenantId)?.shardId === "shard-1");

  await commands.moveTenantToShard({
    tenantId,
    shardId: "shard-2",
    reason: "local smoke move"
  });
  await waitFor(() => cache.get(tenantId)?.shardId === "shard-2");

  const route = await router.resolve(tenantId);
  const shardLoad = await topology.getShardLoad("shard-2");
  const snapshot = await topology.getTopologySnapshot();

  assert.equal(route.shardId, "shard-2");
  assert.equal(route.routeVersion, 2);
  assert.equal(shardLoad?.tenantCount, 1);
  assert.equal(
    snapshot.unassignedRoutes.some(
      (candidate) => candidate.tenantId === tenantId
    ),
    false
  );

  console.log(
    JSON.stringify({
      ok: true,
      tenantId,
      route: {
        shardId: route.shardId,
        routeVersion: route.routeVersion
      },
      shardLoad: {
        shardId: shardLoad?.shard.id,
        tenantCount: shardLoad?.tenantCount
      }
    })
  );
} finally {
  await router.close();
  await events.close();
  await routeStore.deleteTenantRoute(tenantId);
  await routeStore.close();
  cache.close();
  rmSync(directory, { recursive: true, force: true });
}
