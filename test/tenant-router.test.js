import assert from "assert";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  TenantRouteNotFoundError,
  TenantRouterError,
  createMemoryRouteEvents,
  createMemoryRouteStore,
  createTenantMatcher,
  createTenantRouter,
  matchTenant
} from "../src/index.ts";
import { createSqliteRouteCache } from "../src/node.ts";

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
