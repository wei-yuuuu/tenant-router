import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent
} from "react";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnNodeDrag
} from "@xyflow/react";

import type {
  ApiInstanceInfo,
  DraftTenant,
  FlowNodeData,
  HealthSnapshot,
  ResolvedRouteView,
  PlacementActions,
  ShardTopology,
  TenantRoute,
  TopologySnapshot
} from "./types";

const pollIntervalMs = 3000;
const fitViewOptions = { padding: 0.18, minZoom: 0.4, maxZoom: 1, duration: 0 } as const;
const fitViewAfterChange = { padding: 0.18, minZoom: 0.35, maxZoom: 1, duration: 280 } as const;
/** Causal write-path highlight: SoT commit → stream notify → local cache. */
type RoutePulsePhase = "off" | "store" | "redis" | "api";
const panOnDragButtons: number[] = [1, 2];
const reactFlowProOptions = { hideAttribution: true } as const;
const shardWidth = 280;
const shardMinHeight = 220;
const tenantNodeWidth = 240;
/** Vertical gap above first chip, between chips, and below last chip. */
const chipGap = 18;
const chipHeight = 78;
const chipStep = chipHeight + chipGap;
/** Header (topline + load) ends ~136px; add chipGap so top matches between-chip spacing. */
const chipTopInset = 136 + chipGap;
const shardBottomPad = chipGap;
/** Top-to-bottom demo flow: RouteStore → Redis → APIs → shards (bottom row). */
const infraX = 24;
const apiNodeWidth = 136;
const apiNodeGap = 28;
const infraNodeWidth = 260;
const shardRowX = 24;
const shardGapX = 40;
/** Approx rendered heights — used so RouteStore→Redis→API→shards share one gap. */
const infraNodeHeight = 108;
const apiNodeHeight = 92;
/** Clear space between one layer's bottom and the next layer's top. */
const layerGap = 56;
const routeStoreY = 36;
const redisY = routeStoreY + infraNodeHeight + layerGap;
const apiRowY = redisY + infraNodeHeight + layerGap;
const shardRowY = apiRowY + apiNodeHeight + layerGap;

const emptyTopology: TopologySnapshot = {
  generatedAt: "",
  shards: [],
  unassignedRoutes: []
};

const noisyNeighbourTenants = [
  "noisy-bot-1",
  "noisy-bot-2",
  "noisy-bot-3",
  "noisy-bot-4",
  "noisy-bot-5"
];
const demoEnterpriseTenant = "enterprise-acme";
const demoTenantIds = [...noisyNeighbourTenants, demoEnterpriseTenant];

type DemoStepId = 0 | 1 | 2 | 3 | 4;

const demoStepCopy: Record<
  Exclude<DemoStepId, 0>,
  { title: string; detail: string }
> = {
  1: {
    title: "1/4 Crowd free noisy neighbours",
    detail:
      "Create free noisy-bot-1…5 on shard-1, then burst real queries so shard load rises. Use the DB icon on a tenant to query again."
  },
  2: {
    title: "2/4 Enterprise joins the crowded shard",
    detail:
      "Place enterprise-acme on the same hot shard. This is the noisy-neighbour problem: one lookup row still points a valuable tenant at a contended shard."
  },
  3: {
    title: "3/4 Isolate with MoveTenant",
    detail:
      "MoveTenant: lookup row points enterprise-acme at shard-4. Isolation is one route change — no data copy."
  },
  4: {
    title: "4/4 Done — isolation complete",
    detail:
      "Enterprise is on a quieter shard via the lookup table. Reset clears demo tenants; load follows real query traffic."
  }
};

const demoBotStaggerMs = 450;
const defaultMaxDemoShards = 10;

const PlacementActionsContext = createContext<PlacementActions | null>(null);

function usePlacementActions(): PlacementActions {
  const actions = useContext(PlacementActionsContext);
  if (!actions) {
    throw new Error("PlacementActionsContext is missing");
  }
  return actions;
}

function flowDataEqual(a: FlowNodeData, b: FlowNodeData): boolean {
  return (
    a.kind === b.kind &&
    a.title === b.title &&
    a.subtitle === b.subtitle &&
    a.badge === b.badge &&
    a.selected === b.selected &&
    a.flashing === b.flashing &&
    a.highlighted === b.highlighted &&
    a.loadScore === b.loadScore &&
    a.demoQps === b.demoQps &&
    a.tenantCount === b.tenantCount &&
    a.tenantId === b.tenantId &&
    a.tier === b.tier &&
    a.routeVersion === b.routeVersion &&
    a.isDraft === b.isDraft &&
    a.draftId === b.draftId &&
    a.instanceId === b.instanceId &&
    a.canDelete === b.canDelete &&
    a.showDelete === b.showDelete &&
    a.canProvision === b.canProvision &&
    a.provisionDisabled === b.provisionDisabled &&
    a.provisionTitle === b.provisionTitle
  );
}

function mergeGraphNodes(
  current: Node<FlowNodeData>[],
  next: Node<FlowNodeData>[],
  draggingNodeId: string | null
): Node<FlowNodeData>[] {
  const currentById = new Map(current.map((node) => [node.id, node]));
  let changed = current.length !== next.length;
  const merged = next.map((node) => {
    const prev = currentById.get(node.id);
    if (!prev) {
      changed = true;
      return node;
    }
    if (draggingNodeId && node.id === draggingNodeId) {
      if (
        flowDataEqual(prev.data, node.data) &&
        prev.zIndex === (node.zIndex ?? prev.zIndex)
      ) {
        return prev;
      }
      changed = true;
      return {
        ...prev,
        data: node.data,
        zIndex: node.zIndex ?? prev.zIndex
      };
    }
    const samePos =
      prev.position.x === node.position.x && prev.position.y === node.position.y;
    const sameStyle =
      JSON.stringify(prev.style ?? null) === JSON.stringify(node.style ?? null);
    if (
      samePos &&
      sameStyle &&
      prev.zIndex === node.zIndex &&
      prev.type === node.type &&
      flowDataEqual(prev.data, node.data)
    ) {
      return prev;
    }
    changed = true;
    return {
      ...node,
      selected: prev.selected,
      dragging: false
    };
  });
  if (!changed) {
    // Same identities — keep previous array reference so React Flow does not flash.
    for (let i = 0; i < merged.length; i += 1) {
      if (merged[i] !== current[i] || current[i]?.id !== merged[i]?.id) {
        return merged;
      }
    }
    return current;
  }
  return merged;
}

function healthEqual(a: HealthSnapshot | null, b: HealthSnapshot | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.ok === b.ok &&
    a.instanceId === b.instanceId &&
    a.pid === b.pid &&
    a.cache === b.cache &&
    a.streamKey === b.streamKey &&
    a.routingPoolMax === b.routingPoolMax &&
    a.shardPoolMax === b.shardPoolMax &&
    a.maxDemoShards === b.maxDemoShards
  );
}

function apiInstancesEqual(a: ApiInstanceInfo[], b: ApiInstanceInfo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.instanceId !== right.instanceId ||
      left.pid !== right.pid ||
      left.cache !== right.cache
    ) {
      return false;
    }
  }
  return true;
}

function apiNodeId(instanceId: string): string {
  return `api:${instanceId}`;
}

function shortInstanceId(instanceId: string): string {
  if (instanceId.length <= 12) return instanceId;
  return `${instanceId.slice(0, 8)}…`;
}

function topologyEqual(a: TopologySnapshot, b: TopologySnapshot): boolean {
  // Ignore generatedAt — API bumps it every poll even when routes are unchanged.
  if (a === b) return true;
  if (a.shards.length !== b.shards.length) return false;
  for (let i = 0; i < a.shards.length; i += 1) {
    const left = a.shards[i];
    const right = b.shards[i];
    if (
      left.shard.id !== right.shard.id ||
      left.shard.loadScore !== right.shard.loadScore ||
      left.shard.name !== right.shard.name ||
      left.tenantCount !== right.tenantCount ||
      left.tenants.length !== right.tenants.length
    ) {
      return false;
    }
    for (let t = 0; t < left.tenants.length; t += 1) {
      const lt = left.tenants[t];
      const rt = right.tenants[t];
      if (
        lt.tenantId !== rt.tenantId ||
        lt.shardId !== rt.shardId ||
        lt.tier !== rt.tier ||
        lt.status !== rt.status ||
        lt.routeVersion !== rt.routeVersion
      ) {
        return false;
      }
    }
  }
  return true;
}

function edgesEqual(a: Edge[], b: Edge[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.id !== right.id ||
      left.type !== right.type ||
      left.source !== right.source ||
      left.target !== right.target ||
      left.sourceHandle !== right.sourceHandle ||
      left.targetHandle !== right.targetHandle ||
      left.animated !== right.animated ||
      left.zIndex !== right.zIndex ||
      left.label !== right.label ||
      JSON.stringify(left.style ?? null) !== JSON.stringify(right.style ?? null) ||
      JSON.stringify(left.data ?? null) !== JSON.stringify(right.data ?? null)
    ) {
      return false;
    }
  }
  return true;
}

export default function App() {
  return (
    <ReactFlowProvider>
      <PlacementMap />
    </ReactFlowProvider>
  );
}

function PlacementMap() {
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [apiInstances, setApiInstances] = useState<ApiInstanceInfo[]>([]);
  const [topology, setTopology] = useState<TopologySnapshot>(emptyTopology);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [resolvedRoute, setResolvedRoute] = useState<ResolvedRouteView | null>(null);
  /** Optimistic shard while MoveTenant is in flight (slot position, not free-drag coords). */
  const [pendingMove, setPendingMove] = useState<{
    tenantId: string;
    shardId: string;
  } | null>(null);
  const [drafts, setDrafts] = useState<DraftTenant[]>([]);
  const [busy, setBusy] = useState(false);
  // Write-path pulse: RouteStore → Redis → API cache (see flashRoutePath).
  const [pulsePhase, setPulsePhase] = useState<RoutePulsePhase>("off");
  const pulseTimersRef = useRef<number[]>([]);
  const [loading, setLoading] = useState(true);
  /** Health/poll reachability only — not command/validation errors. */
  const [apiOnline, setApiOnline] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<{ text: string; tone: "idle" | "info" | "error" }>({
    text: "Ready.",
    tone: "idle"
  });
  const [demoActive, setDemoActive] = useState(false);
  const [demoStep, setDemoStep] = useState<DemoStepId>(0);
  const demoStepRef = useRef<DemoStepId>(0);
  const syncedLabelRef = useRef<HTMLSpanElement | null>(null);
  const [canvasReady, setCanvasReady] = useState(false);

  const [nodes, setNodes] = useState<Node<FlowNodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const resolveCacheHit =
    resolvedRoute && resolvedRoute.tenantId === selectedTenantId
      ? resolvedRoute.cacheHit
      : null;
  const resolveInstanceId =
    resolvedRoute && resolvedRoute.tenantId === selectedTenantId
      ? resolvedRoute.instanceId
      : null;

  const topologyRef = useRef(topology);
  const draftsRef = useRef(drafts);
  const didFitRef = useRef(false);
  const dragOriginShardRef = useRef<string | null>(null);
  const draggingNodeIdRef = useRef<string | null>(null);
  const refreshGenRef = useRef(0);

  const { fitView, getIntersectingNodes } = useReactFlow<Node<FlowNodeData>, Edge>();

  useEffect(() => {
    topologyRef.current = topology;
  }, [topology]);

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  useEffect(() => {
    demoStepRef.current = demoStep;
  }, [demoStep]);

  useEffect(() => {
    if (!selectedTenantId) {
      setResolvedRoute(null);
      return;
    }
    let cancelled = false;
    void fetchResolvedRoute(selectedTenantId)
      .then((view) => {
        if (cancelled) return;
        setResolvedRoute((current) =>
          current &&
          current.tenantId === view.tenantId &&
          current.cacheHit === view.cacheHit &&
          current.instanceId === view.instanceId
            ? current
            : view
        );
      })
      .catch(() => {
        if (!cancelled) setResolvedRoute(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTenantId]);

  useEffect(() => {
    return () => {
      for (const id of pulseTimersRef.current) {
        window.clearTimeout(id);
      }
      pulseTimersRef.current = [];
    };
  }, []);

  const flashRoutePath = useCallback(() => {
    // Real write path: Postgres RouteStore commit → Redis Streams notify → API RouteCache.
    for (const id of pulseTimersRef.current) {
      window.clearTimeout(id);
    }
    pulseTimersRef.current = [];
    setPulsePhase("store");
    pulseTimersRef.current.push(
      window.setTimeout(() => setPulsePhase("redis"), 420),
      window.setTimeout(() => setPulsePhase("api"), 840),
      window.setTimeout(() => setPulsePhase("off"), 1300)
    );
  }, []);

  const postJson = useCallback(async (path: string, body: unknown) => {
    return request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }, []);

  const selectTenant = useCallback((tenantId: string | null) => {
    setSelectedTenantId(tenantId);
  }, []);

  const refresh = useCallback(async () => {
    // Latest-wins: overlapping poll + action refresh must not apply stale payloads.
    const gen = (refreshGenRef.current += 1);
    try {
      const [nextHealth, nextTopology, nextInstances] = await Promise.all([
        fetchHealth(),
        fetchTopology(),
        fetchApiInstances()
      ]);
      if (gen !== refreshGenRef.current) {
        return;
      }
      setHealth((current) => (healthEqual(current, nextHealth) ? current : nextHealth));
      setTopology((current) =>
        topologyEqual(current, nextTopology) ? current : nextTopology
      );
      const instances =
        nextInstances.length > 0
          ? nextInstances
          : nextHealth.instanceId
            ? [
                {
                  instanceId: nextHealth.instanceId,
                  pid: nextHealth.pid,
                  cache: nextHealth.cache,
                  updatedAt: new Date().toISOString()
                }
              ]
            : [];
      setApiInstances((current) =>
        apiInstancesEqual(current, instances) ? current : instances
      );
      // Update clock without React state — a setState here re-renders React Flow every poll.
      if (syncedLabelRef.current && nextTopology.generatedAt) {
        syncedLabelRef.current.textContent = new Date(
          nextTopology.generatedAt
        ).toLocaleTimeString();
      }
      // Keep operator errors visible; actions clear error when they start.
      setApiOnline(true);

      const demoPresent = nextTopology.shards.some((entry) =>
        entry.tenants.some(
          (tenant) =>
            demoTenantIds.includes(tenant.tenantId) && tenant.status !== "disabled"
        )
      );
      setDemoActive(demoPresent);
    } catch (caughtError) {
      if (gen !== refreshGenRef.current) {
        return;
      }
      // Badge only — do not overwrite create/move validation errors in the dock.
      setApiOnline(false);
    } finally {
      if (gen === refreshGenRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const addDraft = useCallback((shardId: string) => {
    const draftId = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setDrafts((current) => [
      ...current,
      { draftId, shardId, tier: "free" }
    ]);
    setStatus({ text: `name tenant on ${shardId}`, tone: "idle" });
  }, []);

  const moveTenant = useCallback(
    async (tenantId: string, shardId: string) => {
      const current = topologyRef.current.shards
        .flatMap((entry) => entry.tenants)
        .find((route) => route.tenantId === tenantId);
      if (!current || current.shardId === shardId) {
        return false;
      }

      setError("");
      const fromShardId = current.shardId;
      setStatus({ text: `move tenant ${tenantId}…`, tone: "info" });
      try {
        const payload = await postJson(
          `/tenants/${encodeURIComponent(tenantId)}/move`,
          { shardId, reason: "moved from placement map" }
        );
        const route = readRoute(payload);
        // Patch local topology from the response so clearing pendingMove cannot
        // snap the chip back if a concurrent poll refresh was discarded.
        if (route) {
          setTopology((current) => {
            const next = upsertTenantRoute(current, route);
            topologyRef.current = next;
            return next;
          });
          selectTenant(route.tenantId);
          setStatus({
            text: `move tenant ${route.tenantId} from ${fromShardId} to ${route.shardId}`,
            tone: "info"
          });
        }
        flashRoutePath();
        void refresh();
        return true;
      } catch (caughtError) {
        const reason = errorMessage(caughtError);
        setError(reason);
        setStatus({ text: `move failed — ${reason}`, tone: "error" });
        void refresh();
        return false;
      }
    },
    [flashRoutePath, postJson, refresh, selectTenant]
  );

  const applyTier = useCallback(
    async (tenantId: string, tier: string) => {
      setError("");
      try {
        const payload = await postJson(
          `/tenants/${encodeURIComponent(tenantId)}/tier`,
          { tier, reason: "changed from placement map" }
        );
        flashRoutePath();
        await refresh();
        const route = readRoute(payload);
        if (route) {
          setStatus({
            text: `tier tenant ${route.tenantId} → ${route.tier}`,
            tone: "info"
          });
        }
      } catch (caughtError) {
        const reason = errorMessage(caughtError);
        setError(reason);
        setStatus({ text: `tier change failed — ${reason}`, tone: "error" });
      }
    },
    [flashRoutePath, postJson, refresh]
  );


  const disableTenant = useCallback(
    async (tenantId: string) => {
      setError("");
      try {
        await postJson(`/tenants/${encodeURIComponent(tenantId)}/disable`, {
          reason: "removed from placement map"
        });
        flashRoutePath();
        await refresh();
        setStatus({ text: `remove tenant ${tenantId}`, tone: "info" });
        if (selectedTenantId === tenantId) {
          selectTenant(null);
        }
      } catch (caughtError) {
        const reason = errorMessage(caughtError);
        setError(reason);
        setStatus({ text: `remove failed — ${reason}`, tone: "error" });
      }
    },
    [flashRoutePath, postJson, refresh, selectTenant, selectedTenantId]
  );


  const commitDraft = useCallback(
    async (draftId: string, rawName: string) => {
      const draft = draftsRef.current.find((entry) => entry.draftId === draftId);
      if (!draft) {
        return;
      }
      const tenantId = rawName.trim();
      if (!tenantId) {
        setDrafts((current) => current.filter((entry) => entry.draftId !== draftId));
        return;
      }
      const existing = topologyRef.current.shards
        .flatMap((entry) => entry.tenants)
        .find((route) => route.tenantId === tenantId);
      if (existing && existing.status !== "disabled") {
        setError(`Tenant "${tenantId}" already exists.`);
        setStatus({
          text: `create failed — Tenant "${tenantId}" already exists.`,
          tone: "error"
        });
        return;
      }

      setError("");
      setStatus({ text: `creating tenant ${tenantId}…`, tone: "info" });
      try {
        // Disabled rows still live in RouteStore — createTenant would 400 ALREADY_EXISTS.
        // Move (same or other shard) rewrites status=active, matching ensureTenant.
        const payload =
          existing?.status === "disabled"
            ? await postJson(`/tenants/${encodeURIComponent(tenantId)}/move`, {
                shardId: draft.shardId,
                tier: draft.tier || "free",
                reason: "recreated from placement map"
              })
            : await postJson("/tenants", {
                tenantId,
                shardId: draft.shardId,
                tier: draft.tier || "free",
                reason: "created from placement map"
              });
        if (existing?.status === "disabled" && (existing.tier || "free") !== (draft.tier || "free")) {
          await postJson(`/tenants/${encodeURIComponent(tenantId)}/tier`, {
            tier: draft.tier || "free",
            reason: "recreated from placement map"
          });
        }
        setDrafts((current) => current.filter((entry) => entry.draftId !== draftId));
        flashRoutePath();
        await refresh();
        const route = readRoute(payload);
        if (route) {
          selectTenant(route.tenantId);
          setStatus({
            text: `create tenant ${route.tenantId} on ${route.shardId}`,
            tone: "info"
          });
        }
      } catch (caughtError) {
        const reason = errorMessage(caughtError);
        setError(reason);
        setStatus({ text: `create failed — ${reason}`, tone: "error" });
      }
    },
    [flashRoutePath, postJson, refresh, selectTenant]
  );


  const deleteShard = useCallback(
    async (shardId: string) => {
      setBusy(true);
      setError("");
      try {
        await request(`/shards/${encodeURIComponent(shardId)}`, { method: "DELETE" });
        setDrafts((current) => current.filter((draft) => draft.shardId !== shardId));
        if (selectedTenantId) {
          const stillThere = topologyRef.current.shards
            .flatMap((entry) => entry.tenants)
            .some(
              (route) =>
                route.tenantId === selectedTenantId && route.status !== "disabled"
            );
          if (!stillThere) {
            selectTenant(null);
          }
        }
        await refresh();
        setStatus({ text: `deleted ${shardId}`, tone: "info" });
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            void fitView(fitViewAfterChange);
          });
        });
      } catch (caughtError) {
        const reason = errorMessage(caughtError);
        setError(reason);
        setStatus({ text: `delete shard failed — ${reason}`, tone: "error" });
      } finally {
        setBusy(false);
      }
    },
    [fitView, refresh, selectTenant, selectedTenantId]
  );


  const provisionShard = useCallback(async () => {
    if (busy) {
      return;
    }
    const limit = health?.maxDemoShards ?? defaultMaxDemoShards;
    if (topology.shards.length >= limit) {
      setStatus({
        text: `shard limit ${limit}/${limit}`,
        tone: "error"
      });
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload = await postJson("/shards", {});
      const shardId =
        isRecord(payload) && isRecord(payload.shard)
          ? stringValue(payload.shard.id)
          : "shard";
      await refresh();
      setStatus({ text: `provisioned ${shardId}`, tone: "info" });
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          void fitView(fitViewAfterChange);
        });
      });
    } catch (caughtError) {
      const reason = errorMessage(caughtError);
      setError(reason);
      setStatus({ text: `provision shard failed — ${reason}`, tone: "error" });
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    fitView,
    health?.maxDemoShards,
    postJson,
    refresh,
    topology.shards.length
  ]);

  const queryTenant = useCallback(
    async (tenantId: string, count = 1) => {
      setError("");
      setStatus({
        text: count > 1 ? `query ${tenantId} ×${count}…` : `query ${tenantId}…`,
        tone: "info"
      });
      try {
        await postJson(`/tenants/${encodeURIComponent(tenantId)}/query`, {
          count
        });
        await refresh();
        setStatus({
          text: count > 1 ? `queried ${tenantId} ×${count}` : `queried ${tenantId}`,
          tone: "info"
        });
      } catch (caughtError) {
        const reason = errorMessage(caughtError);
        setError(reason);
        setStatus({ text: `query failed — ${reason}`, tone: "error" });
      }
    },
    [postJson, refresh]
  );

  const placementActions = useMemo<PlacementActions>(
    () => ({
      onAddTenant: addDraft,
      onProvisionShard: () => {
        void provisionShard();
      },
      onDeleteShard: (shardId) => {
        void deleteShard(shardId);
      },
      onChangeTier: (tenantId, tier) => {
        void applyTier(tenantId, tier);
      },
      onDisableTenant: (tenantId) => {
        void disableTenant(tenantId);
      },
      onQueryTenant: (tenantId, count) => {
        void queryTenant(tenantId, count);
      },
      onDraftTierChange: (draftId, tier) => {
        setDrafts((current) =>
          current.map((entry) =>
            entry.draftId === draftId ? { ...entry, tier } : entry
          )
        );
      },
      onCommitDraft: (draftId, name) => {
        void commitDraft(draftId, name);
      },
      onCancelDraft: (draftId) => {
        setDrafts((current) => current.filter((entry) => entry.draftId !== draftId));
      }
    }),
    [addDraft, applyTier, commitDraft, disableTenant, deleteShard, provisionShard, queryTenant]
  );

  useEffect(() => {
    const built = buildGraph({
      health,
      apiInstances,
      topology,
      drafts,
      selectedTenantId,
      resolveCacheHit,
      resolveInstanceId,
      pulsePhase,
      busy,
      pendingMove
    });
    setNodes((current) => {
      const merged = mergeGraphNodes(
        current,
        built.nodes,
        draggingNodeIdRef.current
      );
      // Never flash an empty graph after the first layout — that resets the viewport.
      if (current.length > 0 && merged.length === 0) {
        return current;
      }
      return merged;
    });
    setEdges((current) => (edgesEqual(current, built.edges) ? current : built.edges));
  }, [busy, drafts, health, pendingMove, pulsePhase, resolveCacheHit, selectedTenantId, topology, apiInstances, resolveInstanceId]);

  useEffect(() => {
    if (loading || topology.shards.length === 0 || didFitRef.current) {
      return;
    }
    didFitRef.current = true;
    let cancelled = false;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        void fitView(fitViewOptions).finally(() => {
          if (!cancelled) {
            setCanvasReady(true);
          }
        });
      });
    });
    return () => {
      cancelled = true;
    };
  }, [fitView, loading, topology.shards.length]);

  const onNodesChange = useCallback((changes: NodeChange<Node<FlowNodeData>>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node<FlowNodeData>) => {
      if (node.type === "tenant" && !node.data.isDraft) {
        const tenantId = String(node.data.tenantId || "");
        if (tenantId) {
          selectTenant(tenantId);
          return;
        }
      }
      // Clicking a non-tenant node clears resolve selection.
      selectTenant(null);
    },
    [selectTenant]
  );

  const onPaneClick = useCallback(() => {
    selectTenant(null);
  }, [selectTenant]);

  const relayout = useCallback(() => {
    const built = buildGraph({
      health,
      apiInstances,
      topology,
      drafts,
      selectedTenantId,
      resolveCacheHit,
      resolveInstanceId,
      pulsePhase,
      busy,
      pendingMove
    });
    setNodes((current) => mergeGraphNodes(current, built.nodes, null));
    setEdges((current) => (edgesEqual(current, built.edges) ? current : built.edges));
  }, [busy, drafts, health, pendingMove, pulsePhase, resolveCacheHit, selectedTenantId, topology, apiInstances, resolveInstanceId]);

  const onNodeDragStart: OnNodeDrag<Node<FlowNodeData>> = useCallback(
    (_event, node) => {
      if (node.type !== "tenant" || node.data.isDraft) {
        return;
      }
      draggingNodeIdRef.current = node.id;
      const tenantId = String(node.data.tenantId || "");
      dragOriginShardRef.current =
        topologyRef.current.shards
          .flatMap((entry) =>
            entry.tenants.map((tenant) => ({ tenant, shardId: entry.shard.id }))
          )
          .find((entry) => entry.tenant.tenantId === tenantId)?.shardId ?? null;
      if (tenantId) {
        selectTenant(tenantId);
      }
      setNodes((current) =>
        current.map((entry) =>
          entry.id === node.id
            ? { ...entry, zIndex: 1000 }
            : entry.type === "tenant"
              ? { ...entry, zIndex: 10 }
              : { ...entry, zIndex: entry.type === "shard" ? 1 : 2 }
        )
      );
    },
    [selectTenant]
  );

  const onNodeDragStop: OnNodeDrag<Node<FlowNodeData>> = useCallback(
    (event, node) => {
      if (node.type !== "tenant" || node.data.isDraft || busy) {
        draggingNodeIdRef.current = null;
        relayout();
        return;
      }
      const tenantId = String(node.data.tenantId || "");
      if (!tenantId) {
        draggingNodeIdRef.current = null;
        relayout();
        return;
      }

      const originShardId = dragOriginShardRef.current;
      let targetShardId: string | null = null;

      // Prefer the shard under the pointer — L→R drops often still intersect the origin.
      if ("clientX" in event && typeof event.clientX === "number") {
        const stack = document.elementsFromPoint(event.clientX, event.clientY);
        for (const el of stack) {
          if (!(el instanceof Element)) continue;
          const host = el.closest("[data-shard-id]");
          const id = host?.getAttribute("data-shard-id");
          if (id) {
            targetShardId = id;
            break;
          }
        }
      }

      if (!targetShardId) {
        const hits = getIntersectingNodes(node, true).filter(
          (candidate) => candidate.type === "shard"
        );
        const ranked = [...hits].sort((left, right) => {
          const leftId = String(
            left.data.title || left.id.replace(/^shard-/, "")
          );
          const rightId = String(
            right.data.title || right.id.replace(/^shard-/, "")
          );
          // Prefer a non-origin shard when the chip overlaps both.
          if (leftId === originShardId && rightId !== originShardId) return 1;
          if (rightId === originShardId && leftId !== originShardId) return -1;
          return 0;
        });
        if (ranked[0]) {
          targetShardId = String(
            ranked[0].data.title || ranked[0].id.replace(/^shard-/, "")
          );
        }
      }

      if (!targetShardId || targetShardId === originShardId) {
        // Topology unchanged → poll refresh will not rebuild nodes; snap back now.
        draggingNodeIdRef.current = null;
        setPendingMove(null);
        relayout();
        return;
      }
      // Place on the target shard slot immediately; don't keep the free-drag coords.
      draggingNodeIdRef.current = null;
      setPendingMove({ tenantId, shardId: targetShardId });
      void moveTenant(tenantId, targetShardId).finally(() => {
        setPendingMove(null);
      });
    },
    [busy, getIntersectingNodes, moveTenant, relayout]
  );

  const ensureTenant = useCallback(
    async (
      tenantId: string,
      shardId: string,
      tier: string,
      reason: string,
      options?: { pulse?: boolean }
    ): Promise<void> => {
      const pulse = options?.pulse !== false;
      const existing = topologyRef.current.shards
        .flatMap((entry) => entry.tenants)
        .find((route) => route.tenantId === tenantId);
      if (!existing) {
        await postJson("/tenants", { tenantId, shardId, tier, reason });
        if (pulse) {
          flashRoutePath();
        }
        return;
      }
      // Local API: move re-activates a disabled route (including same-shard move).
      let wrote = false;
      if (existing.status === "disabled" || existing.shardId !== shardId) {
        await postJson(`/tenants/${encodeURIComponent(tenantId)}/move`, {
          shardId,
          reason
        });
        wrote = true;
      }
      if ((existing.tier || "free") !== tier) {
        await postJson(`/tenants/${encodeURIComponent(tenantId)}/tier`, {
          tier,
          reason
        });
        wrote = true;
      }
      if (wrote && pulse) {
        flashRoutePath();
      }
    },
    [flashRoutePath, postJson]
  );

  const showDemoStep = useCallback((step: DemoStepId) => {
    setDemoStep(step);
    demoStepRef.current = step;
    if (step === 0) {
      return;
    }
    const copy = demoStepCopy[step];
    setStatus({ text: copy.title, tone: "info" });
  }, []);

  const runDemoStep = useCallback(
    async (step: 1 | 2 | 3): Promise<void> => {
      const quiet = { pulse: false } as const;
      showDemoStep(step);
      setError("");
      setDrafts([]);

      if (step === 1) {
        for (const tenantId of noisyNeighbourTenants) {
          await ensureTenant(
            tenantId,
            "shard-1",
            "free",
            "noisy neighbour",
            quiet
          );
          await refresh();
          await wait(demoBotStaggerMs);
        }
        // Drive real query traffic so shard-1 load rises (no background chatter).
        for (const tenantId of noisyNeighbourTenants) {
          await postJson(`/tenants/${encodeURIComponent(tenantId)}/query`, {
            count: 20
          });
        }
        await refresh();
        setDemoActive(true);
        setStatus({
          text: "1/4 noisy bots querying shard-1 — use the DB icon on a tenant for more load",
          tone: "info"
        });
        return;
      }

      if (step === 2) {
        await ensureTenant(
          demoEnterpriseTenant,
          "shard-1",
          "enterprise",
          "noisy neighbour enterprise",
          quiet
        );
        for (const tenantId of noisyNeighbourTenants) {
          await postJson(`/tenants/${encodeURIComponent(tenantId)}/query`, {
            count: 15
          });
        }
        await refresh();
        selectTenant(demoEnterpriseTenant);
        return;
      }

      await ensureTenant(
        demoEnterpriseTenant,
        "shard-4",
        "enterprise",
        "isolated from noisy neighbours",
        quiet
      );
      await refresh();
      selectTenant(demoEnterpriseTenant);
      setDemoActive(true);
      flashRoutePath();
    },
    [ensureTenant, flashRoutePath, postJson, refresh, selectTenant, showDemoStep]
  );

  async function nextNoisyDemoStep() {
    if (busy) {
      return;
    }
    const current = demoStepRef.current;
    if (current >= 4) {
      return;
    }
    // After Isolate (3), Next only advances the caption to Done (4).
    if (current === 3) {
      showDemoStep(4);
      return;
    }
    const next = (current === 0 ? 1 : current + 1) as 1 | 2 | 3;
    setBusy(true);
    setError("");
    try {
      await runDemoStep(next);
    } catch (caughtError) {
      const reason = errorMessage(caughtError);
      setError(reason);
      setStatus({ text: `demo step failed — ${reason}`, tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function resetNoisyNeighbour() {
    setBusy(true);
    try {
      setStatus({ text: "demo: resetting…", tone: "info" });
      setDrafts([]);
      for (const tenantId of demoTenantIds) {
        const exists = topologyRef.current.shards
          .flatMap((entry) => entry.tenants)
          .some(
            (route) => route.tenantId === tenantId && route.status !== "disabled"
          );
        if (!exists) continue;
        try {
          await postJson(`/tenants/${encodeURIComponent(tenantId)}/disable`, {
            reason: "reset noisy neighbour demo"
          });
        } catch {
          // ignore
        }
      }
      flashRoutePath();
      await refresh();
      selectTenant(null);
      setDemoActive(false);
      showDemoStep(0);
      setStatus({ text: "demo reset", tone: "info" });
    } catch (caughtError) {
      const reason = errorMessage(caughtError);
      setError(reason);
      setStatus({ text: `demo reset failed — ${reason}`, tone: "error" });
    } finally {
      setBusy(false);
    }
  }


  const totalTenants = useMemo(() => {
    return topology.shards.reduce(
      (sum, entry) =>
        sum + entry.tenants.filter((tenant) => tenant.status !== "disabled").length,
      0
    );
  }, [topology]);

  return (
    <PlacementActionsContext.Provider value={placementActions}>
    <div className="app-shell">
      <header className="app-header">
        <div className="header-copy">
          <h1 className="brand-title">tenant-router</h1>
          <p className="header-subtitle">
            Resolve tenantId → shardId. Postgres stores the route; Redis Streams notifies; each API
            instance keeps a SQLite RouteCache.
          </p>
        </div>
        <div className="header-actions">
          <div
            className="noisy-group"
            role="group"
            aria-labelledby="noisy-neighbour-label"
            title="Lookup-table isolation: crowd free bots → enterprise joins → MoveTenant."
          >
            <span id="noisy-neighbour-label" className="noisy-legend">
              Noisy neighbour
            </span>
            <button
              className="button button-primary button-compact"
              type="button"
              disabled={busy || demoStep >= 4}
              title={
                demoStep === 0
                  ? "Start the isolation demo (step 1 of 4)."
                  : "Run the next demo step."
              }
              onClick={() => void nextNoisyDemoStep()}
            >
              {demoStep === 0 ? "Start" : "Next"}
            </button>
            <button
              className="button button-secondary button-compact"
              type="button"
              disabled={busy || (!demoActive && demoStep === 0)}
              title="Disable demo tenants."
              onClick={() => void resetNoisyNeighbour()}
            >
              Reset
            </button>
          </div>
          <div
            className={`connection-state ${apiOnline ? "" : "connection-state-error"}`}
            title={
              apiOnline
                ? "API health/topology poll OK"
                : "API unreachable (health/topology poll failed)"
            }
          >
            <span className="connection-dot" />
            <span>
              {apiOnline ? "Live" : loading ? "Connecting…" : "API offline"}
            </span>
          </div>
          <div className="header-stat">
            <span>{totalTenants} tenants</span>
            <span>{topology.shards.length} shards</span>
            <span>
              {apiInstances.length > 0 ? apiInstances.length : apiOnline ? 1 : 0} APIs
            </span>
          </div>
        </div>
      </header>

      <section className="how-strip" aria-label="How to use">
        <div className="how-hints">
          <span><strong>Shard +</strong> = new tenant (name + <kbd>Enter</kbd>)</span>
          <span>
            <strong>RouteStore +</strong> = add shard (max{" "}
            {health?.maxDemoShards ?? defaultMaxDemoShards})
          </span>
          <span><strong>Drag tenant</strong> = MoveTenant</span>
          <span><strong>Tenant tier</strong> = change plan</span>
          <span><strong>Shard ×</strong> = delete empty shard</span>
          <span><strong>Tenant ×</strong> = remove</span>
        </div>
      </section>

      <main className="main-stage main-stage-full">
        <section className="canvas-panel">
          <div className={`flow-canvas ${canvasReady ? "is-ready" : "is-pending"}`}>
            {!canvasReady ? (
              <div className="canvas-loading" aria-live="polite">
                Loading…
              </div>
            ) : null}
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onNodeClick={onNodeClick}
              onPaneClick={onPaneClick}
              onNodeDragStart={onNodeDragStart}
              onNodeDragStop={onNodeDragStop}
              fitViewOptions={fitViewOptions}
              minZoom={0.35}
              maxZoom={1.4}
              nodesConnectable={false}
              elementsSelectable
              selectNodesOnDrag={false}
              elevateNodesOnSelect={false}
              panOnDrag={panOnDragButtons}
              panOnScroll
              zoomOnScroll={false}
              zoomOnPinch
              zoomOnDoubleClick={false}
              proOptions={reactFlowProOptions}
            >
              <Background color="#243041" gap={22} size={1} />
              <Controls showZoom={false} showInteractive={false} fitViewOptions={fitViewOptions} />
            </ReactFlow>
          </div>
        </section>
      </main>

      <footer className="bottom-dock">
        <div className="status-dock" aria-live="polite">
          <div className="status-dock-row">
            <div
              className={`status-dock-line ${
                error || status.tone === "error"
                  ? "is-error"
                  : status.tone === "info" || demoStep > 0
                    ? "is-info"
                    : ""
              }`}
              title={
                error
                  ? error
                  : demoStep > 0
                    ? demoStepCopy[demoStep as Exclude<DemoStepId, 0>].detail
                    : undefined
              }
            >
              {error
                ? error
                : demoStep > 0
                  ? `${demoStepCopy[demoStep as Exclude<DemoStepId, 0>].title} — ${
                      demoStepCopy[demoStep as Exclude<DemoStepId, 0>].detail
                    }`
                  : status.text}
            </div>
          </div>
          <div className="status-dock-footer">
            <div className="flow-legend">
              <span><i className="legend-swatch tier-free" /> free</span>
              <span><i className="legend-swatch tier-pro" /> pro</span>
              <span><i className="legend-swatch tier-enterprise" /> enterprise</span>
              <span className="legend-sep" aria-hidden />
              <span title="API resolve path to the selected tenant’s shard; label shows cache hit/miss.">
                <i className="legend-line legend-line-solid" /> resolve → shard
              </span>
              <span title="Sync command write to RouteStore, or cache-miss read from Postgres.">
                <i className="legend-line legend-line-sot" /> SoT write / cache miss
              </span>
              <span title="Async fan-out: RouteStore outbox → Redis Streams → API RouteCache.">
                <i className="legend-line legend-line-dashed" /> route events
              </span>
              <span title="Highlighted when a tenant is selected.">
                <i className="legend-line legend-line-selected" /> selected shard
              </span>
            </div>
            <div className="status-dock-meta" title="Last successful topology fetch from the API (poll every 3s). Not Redis event time.">
              last fetch <span ref={syncedLabelRef}>-</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
    </PlacementActionsContext.Provider>
  );
}

const ApiNode = memo(function ApiNode({ data }: NodeProps<Node<FlowNodeData>>) {
  return (
    <div
      className={`flow-node flow-node-api ${data.highlighted ? "is-highlighted" : ""} ${
        data.flashing ? "is-flashing" : ""
      }`}
      title={
        data.instanceId
          ? `API instance ${data.instanceId}`
          : "API + RouteCache"
      }
    >
      <Handle type="target" position={Position.Top} id="top" className="flow-handle" />
      <span className="node-kicker">resolve</span>
      <strong>{data.title}</strong>
      <span className="node-subtitle">{data.subtitle}</span>
      {data.badge ? <span className="node-badge">{data.badge}</span> : null}
      <Handle type="source" position={Position.Bottom} id="bottom" className="flow-handle" />
      <Handle type="source" position={Position.Left} id="to-store" className="flow-handle" />
      <Handle type="source" position={Position.Right} id="to-store-right" className="flow-handle" />
    </div>
  );
});

const RedisNode = memo(function RedisNode({ data }: NodeProps<Node<FlowNodeData>>) {
  return (
    <div className={`flow-node flow-node-redis ${data.flashing ? "is-flashing" : ""}`}>
      <Handle type="target" position={Position.Top} id="top" className="flow-handle" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="flow-handle" />
      <span className="node-kicker">events</span>
      <strong>{data.title}</strong>
      <span className="node-subtitle">{data.subtitle}</span>
      {data.badge ? <span className="node-badge">{data.badge}</span> : null}
    </div>
  );
});

const PostgresNode = memo(function PostgresNode({ data }: NodeProps<Node<FlowNodeData>>) {
  const { onProvisionShard } = usePlacementActions();
  const showProvision = Boolean(data.canProvision);
  return (
    <div className={`flow-node flow-node-postgres ${data.flashing ? "is-flashing" : ""}`}>
      <Handle type="target" position={Position.Left} id="from-api" className="flow-handle" />
      <Handle type="target" position={Position.Right} id="from-api-right" className="flow-handle" />
      <Handle type="source" position={Position.Bottom} id="to-redis" className="flow-handle" />
      <div className="store-topline">
        <div className="store-heading">
          <span className="node-kicker">source of truth</span>
          <strong>{data.title}</strong>
          <span className="node-subtitle">{data.subtitle}</span>
          {data.badge ? <span className="node-badge">{data.badge}</span> : null}
        </div>
        {showProvision ? (
          <button
            className="chip-add nodrag nopan nowheel"
            type="button"
            disabled={Boolean(data.provisionDisabled)}
            title={
              data.provisionTitle ||
              "Add a shard"
            }
            aria-label={
              data.provisionTitle ||
              "Add a shard"
            }
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
              event.preventDefault();
              event.stopPropagation();
              if (data.provisionDisabled) return;
              onProvisionShard();
            }}
          >
            <span className="chip-add-glyph" aria-hidden="true">
              +
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
});

const ShardNode = memo(function ShardNode({ data }: NodeProps<Node<FlowNodeData>>) {
  const { onAddTenant, onDeleteShard } = usePlacementActions();
  const overloaded = (data.loadScore ?? 0) >= 0.8;
  const canDelete = Boolean(data.canDelete);
  const showDelete = Boolean(data.showDelete);
  return (
    <div
      data-shard-id={data.title}
      className={`flow-node flow-node-shard ${overloaded ? "is-overloaded" : ""} ${
        data.highlighted ? "is-highlighted" : ""
      }`}
    >
      <Handle type="target" position={Position.Top} id="top" className="flow-handle" />
      <div className="shard-topline">
        <div className="shard-heading">
          <span className="node-kicker">shard</span>
          <strong className="shard-id">{data.title}</strong>
          <span className="node-subtitle">{data.subtitle}</span>
          {data.badge ? <span className="node-badge">{data.badge}</span> : null}
        </div>
        <div className="shard-actions">
          <button
            className="chip-add nodrag nopan nowheel"
            type="button"
            title="Add a tenant"
            aria-label={`Add a tenant on ${data.title}`}
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
              event.preventDefault();
              event.stopPropagation();
              onAddTenant(data.title);
            }}
          >
            <span className="chip-add-glyph" aria-hidden="true">
              +
            </span>
          </button>
          {showDelete ? (
            <button
              className="chip-add nodrag nopan nowheel"
              type="button"
              disabled={!canDelete}
              title={
                canDelete
                  ? "Delete this shard"
                  : "Remove tenants first"
              }
              aria-label={
                canDelete
                  ? `Delete shard ${data.title}`
                  : `Cannot delete ${data.title}: remove tenants first`
              }
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                event.preventDefault();
                event.stopPropagation();
                if (!canDelete) return;
                onDeleteShard(data.title);
              }}
            >
              <span className="chip-add-glyph" aria-hidden="true">
                ×
              </span>
            </button>
          ) : null}
        </div>
      </div>
      <div className="load-row">
        <div className="load-track">
          <div
            className={`load-fill${(data.loadScore ?? 0) > 1 ? " is-over-cap" : ""}`}
            style={{
              width: `${Math.min(100, Math.round((data.loadScore ?? 0) * 100))}%`
            }}
          />
        </div>
        <span className="load-label">
          {data.tenantCount ?? 0} tenants
          {data.loadScore !== undefined
            ? ` · load ${Math.round((data.loadScore ?? 0) * 100)}%`
            : ""}
          {data.demoQps !== undefined ? ` · ${data.demoQps} qps` : ""}
        </span>
      </div>
    </div>
  );
});

const TenantNode = memo(function TenantNode({ data }: NodeProps<Node<FlowNodeData>>) {
  const actions = usePlacementActions();
  const tier = data.tier || "free";
  const tenantId = String(data.tenantId || data.title);
  const isDraft = Boolean(data.isDraft);
  const [localName, setLocalName] = useState("");
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isDraft) {
      return;
    }
    const id = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [isDraft, data.draftId]);

  function onNameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || composingRef.current) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const draftId = String(data.draftId || "");
      const name = localName.trim();
      if (name) {
        actions.onCommitDraft(draftId, name);
      } else {
        actions.onCancelDraft(draftId);
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      actions.onCancelDraft(String(data.draftId || ""));
    }
  }

  return (
    <div
      className={`tenant-chip flow-tenant-node tier-${tier} ${
        data.selected ? "is-selected" : ""
      } ${isDraft ? "is-draft" : ""}`}
    >
      <div className="chip-top">
        {isDraft ? (
          <input
            ref={inputRef}
            className="chip-name-input nodrag nopan nowheel"
            data-draft-id={data.draftId}
            value={localName}
            placeholder="tenant name"
            autoComplete="off"
            spellCheck={false}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onChange={(event) => setLocalName(event.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              setLocalName(event.currentTarget.value);
            }}
            onKeyDown={onNameKeyDown}
            onBlur={() => {
              if (composingRef.current) {
                return;
              }
              if (!localName.trim()) {
                actions.onCancelDraft(String(data.draftId || ""));
              }
            }}
          />
        ) : (
          <span className="chip-name" title={tenantId}>
            {tenantId}
          </span>
        )}
        <div className="chip-top-end nodrag nopan nowheel">
          {!isDraft ? (
            <button
              type="button"
              className="chip-icon-btn chip-query-btn"
              title={`Query shard DB (tenants/${tenantId}/query)`}
              aria-label={`Query shard DB for ${tenantId}`}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                actions.onQueryTenant(tenantId, 1);
              }}
            >
              <svg
                className="chip-icon"
                viewBox="0 0 16 16"
                width="14"
                height="14"
                aria-hidden="true"
              >
                <ellipse cx="8" cy="3.5" rx="5.5" ry="2.2" fill="none" stroke="currentColor" strokeWidth="1.25" />
                <path
                  d="M2.5 3.5v9c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2v-9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.25"
                />
                <path
                  d="M2.5 8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.25"
                />
              </svg>
            </button>
          ) : null}
          <button
            type="button"
            className="chip-icon-btn chip-close"
            title={isDraft ? "Discard" : "Remove"}
            aria-label={isDraft ? "Discard draft" : `Remove ${tenantId}`}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (isDraft) {
                actions.onCancelDraft(String(data.draftId || ""));
              } else {
                actions.onDisableTenant(tenantId);
              }
            }}
          >
            ×
          </button>
        </div>
      </div>

      <span className="chip-meta">
        {isDraft ? (
          <select
            className="chip-tier-select nodrag nopan nowheel"
            value={tier}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => {
              event.stopPropagation();
              actions.onDraftTierChange(String(data.draftId || ""), event.target.value);
            }}
          >
            <option value="free">free</option>
            <option value="pro">pro</option>
            <option value="enterprise">enterprise</option>
          </select>
        ) : (
          <select
            className="chip-tier-select nodrag nopan nowheel"
            value={tier}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => {
              event.stopPropagation();
              const next = event.target.value;
              if (next !== tier) {
                actions.onChangeTier(tenantId, next);
              }
            }}
            aria-label={`Tier for ${tenantId}`}
          >
            <option value="free">free</option>
            <option value="pro">pro</option>
            <option value="enterprise">enterprise</option>
          </select>
        )}
        {!isDraft ? (
          <code className="chip-version">v{String(data.routeVersion ?? 1)}</code>
        ) : (
          <span className="chip-version is-new">new</span>
        )}
      </span>
    </div>
  );
});

const nodeTypes = {
  api: ApiNode,
  redis: RedisNode,
  postgres: PostgresNode,
  shard: ShardNode,
  tenant: TenantNode
};

/** API → shard resolve: down to a bus under the APIs, then across and into shard top. */
const DownResolveEdge = memo(function DownResolveEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd,
  markerStart,
  data
}: EdgeProps) {
  // Same fork rhythm as DropBusEdge: branch at mid-gap.
  const busY = sourceY + (targetY - sourceY) * 0.5;
  const path = [
    `M ${sourceX},${sourceY}`,
    `L ${sourceX},${busY}`,
    `L ${targetX},${busY}`,
    `L ${targetX},${targetY}`
  ].join(" ");
  const cacheHit = data && typeof data === "object" ? data.cacheHit : undefined;
  const showCache =
    typeof cacheHit === "boolean" ? (cacheHit ? "cache hit" : "cache miss") : null;
  const labelX = (sourceX + targetX) / 2;
  const labelY = busY;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={style}
        markerEnd={markerEnd}
        markerStart={markerStart}
      />
      {showCache ? (
        <EdgeLabelRenderer>
          <div
            className={
              cacheHit ? "resolve-edge-label hit" : "resolve-edge-label miss"
            }
            style={{
              transform: `translate(-50%, -120%) translate(${labelX}px,${labelY}px)`
            }}
          >
            {showCache}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});

/** Left/right exits: go outward horizontally first, then bend (no straight stub-out). */
const SideStubEdge = memo(function SideStubEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd,
  markerStart,
  sourcePosition,
  targetPosition
}: EdgeProps) {
  const stub = 28;
  const sourceIsLeft = sourcePosition === Position.Left;
  const targetIsLeft = targetPosition === Position.Left;
  // Keep a single outer rail so left/right SoT skirts Redis instead of crossing it.
  const railX = sourceIsLeft
    ? Math.min(sourceX, targetX) - stub
    : Math.max(sourceX, targetX) + stub;
  const midY = (sourceY + targetY) / 2;
  const path = [
    `M ${sourceX},${sourceY}`,
    `L ${railX},${sourceY}`,
    `L ${railX},${midY}`,
    `L ${railX},${targetY}`,
    `L ${targetX},${targetY}`
  ].join(" ");
  return (
    <BaseEdge
      id={id}
      path={path}
      style={style}
      markerEnd={markerEnd}
      markerStart={markerStart}
    />
  );
});


/** Redis → API fan-out: shared vertical trunk, then bus + drop (avoids N overlapping curves). */
const DropBusEdge = memo(function DropBusEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd,
  markerStart
}: EdgeProps) {
  // Branch at mid-gap so Redis→API stem matches API→shard resolve stems.
  const busY = sourceY + (targetY - sourceY) * 0.5;
  const path = [
    `M ${sourceX},${sourceY}`,
    `L ${sourceX},${busY}`,
    `L ${targetX},${busY}`,
    `L ${targetX},${targetY}`
  ].join(" ");
  return (
    <BaseEdge
      id={id}
      path={path}
      style={style}
      markerEnd={markerEnd}
      markerStart={markerStart}
    />
  );
});

const edgeTypes = {
  downResolve: DownResolveEdge,
  sideStub: SideStubEdge,
  dropBus: DropBusEdge
};


function applyPendingMove(
  topology: TopologySnapshot,
  pending: { tenantId: string; shardId: string } | null
): TopologySnapshot {
  if (!pending) return topology;
  // Keep prior routeVersion/tier; only relocate. Version comes from the move response.
  return upsertTenantRoute(topology, {
    tenantId: pending.tenantId,
    shardId: pending.shardId,
    routeVersion: 0
  });
}

/** Move/insert a tenant route onto its shardId; used for optimistic UI + move response. */
function upsertTenantRoute(
  topology: TopologySnapshot,
  route: TenantRoute
): TopologySnapshot {
  const tenantId = route.tenantId;
  const targetShardId = route.shardId;
  let previous: TenantRoute | null = null;
  const stripped = topology.shards.map((entry) => {
    const tenants = entry.tenants.filter((tenant) => {
      if (tenant.tenantId !== tenantId) return true;
      previous = tenant;
      return false;
    });
    return {
      ...entry,
      tenants,
      tenantCount: tenants.filter((tenant) => tenant.status !== "disabled").length
    };
  });
  const base: TenantRoute = previous || {
    tenantId,
    shardId: targetShardId,
    routeVersion: 1,
    status: "active"
  };
  const nextRoute: TenantRoute = {
    ...base,
    ...route,
    tenantId,
    shardId: targetShardId,
    // Preserve prior version when optimistic relocate omits/zeros it.
    routeVersion:
      route.routeVersion && route.routeVersion > 0
        ? route.routeVersion
        : base.routeVersion || 1,
    tier: route.tier ?? base.tier,
    status: route.status ?? base.status ?? "active"
  };
  let foundTarget = false;
  const shards = stripped.map((entry) => {
    if (entry.shard.id !== targetShardId) return entry;
    foundTarget = true;
    const tenants = [...entry.tenants, nextRoute];
    return {
      ...entry,
      tenants,
      tenantCount: tenants.filter((tenant) => tenant.status !== "disabled").length
    };
  });
  if (!foundTarget) return topology;
  return { ...topology, shards };
}

function buildGraph({
  health,
  apiInstances,
  topology,
  drafts,
  selectedTenantId,
  resolveCacheHit,
  resolveInstanceId,
  pulsePhase,
  busy,
  pendingMove
}: {
  health: HealthSnapshot | null;
  apiInstances: ApiInstanceInfo[];
  topology: TopologySnapshot;
  drafts: DraftTenant[];
  selectedTenantId: string | null;
  resolveCacheHit: boolean | null;
  resolveInstanceId: string | null;
  pulsePhase: "off" | "store" | "redis" | "api";
  busy: boolean;
  pendingMove: { tenantId: string; shardId: string } | null;
}): { nodes: Node<FlowNodeData>[]; edges: Edge[] } {
  const pulseStore = pulsePhase === "store";
  const pulseRedis = pulsePhase === "redis";
  const pulseApi = pulsePhase === "api";
  const placement = applyPendingMove(topology, pendingMove);
  const selected = placement.shards
    .flatMap((entry) => entry.tenants)
    .find(
      (route) => route.tenantId === selectedTenantId && route.status !== "disabled"
    );
  const selectedShardId = selected?.shardId ?? null;

  const instances =
    apiInstances.length > 0
      ? apiInstances
      : health?.instanceId
        ? [
            {
              instanceId: health.instanceId,
              pid: health.pid,
              cache: health.cache,
              updatedAt: ""
            }
          ]
        : [];
  // Do not follow health.instanceId — /health is load-balanced and would
  // swap the resolve-edge source every poll. Stick to resolve answer, else
  // the first registered replica (stable sort from /instances).
  const activeInstanceId =
    (resolveInstanceId &&
    instances.some((entry) => entry.instanceId === resolveInstanceId)
      ? resolveInstanceId
      : null) ??
    instances[0]?.instanceId ??
    null;
  const activeApiId = activeInstanceId ? apiNodeId(activeInstanceId) : "api:pending";
  const apiCount = Math.max(1, instances.length);
  const apiRowWidth =
    apiCount * apiNodeWidth + Math.max(0, apiCount - 1) * apiNodeGap;
  const infraNodeX = infraX;
  const apiRowStartX =
    infraX + Math.max(0, (infraNodeWidth - apiRowWidth) / 2);

  const nodes: Node<FlowNodeData>[] = [
    {
      id: "routestore",
      type: "postgres",
      position: { x: infraNodeX, y: routeStoreY },
      style: { width: infraNodeWidth, zIndex: 2 },
      data: {
        kind: "postgres",
        title: "RouteStore",
        subtitle: "routing-postgres · tenantId → shardId",
        badge: "postgres",
        flashing: pulseStore,
        canProvision: true,
        provisionDisabled:
          busy ||
          topology.shards.length >= (health?.maxDemoShards ?? defaultMaxDemoShards),
        provisionTitle:
          topology.shards.length >= (health?.maxDemoShards ?? defaultMaxDemoShards)
            ? `Shard limit reached (${health?.maxDemoShards ?? defaultMaxDemoShards})`
            : "Add a shard"
      },
      draggable: false,
      selectable: false,
      zIndex: 2
    },
    {
      id: "redis",
      type: "redis",
      position: { x: infraNodeX, y: redisY },
      style: { width: infraNodeWidth, zIndex: 2 },
      data: {
        kind: "redis",
        title: "Redis Streams",
        subtitle: health?.streamKey
          ? `fan-out · ${health.streamKey}`
          : "route-change fan-out",
        badge: "redis",
        flashing: pulseRedis
      },
      draggable: false,
      selectable: false,
      zIndex: 2
    }
  ];

  if (instances.length === 0) {
    nodes.push({
      id: "api:pending",
      type: "api",
      position: {
        x: apiRowStartX + Math.max(0, (apiRowWidth - apiNodeWidth) / 2),
        y: apiRowY
      },
      data: {
        kind: "api",
        title: "API + RouteCache",
        subtitle: "waiting for API",
        badge: "sqlite",
        highlighted: false,
        flashing: pulseApi
      },
      style: { width: apiNodeWidth, zIndex: 2 },
      draggable: false,
      selectable: false,
      zIndex: 2
    });
  } else {
    instances.forEach((instance, index) => {
      const isActive = instance.instanceId === activeInstanceId;
      nodes.push({
        id: apiNodeId(instance.instanceId),
        type: "api",
        position: {
          x: apiRowStartX + index * (apiNodeWidth + apiNodeGap),
          y: apiRowY
        },
        data: {
          kind: "api",
          title: instances.length > 1 ? `API ${index + 1}` : "API + RouteCache",
          subtitle: shortInstanceId(instance.instanceId),
          badge: instance.cache || "sqlite",
          instanceId: instance.instanceId,
          highlighted: Boolean(selected) && isActive,
          flashing: pulseApi && isActive
        },
        style: { width: apiNodeWidth, zIndex: 2 },
        draggable: false,
        selectable: false,
        zIndex: 2
      });
    });
  }

  placement.shards.forEach((entry, index) => {
    const activeTenants = entry.tenants.filter((tenant) => tenant.status !== "disabled");
    const shardDrafts = drafts.filter((draft) => draft.shardId === entry.shard.id);
    const chipCount = activeTenants.length + shardDrafts.length;
    const height = Math.max(
      shardMinHeight,
      chipCount === 0
        ? shardMinHeight
        : chipTopInset + (chipCount - 1) * chipStep + chipHeight + shardBottomPad
    );
    const shardX = shardRowX + index * (shardWidth + shardGapX);
    const shardY = shardRowY;

    nodes.push({
      id: `shard-${entry.shard.id}`,
      type: "shard",
      position: { x: shardX, y: shardY },
      data: {
        kind: "shard",
        title: entry.shard.id,
        subtitle: entry.shard.name || entry.shard.region || "data shard",
        badge: "postgres",
        loadScore: entry.shard.loadScore,
        demoQps: entry.shard.demoQps,
        tenantCount: activeTenants.length + shardDrafts.length,
        highlighted: selectedShardId === entry.shard.id,
        showDelete: topology.shards.length > 1,
        canDelete:
          topology.shards.length > 1 &&
          activeTenants.length === 0 &&
          shardDrafts.length === 0
      },
      style: { width: shardWidth, height, zIndex: 1 },
      zIndex: 1,
      draggable: false,
      selectable: false
    });

    activeTenants.forEach((tenant, tenantIndex) => {
      nodes.push({
        id: `tenant-${tenant.tenantId}`,
        type: "tenant",
        position: {
          x: shardX + 18,
          y: shardY + chipTopInset + tenantIndex * chipStep
        },
        data: {
          kind: "tenant",
          title: tenant.tenantId,
          tenantId: tenant.tenantId,
          tier: tenant.tier || "free",
          routeVersion: tenant.routeVersion,
          selected: selectedTenantId === tenant.tenantId
        },
        style: { width: tenantNodeWidth, zIndex: 10 },
        zIndex: 10,
        draggable: true,
        selectable: true
      });
    });

    shardDrafts.forEach((draft, draftIndex) => {
      nodes.push({
        id: `draft-${draft.draftId}`,
        type: "tenant",
        position: {
          x: shardX + 18,
          y: shardY + chipTopInset + (activeTenants.length + draftIndex) * chipStep
        },
        data: {
          kind: "tenant",
          title: "new",
          tier: draft.tier || "free",
          isDraft: true,
          draftId: draft.draftId,
          selected: true
        },
        style: { width: tenantNodeWidth, zIndex: 20 },
        zIndex: 20,
        draggable: false,
        selectable: false
      });
    });
  });

  // Keep infra edges under nodes (high zIndex was drawing lines through API cards).
  const infraZ = 0;
  const resolveZ = 1;

  const edges: Edge[] = placement.shards.map((entry) => {
    const isSelected = selectedShardId === entry.shard.id;
    return {
      id: `api-${entry.shard.id}`,
      type: "downResolve",
      source: activeApiId,
      sourceHandle: "bottom",
      target: `shard-${entry.shard.id}`,
      targetHandle: "top",
      animated: isSelected,
      zIndex: resolveZ,
      data:
        isSelected && resolveCacheHit !== null
          ? { cacheHit: resolveCacheHit }
          : undefined,
      style: {
        stroke: isSelected ? "#59a8ff" : "#8fa3bb",
        strokeWidth: isSelected ? 2.5 : 1.5
      }
    };
  });

  const apiIds =
    instances.length > 0
      ? instances.map((entry) => apiNodeId(entry.instanceId))
      : ["api:pending"];

  // SoT: pick left/right outer path from active API vs RouteStore so we skirt Redis.
  const activeApiIndex = Math.max(
    0,
    instances.findIndex((entry) => apiNodeId(entry.instanceId) === activeApiId)
  );
  const activeApiCenterX =
    apiRowStartX + activeApiIndex * (apiNodeWidth + apiNodeGap) + apiNodeWidth / 2;
  const routeStoreCenterX = infraNodeX + infraNodeWidth / 2;
  const sotOnRight = activeApiCenterX > routeStoreCenterX + 8;
  edges.push({
    id: "api-routestore",
    type: "sideStub",
    source: activeApiId,
    sourceHandle: sotOnRight ? "to-store-right" : "to-store",
    target: "routestore",
    targetHandle: sotOnRight ? "from-api-right" : "from-api",
    animated: pulseStore,
    zIndex: infraZ,
    style: {
      stroke: pulseStore ? "#f0b429" : "#6db3a0",
      strokeWidth: pulseStore ? 2.5 : 1.5,
      strokeDasharray: "10 8"
    }
  });

  // Outbox: RouteStore → Redis Streams.
  edges.push({
    id: "routestore-redis",
    source: "routestore",
    sourceHandle: "to-redis",
    target: "redis",
    targetHandle: "top",
    animated: pulseStore || pulseRedis,
    zIndex: infraZ,
    style: {
      stroke: pulseStore || pulseRedis ? "#f0b429" : "#7b8ea6",
      strokeWidth: pulseStore || pulseRedis ? 2.5 : 1.5,
      strokeDasharray: "10 8"
    }
  });

  // Fan-out: Redis → each API via a shared drop-bus (one trunk, then branch).
  for (const apiId of apiIds) {
    const isActive = apiId === activeApiId;
    edges.push({
      id: `redis-${apiId}`,
      type: "dropBus",
      source: "redis",
      sourceHandle: "bottom",
      target: apiId,
      targetHandle: "top",
      animated: (pulseRedis || pulseApi) && isActive,
      zIndex: infraZ,
      style: {
        stroke: (pulseRedis || pulseApi) && isActive ? "#f0b429" : "#7b8ea6",
        strokeWidth: (pulseRedis || pulseApi) && isActive ? 2.5 : 1.5,
        strokeDasharray: "10 8"
      }
    });
  }

  return { nodes, edges };
}


function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}


async function fetchResolvedRoute(tenantId: string): Promise<ResolvedRouteView> {
  const payload = await request(`/route/${encodeURIComponent(tenantId)}`);
  if (!isRecord(payload) || !isRecord(payload.route)) {
    throw new Error("Invalid route payload");
  }
  const route = payload.route;
  return {
    tenantId: stringValue(route.tenantId, tenantId),
    cacheHit: Boolean(payload.cacheHit),
    instanceId: stringValue(payload.instanceId)
  };
}

async function fetchHealth(): Promise<HealthSnapshot> {
  const payload = await request("/health");
  if (!isRecord(payload)) throw new Error("Invalid health payload");
  return {
    ok: Boolean(payload.ok),
    instanceId: stringValue(payload.instanceId),
    pid: numberValue(payload.pid),
    cache: stringValue(payload.cache),
    streamKey: stringValue(payload.streamKey),
    routingPoolMax: numberValue(payload.routingPoolMax),
    shardPoolMax: numberValue(payload.shardPoolMax),
    maxDemoShards: numberValue(payload.maxDemoShards, defaultMaxDemoShards)
  };
}

async function fetchApiInstances(): Promise<ApiInstanceInfo[]> {
  const payload = await request("/instances");
  if (!isRecord(payload) || !Array.isArray(payload.instances)) {
    return [];
  }
  const instances: ApiInstanceInfo[] = [];
  for (const entry of payload.instances) {
    if (!isRecord(entry)) continue;
    const instanceId = stringValue(entry.instanceId);
    if (!instanceId) continue;
    instances.push({
      instanceId,
      pid: numberValue(entry.pid),
      cache: stringValue(entry.cache, "sqlite"),
      updatedAt: stringValue(entry.updatedAt)
    });
  }
  return instances;
}

async function fetchTopology(): Promise<TopologySnapshot> {
  const payload = await request("/topology");
  if (!isRecord(payload)) throw new Error("Invalid topology payload");
  const shards = Array.isArray(payload.shards)
    ? payload.shards
        .map(readShardTopology)
        .filter((entry): entry is ShardTopology => entry !== null)
    : [];
  const unassignedRoutes = Array.isArray(payload.unassignedRoutes)
    ? payload.unassignedRoutes
        .map(readTenantRoute)
        .filter((route): route is TenantRoute => route !== null)
    : [];
  return {
    generatedAt: stringValue(payload.generatedAt),
    shards,
    unassignedRoutes
  };
}

function readShardTopology(value: unknown): ShardTopology | null {
  if (!isRecord(value) || !isRecord(value.shard)) return null;
  const shard = value.shard;
  const tenants = Array.isArray(value.tenants)
    ? value.tenants
        .map(readTenantRoute)
        .filter((route): route is TenantRoute => route !== null)
    : [];
  return {
    shard: {
      id: stringValue(shard.id),
      name: optionalString(shard.name),
      status: optionalString(shard.status),
      region: optionalString(shard.region),
      capacity: optionalNumber(shard.capacity),
      loadScore: optionalNumber(shard.loadScore),
      demoQps: optionalNumber(shard.demoQps)
    },
    tenants,
    tenantCount: numberValue(value.tenantCount, tenants.length)
  };
}

function readTenantRoute(value: unknown): TenantRoute | null {
  if (!isRecord(value)) return null;
  const tenantId = stringValue(value.tenantId);
  const shardId = stringValue(value.shardId);
  if (!tenantId || !shardId) return null;
  return {
    tenantId,
    shardId,
    routeVersion: numberValue(value.routeVersion, 1),
    tier: optionalString(value.tier),
    status: optionalString(value.status),
    reason: optionalString(value.reason),
    updatedAt: optionalString(value.updatedAt)
  };
}

function readRoute(payload: unknown): TenantRoute | null {
  if (!isRecord(payload)) return null;
  return readTenantRoute(payload.route);
}

async function request(path: string, options?: RequestInit): Promise<unknown> {
  const response = await fetch(`/api${path}`, options);
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const code =
      isRecord(payload) && typeof payload.error === "string" ? payload.error : "";
    const detail =
      isRecord(payload) && typeof payload.message === "string"
        ? payload.message
        : "";
    const message =
      code && detail
        ? `${code}: ${detail}`
        : detail || code || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
