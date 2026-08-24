INSERT INTO tenant_router_shards
  (shard_id, name, status, region, capacity, load_score, metadata)
VALUES
  ('shard-1', 'Local shard 1', 'active', 'local', 1000, 0.0,
    '{"host":"localhost","port":5541,"database":"shard_1","user":"shard","container_host":"shard-1","container_port":5432}'::jsonb),
  ('shard-2', 'Local shard 2', 'active', 'local', 1000, 0.0,
    '{"host":"localhost","port":5542,"database":"shard_2","user":"shard","container_host":"shard-2","container_port":5432}'::jsonb),
  ('shard-3', 'Local shard 3', 'active', 'local', 1000, 0.0,
    '{"host":"localhost","port":5543,"database":"shard_3","user":"shard","container_host":"shard-3","container_port":5432}'::jsonb),
  ('shard-4', 'Local shard 4', 'active', 'local', 1000, 0.0,
    '{"host":"localhost","port":5544,"database":"shard_4","user":"shard","container_host":"shard-4","container_port":5432}'::jsonb)
ON CONFLICT (shard_id) DO NOTHING;
