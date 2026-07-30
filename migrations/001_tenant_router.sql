CREATE TABLE IF NOT EXISTS tenant_router_shards (
  shard_id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  region TEXT,
  capacity INTEGER,
  load_score DOUBLE PRECISION,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_router_routes (
  tenant_id TEXT PRIMARY KEY,
  shard_id TEXT NOT NULL REFERENCES tenant_router_shards(shard_id),
  route_version BIGINT NOT NULL,
  tier TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS tenant_router_routes_shard_id_idx
  ON tenant_router_routes (shard_id);

CREATE TABLE IF NOT EXISTS tenant_router_route_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  tenant_id TEXT,
  route_version BIGINT,
  event_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS tenant_router_route_events_pending_idx
  ON tenant_router_route_events (created_at, event_id)
  WHERE published_at IS NULL;
