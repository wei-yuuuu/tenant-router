import assert from "assert";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  TenantRouteNotFoundError,
  TenantRouterError,
  createRouteTopologyReader,
  createTenantRouteCommands,
  createMemoryRouteEvents,
  createMemoryRouteStore,
  createTenantMatcher,
  createTenantRouter,
  matchTenant
} from "../src/index.ts";
import { createSqliteRouteCache } from "../src/node.ts";
import {
  createPostgresOutboxWorker,
  createPostgresRouteStore
} from "../src/postgres.ts";
import { createRedisRouteEvents } from "../src/redis.ts";

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

const matcher = createTenantMatcher({
  baseDomain: "example.com",
  fallbackTenantId: "public",
  tenants: [
    {
      id: "public",
      domains: ["example.com"]
    },
    {
      id: "acme",
      domains: ["acme.example.com", "*.acme.test"],
      subdomains: ["acme"],
      pathPrefixes: ["/acme"],
      headers: {
        "x-tenant-id": ["acme", "acme-prod"]
      }
    },
    {
      id: "beta",
      domains: ["beta.example.com"],
      pathPrefixes: ["/beta", "/beta-admin"]
    }
  ]
});

test("resolves exact host matches", () => {
  const result = matcher.resolve("https://acme.example.com/dashboard");

  assert.equal(result.matched, true);
  assert.equal(result.tenantId, "acme");
  assert.equal(result.source, "host");
  assert.equal(result.pattern, "acme.example.com");
});

test("resolves wildcard host matches", () => {
  const result = matcher.resolve({
    host: "app.acme.test:3000",
    path: "/settings"
  });

  assert.equal(result.tenantId, "acme");
  assert.equal(result.source, "host");
  assert.equal(result.pattern, "*.acme.test");
});

test("resolves subdomains through baseDomain", () => {
  const result = matcher.resolve({
    headers: {
      host: "acme.example.com"
    }
  });

  assert.equal(result.tenantId, "acme");
  assert.equal(result.source, "host");
});

test("header matches have priority over host matches", () => {
  const result = matcher.resolve({
    host: "beta.example.com",
    path: "/dashboard",
    headers: {
      "x-tenant-id": "acme"
    }
  });

  assert.equal(result.tenantId, "acme");
  assert.equal(result.source, "header");
});

test("resolves the longest path prefix", () => {
  const result = matcher.resolve("/beta-admin/users");

  assert.equal(result.tenantId, "beta");
  assert.equal(result.source, "path");
  assert.equal(result.pattern, "/beta-admin");
});

test("uses fallback when no rule matches", () => {
  const result = matcher.resolve({
    host: "unknown.example.net",
    path: "/missing"
  });

  assert.equal(result.matched, false);
  assert.equal(result.tenantId, "public");
  assert.equal(result.source, "fallback");
});

test("can include public candidate details", () => {
  const result = matcher.resolve("https://acme.example.com/acme", {
    includeCandidates: true
  });

  assert.equal(result.tenantId, "acme");
  assert.ok(Array.isArray(result.candidates));
  assert.ok(result.candidates.length >= 2);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.source),
    ["host", "path"]
  );
});

test("supports Headers-like input", () => {
  const result = matcher.resolve({
    headers: {
      get(name) {
        return {
          host: "beta.example.com",
          "x-tenant-id": "acme-prod"
        }[name.toLowerCase()];
      }
    }
  });

  assert.equal(result.tenantId, "acme");
  assert.equal(result.source, "header");
});

test("one-off matchTenant helper resolves with config", () => {
  const result = matchTenant("https://team.example.com", {
    tenants: [{ id: "team", domains: "team.example.com" }]
  });

  assert.equal(result.tenantId, "team");
});

test("throws on duplicate tenant ids", () => {
  assert.throws(
    () =>
      createTenantMatcher({
        tenants: [{ id: "same" }, { id: "same" }]
      }),
    (error) =>
      error instanceof TenantRouterError &&
      error.code === "DUPLICATE_TENANT_ID"
  );
});

test("resolves tenant ids to shard routes from the route store", async () => {
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
  const router = createTenantRouter({ routeStore });

  const route = await router.resolve("acme");

  assert.equal(route.tenantId, "acme");
  assert.equal(route.shardId, "shard-a");
  assert.equal(route.routeVersion, 1);
});

test("explains cache hits after the first route store lookup", async () => {
  const routeStore = createMemoryRouteStore({
    routes: [{ tenantId: "beta", shardId: "shard-b", routeVersion: 7 }]
  });
  const router = createTenantRouter({ routeStore });

  const first = await router.explain("beta");
  const second = await router.explain("beta");

  assert.equal(first.source, "store");
  assert.equal(first.cacheHit, false);
  assert.equal(second.source, "cache");
  assert.equal(second.cacheHit, true);
  assert.equal(second.routeVersion, 7);
});

test("invalidates cached routes from route events", async () => {
  const routeStore = createMemoryRouteStore({
    routes: [{ tenantId: "enterprise", shardId: "shard-1", routeVersion: 1 }]
  });
  const events = createMemoryRouteEvents();
  const router = createTenantRouter({ routeStore, events });

  assert.equal((await router.resolve("enterprise")).shardId, "shard-1");

  routeStore.setTenantRoute({
    tenantId: "enterprise",
    shardId: "shard-2",
    routeVersion: 2
  });
  await events.publish({
    type: "tenant.moved",
    tenantId: "enterprise",
    shardId: "shard-2",
    routeVersion: 2
  });

  const route = await router.resolve("enterprise");
  assert.equal(route.shardId, "shard-2");
  assert.equal(route.routeVersion, 2);

  await router.close();
});

test("route events with route payload refresh the cache directly", async () => {
  const routeStore = createMemoryRouteStore({
    routes: [{ tenantId: "free-1", shardId: "shard-old", routeVersion: 1 }]
  });
  const events = createMemoryRouteEvents();
  const router = createTenantRouter({ routeStore, events });

  await router.resolve("free-1");
  await events.publish({
    type: "tenant.assigned",
    tenantId: "free-1",
    route: {
      tenantId: "free-1",
      shardId: "shard-new",
      routeVersion: 2,
      tier: "free"
    }
  });

  const explained = await router.explain("free-1");
  assert.equal(explained.source, "cache");
  assert.equal(explained.route.shardId, "shard-new");
  assert.equal(explained.routeVersion, 2);

  await router.close();
});

test("throws a specific error when a tenant route does not exist", async () => {
  const router = createTenantRouter({
    routeStore: createMemoryRouteStore()
  });

  await assert.rejects(
    () => router.resolve("missing"),
    (error) =>
      error instanceof TenantRouteNotFoundError &&
      error.tenantId === "missing"
  );
});

test("uses the SQLite route cache through the router", async () => {
  const routeStore = createMemoryRouteStore({
    routes: [{ tenantId: "sqlite", shardId: "shard-a", routeVersion: 1 }]
  });
  const cache = createSqliteRouteCache({ path: ":memory:" });
  const router = createTenantRouter({ routeStore, cache });

  assert.equal((await router.explain("sqlite")).source, "store");
  routeStore.setTenantRoute({
    tenantId: "sqlite",
    shardId: "shard-b",
    routeVersion: 2
  });
  assert.equal((await router.explain("sqlite")).route.shardId, "shard-a");

  await router.invalidate("sqlite");
  assert.equal((await router.resolve("sqlite")).shardId, "shard-b");

  await router.close();
  cache.close();
});

test("retains SQLite route cache entries after reopening the database", () => {
  const directory = mkdtempSync(join(tmpdir(), "tenant-router-"));
  const path = join(directory, "routes.db");

  try {
    const firstCache = createSqliteRouteCache({ path });
    firstCache.set({
      tenantId: "persistent",
      shardId: "shard-a",
      routeVersion: 1
    });
    firstCache.close();

    const reopenedCache = createSqliteRouteCache({ path });
    assert.equal(reopenedCache.get("persistent").shardId, "shard-a");
    reopenedCache.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("commands persist routes and refresh subscribed routers", async () => {
  const routeRegistry = createMemoryRouteStore();
  const events = createMemoryRouteEvents();
  const commands = createTenantRouteCommands({
    routeRegistry,
    shardRegistry: routeRegistry,
    events,
    now: () => new Date("2026-07-23T00:00:00.000Z")
  });
  const router = createTenantRouter({ routeStore: routeRegistry, events });

  await commands.provisionShard({ id: "shard-a", region: "ap-northeast-1" });
  const created = await commands.createTenant({
    tenantId: "acme",
    shardId: "shard-a",
    tier: "pro"
  });

  assert.equal(created.routeVersion, 1);
  assert.equal((await router.resolve("acme")).shardId, "shard-a");

  await commands.moveTenantToShard({
    tenantId: "acme",
    shardId: "shard-b",
    reason: "rebalance"
  });

  const route = await router.resolve("acme");
  assert.equal(route.shardId, "shard-b");
  assert.equal(route.routeVersion, 2);
  assert.equal(route.reason, "rebalance");

  await commands.changeTenantTier({ tenantId: "acme", tier: "enterprise" });
  assert.equal((await router.resolve("acme")).tier, "enterprise");

  await commands.disableTenant({ tenantId: "acme", reason: "account closed" });
  const disabledRoute = await router.resolve("acme");
  assert.equal(disabledRoute.status, "disabled");
  assert.equal(disabledRoute.routeVersion, 4);

  await router.close();
});

test("commands reject duplicate tenant creation and unknown tenant moves", async () => {
  const routeRegistry = createMemoryRouteStore({
    routes: [{ tenantId: "acme", shardId: "shard-a", routeVersion: 1 }]
  });
  const commands = createTenantRouteCommands({
    routeRegistry,
    shardRegistry: routeRegistry,
    events: createMemoryRouteEvents()
  });

  await assert.rejects(
    () => commands.createTenant({ tenantId: "acme", shardId: "shard-b" }),
    (error) =>
      error instanceof TenantRouterError &&
      error.code === "TENANT_ROUTE_ALREADY_EXISTS"
  );
  await assert.rejects(
    () => commands.moveTenantToShard({ tenantId: "missing", shardId: "shard-b" }),
    (error) => error instanceof TenantRouteNotFoundError
  );
  await assert.rejects(
    () => commands.assignTenantToShard({ tenantId: "acme", shardId: " " }),
    (error) =>
      error instanceof TenantRouterError && error.code === "INVALID_SHARD_ID"
  );
});

test("builds shard load and topology snapshots from route metadata", async () => {
  const routeStore = createMemoryRouteStore({
    shards: [
      { id: "shard-a", capacity: 100, loadScore: 0.42 },
      { id: "shard-b", status: "draining" }
    ],
    routes: [
      { tenantId: "acme", shardId: "shard-a", routeVersion: 1 },
      { tenantId: "beta", shardId: "shard-a", routeVersion: 2 },
      { tenantId: "orphan", shardId: "shard-missing", routeVersion: 1 }
    ]
  });
  const reader = createRouteTopologyReader({
    routeStore,
    shardRegistry: routeStore,
    now: () => new Date("2026-07-23T00:00:00.000Z")
  });

  const load = await reader.getShardLoad("shard-a");
  assert.equal(load.shard.id, "shard-a");
  assert.equal(load.tenantCount, 2);
  assert.equal(load.loadScore, 0.42);
  assert.equal(await reader.getShardLoad("shard-missing"), null);

  const snapshot = await reader.getTopologySnapshot();
  assert.equal(snapshot.generatedAt.toISOString(), "2026-07-23T00:00:00.000Z");
  assert.deepEqual(
    snapshot.shards.map((entry) => [entry.shard.id, entry.tenantCount]),
    [
      ["shard-a", 2],
      ["shard-b", 0]
    ]
  );
  assert.deepEqual(
    snapshot.shards[0].tenants.map((route) => route.tenantId),
    ["acme", "beta"]
  );
  assert.equal(snapshot.unassignedRoutes[0].tenantId, "orphan");
});

test("maps PostgreSQL route rows and uses monotonic route upserts", async () => {
  const queries = [];
  const pool = {
    async query(text, values) {
      queries.push({ text, values });
      if (text.includes("FROM tenant_router_routes")) {
        return {
          rows: [
            {
              tenant_id: "acme",
              shard_id: "shard-a",
              route_version: "7",
              tier: "pro",
              status: "active",
              reason: "initial assignment",
              updated_at: new Date("2026-07-23T00:00:00.000Z"),
              metadata: { source: "operator" }
            }
          ]
        };
      }
      return { rows: [] };
    },
    async end() {}
  };
  const store = createPostgresRouteStore({ pool });

  const route = await store.getTenantRoute(" acme ");
  assert.equal(route.routeVersion, 7);
  assert.equal(route.shardId, "shard-a");
  assert.deepEqual(route.metadata, { source: "operator" });

  await store.setTenantRoute({
    tenantId: "acme",
    shardId: "shard-b",
    routeVersion: 8
  });
  assert.ok(queries[1].text.includes("route_version < EXCLUDED.route_version"));
});

test("writes a PostgreSQL route and outbox event in one transaction", async () => {
  const queries = [];
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      if (text.includes("RETURNING tenant_id")) {
        return { rowCount: 1, rows: [{ tenant_id: "acme" }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };
  const pool = {
    async connect() {
      return client;
    },
    async query() {
      return { rowCount: 0, rows: [] };
    },
    async end() {}
  };
  const store = createPostgresRouteStore({ pool });

  await store.persistRouteChange(
    {
      tenantId: "acme",
      shardId: "shard-a",
      routeVersion: 2
    },
    {
      eventId: "acme:2:tenant.moved",
      type: "tenant.moved",
      tenantId: "acme",
      shardId: "shard-a",
      routeVersion: 2
    }
  );

  assert.equal(queries[0].text, "BEGIN");
  assert.ok(queries[1].text.includes("tenant_router_routes"));
  assert.ok(queries[2].text.includes("tenant_router_route_events"));
  assert.equal(queries[3].text, "COMMIT");
});

test("writes a PostgreSQL shard and outbox event in one transaction", async () => {
  const queries = [];
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  const pool = {
    async connect() {
      return client;
    },
    async query() {
      return { rowCount: 0, rows: [] };
    },
    async end() {}
  };
  const store = createPostgresRouteStore({ pool });

  await store.persistShardChange(
    { id: "shard-a", region: "ap-northeast-1" },
    {
      eventId: "shard:shard-a:provisioned",
      type: "shard.provisioned",
      shardId: "shard-a"
    }
  );

  assert.equal(queries[0].text, "BEGIN");
  assert.ok(queries[1].text.includes("tenant_router_shards"));
  assert.ok(queries[2].text.includes("tenant_router_route_events"));
  assert.equal(queries[3].text, "COMMIT");
});

test("commands use atomic shard registries when available", async () => {
  const persisted = [];
  const events = createMemoryRouteEvents();
  const registry = {
    async getTenantRoute() {
      return null;
    },
    async setShard() {
      throw new Error("non-atomic shard path should not be used");
    },
    async persistShardChange(shard, event) {
      persisted.push({ shard, event });
    }
  };
  const commands = createTenantRouteCommands({
    routeRegistry: registry,
    shardRegistry: registry,
    events
  });

  await commands.provisionShard({ id: "shard-a" });

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].event.type, "shard.provisioned");
  assert.equal(persisted[0].event.eventId, "shard:shard-a:provisioned");
});

test("outbox worker publishes batches and stops its timer", async () => {
  const published = [];
  const calls = [];
  let remaining = [
    {
      eventId: "acme:2:tenant.moved",
      type: "tenant.moved",
      tenantId: "acme",
      shardId: "shard-a",
      routeVersion: 2
    }
  ];
  const publisher = {
    async publish(event) {
      published.push(event);
    }
  };
  const outbox = {
    async publishPendingRouteEvents(currentPublisher, limit) {
      calls.push(limit);
      const batch = remaining.splice(0, limit);
      for (const event of batch) {
        await currentPublisher.publish(event);
      }
      return batch.length;
    }
  };
  const worker = createPostgresOutboxWorker(outbox, publisher, {
    intervalMs: 10,
    batchSize: 2
  });

  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await worker.stop();

  const callCountAfterStop = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(callCountAfterStop >= 1);
  assert.equal(calls.length, callCountAfterStop);
  assert.equal(published.length, 1);
  assert.equal(calls[0], 2);
});

test("publishes and consumes route events through a Redis stream", async () => {
  const messages = [];
  let nextMessageId = 1;
  const client = {
    isOpen: true,
    async connect() {},
    duplicate() {
      return this;
    },
    async xAdd(streamKey, id, fields) {
      messages.push({
        id: `${nextMessageId++}-0`,
        message: fields,
        streamKey,
        requestedId: id
      });
      return messages.at(-1).id;
    },
    async xRead() {
      if (messages.length > 0) {
        const message = messages.shift();
        return [{ name: message.streamKey, messages: [message] }];
      }

      await new Promise((resolve) => setTimeout(resolve, 1));
      return null;
    },
    async quit() {}
  };
  const events = createRedisRouteEvents({ client, blockMs: 10 });
  const received = new Promise((resolve) => {
    events.subscribe(resolve);
  });

  await events.publish({
    type: "tenant.created",
    tenantId: "acme",
    shardId: "shard-a",
    routeVersion: 1
  });

  const event = await Promise.race([
    received,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Redis event was not received.")), 500)
    )
  ]);
  assert.equal(event.type, "tenant.created");
  assert.equal(event.tenantId, "acme");
  await events.close();
});

let failed = 0;

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

if (failed > 0) {
  process.exitCode = 1;
}
