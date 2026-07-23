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
