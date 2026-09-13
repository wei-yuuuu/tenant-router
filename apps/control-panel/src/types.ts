export interface HealthSnapshot {
  ok: boolean;
  instanceId: string;
  pid: number;
  cache: string;
  streamKey: string;
  routingPoolMax: number;
  shardPoolMax: number;
  maxDemoShards: number;
}

/** Live API replica from GET /instances (Redis registry). */
export interface ApiInstanceInfo {
  instanceId: string;
  pid: number;
  cache: string;
  updatedAt: string;
}

export interface TenantRoute {
  tenantId: string;
  shardId: string;
  routeVersion: number;
  tier?: string;
  status?: string;
  reason?: string;
  updatedAt?: string;
}

export interface ShardDefinition {
  id: string;
  name?: string;
  status?: string;
  region?: string;
  capacity?: number;
  loadScore?: number;
  /** Demo-only: real query QPS from local API (Redis window). */
  demoQps?: number;
}

export interface ShardTopology {
  shard: ShardDefinition;
  tenants: TenantRoute[];
  tenantCount: number;
}

export interface TopologySnapshot {
  generatedAt: string;
  shards: ShardTopology[];
  unassignedRoutes: TenantRoute[];
}

export interface DraftTenant {
  draftId: string;
  shardId: string;
  tier: string;
}

export type FlowKind = "api" | "redis" | "postgres" | "shard" | "tenant";

/** Serializable React Flow node payload — actions live in PlacementActionsContext. */
export interface FlowNodeData extends Record<string, unknown> {
  kind: FlowKind;
  title: string;
  subtitle?: string;
  badge?: string;
  selected?: boolean;
  flashing?: boolean;
  highlighted?: boolean;
  loadScore?: number;
  demoQps?: number;
  tenantCount?: number;
  tenantId?: string;
  tier?: string;
  routeVersion?: number;
  isDraft?: boolean;
  draftId?: string;
  canDelete?: boolean;
  showDelete?: boolean;
  canProvision?: boolean;
  provisionDisabled?: boolean;
  provisionTitle?: string;
  instanceId?: string;
}

export interface PlacementActions {
  onAddTenant: (shardId: string) => void;
  onProvisionShard: () => void;
  onDeleteShard: (shardId: string) => void;
  onChangeTier: (tenantId: string, tier: string) => void;
  onDisableTenant: (tenantId: string) => void;
  onQueryTenant: (tenantId: string, count?: number) => void;
  onDraftTierChange: (draftId: string, tier: string) => void;
  onCommitDraft: (draftId: string, name: string) => void;
  onCancelDraft: (draftId: string) => void;
}

/** Slim view for the resolve-edge cache label (not a full route DTO). */
export interface ResolvedRouteView {
  tenantId: string;
  cacheHit: boolean;
  instanceId: string;
}
