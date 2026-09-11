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
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnNodeDrag
} from "@xyflow/react";

import type {
  DraftTenant,
  FlowNodeData,
  HealthSnapshot,
  PlacementActions,
  ShardTopology,
  TenantRoute,
  TopologySnapshot
} from "./types";

const pollIntervalMs = 3000;
const fitViewOptions = { padding: 0.18, minZoom: 0.4, maxZoom: 1, duration: 0 } as const;
const panOnDragButtons: number[] = [1, 2];
const reactFlowProOptions = { hideAttribution: true } as const;
const shardWidth = 280;
const shardMinHeight = 220;
const tenantNodeWidth = 240;
const chipTopInset = 136;
const chipStep = 72;
const chipHeight = 60;
const shardBottomPad = 18;

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
    a.tenantCount === b.tenantCount &&
    a.tenantId === b.tenantId &&
    a.tier === b.tier &&
    a.routeVersion === b.routeVersion &&
    a.isDraft === b.isDraft &&
    a.draftId === b.draftId
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
      dragging: prev.dragging
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
    a.shardCount === b.shardCount
  );
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
      left.source !== right.source ||
      left.target !== right.target ||
      left.animated !== right.animated ||
      JSON.stringify(left.style ?? null) !== JSON.stringify(right.style ?? null)
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
  const [topology, setTopology] = useState<TopologySnapshot>(emptyTopology);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftTenant[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<{ text: string; tone: "idle" | "info" | "error" }>({
    text: "Ready.",
    tone: "idle"
  });
  const [demoActive, setDemoActive] = useState(false);
  const syncedLabelRef = useRef<HTMLSpanElement | null>(null);
  const [canvasReady, setCanvasReady] = useState(false);

  const [redisFlash, setRedisFlash] = useState(false);
  const [nodes, setNodes] = useState<Node<FlowNodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  const selectionLockedOffRef = useRef(false);
  const autoSelectedRef = useRef(false);
  const topologyRef = useRef(topology);
  const draftsRef = useRef(drafts);
  const didFitRef = useRef(false);
  const dragOriginShardRef = useRef<string | null>(null);
  const draggingNodeIdRef = useRef<string | null>(null);

  const { fitView, getIntersectingNodes } = useReactFlow<Node<FlowNodeData>, Edge>();

  useEffect(() => {
    topologyRef.current = topology;
  }, [topology]);

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  const flashRedis = useCallback(() => {
    setRedisFlash(true);
    window.setTimeout(() => setRedisFlash(false), 1400);
  }, []);

  const postJson = useCallback(async (path: string, body: unknown) => {
    return request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }, []);

  const selectTenant = useCallback((tenantId: string | null) => {
    if (tenantId === null) {
      selectionLockedOffRef.current = true;
      setSelectedTenantId(null);
      return;
    }
    selectionLockedOffRef.current = false;
    setSelectedTenantId(tenantId);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [nextHealth, nextTopology] = await Promise.all([
        fetchHealth(),
        fetchTopology()
      ]);
      setHealth((current) => (healthEqual(current, nextHealth) ? current : nextHealth));
      setTopology((current) =>
        topologyEqual(current, nextTopology) ? current : nextTopology
      );
      // Update clock without React state — a setState here re-renders React Flow every poll.
      if (syncedLabelRef.current && nextTopology.generatedAt) {
        syncedLabelRef.current.textContent = new Date(
          nextTopology.generatedAt
        ).toLocaleTimeString();
      }
      setError("");

      const demoPresent = nextTopology.shards.some((entry) =>
        entry.tenants.some(
          (tenant) =>
            demoTenantIds.includes(tenant.tenantId) && tenant.status !== "disabled"
        )
      );
      setDemoActive(demoPresent);

      if (!autoSelectedRef.current && !selectionLockedOffRef.current) {
        const first = nextTopology.shards
          .flatMap((entry) => entry.tenants)
          .find((tenant) => tenant.status !== "disabled");
        if (first) {
          autoSelectedRef.current = true;
          setSelectedTenantId(first.tenantId);
        }
      }
    } catch (caughtError) {
      setError(errorMessage(caughtError));
    } finally {
      setLoading(false);
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

      setBusy(true);
      setError("");
      const fromShardId = current.shardId;
      setStatus({ text: `moving tenant ${tenantId}…`, tone: "info" });
      try {
        const payload = await postJson(
          `/tenants/${encodeURIComponent(tenantId)}/move`,
          { shardId, reason: "moved from placement map" }
        );
        flashRedis();
        await refresh();
        const route = readRoute(payload);
        if (route) {
          selectTenant(route.tenantId);
          setStatus({
            text: `move tenant ${route.tenantId} from ${fromShardId} to ${route.shardId}`,
            tone: "info"
          });
        }
        return true;
      } catch (caughtError) {
        setError(errorMessage(caughtError));
        setStatus({ text: "move failed", tone: "error" });
        await refresh();
        return false;
      } finally {
        setBusy(false);
      }
    },
    [flashRedis, postJson, refresh, selectTenant]
  );

  const applyTier = useCallback(
    async (tenantId: string, tier: string) => {
      setBusy(true);
      setError("");
      try {
        const payload = await postJson(
          `/tenants/${encodeURIComponent(tenantId)}/tier`,
          { tier, reason: "changed from placement map" }
        );
        flashRedis();
        await refresh();
        const route = readRoute(payload);
        if (route) {
          setStatus({
            text: `tier tenant ${route.tenantId} → ${route.tier}`,
            tone: "info"
          });
        }
      } catch (caughtError) {
        setError(errorMessage(caughtError));
        setStatus({ text: "tier change failed", tone: "error" });
      } finally {
        setBusy(false);
      }
    },
    [flashRedis, postJson, refresh]
  );


  const disableTenant = useCallback(
    async (tenantId: string) => {
      setBusy(true);
      setError("");
      try {
        await postJson(`/tenants/${encodeURIComponent(tenantId)}/disable`, {
          reason: "removed from placement map"
        });
        flashRedis();
        await refresh();
        setStatus({ text: `remove tenant ${tenantId}`, tone: "info" });
        if (selectedTenantId === tenantId) {
          selectTenant(null);
        }
      } catch (caughtError) {
        setError(errorMessage(caughtError));
        setStatus({ text: "remove failed", tone: "error" });
      } finally {
        setBusy(false);
      }
    },
    [flashRedis, postJson, refresh, selectTenant, selectedTenantId]
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
      const exists = topologyRef.current.shards.some((entry) =>
        entry.tenants.some(
          (route) => route.tenantId === tenantId && route.status !== "disabled"
        )
      );
      if (exists) {
        setError(`Tenant "${tenantId}" already exists.`);
        return;
      }

      setBusy(true);
      setError("");
      setStatus({ text: `creating tenant ${tenantId}…`, tone: "info" });
      try {
        const payload = await postJson("/tenants", {
          tenantId,
          shardId: draft.shardId,
          tier: draft.tier || "free",
          reason: "created from placement map"
        });
        flashRedis();
        setDrafts((current) => current.filter((entry) => entry.draftId !== draftId));
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
        setError(errorMessage(caughtError));
        setStatus({ text: "create failed", tone: "error" });
      } finally {
        setBusy(false);
      }
    },
    [flashRedis, postJson, refresh, selectTenant]
  );


  const placementActions = useMemo<PlacementActions>(
    () => ({
      onAddTenant: addDraft,
      onChangeTier: (tenantId, tier) => {
        void applyTier(tenantId, tier);
      },
      onDisableTenant: (tenantId) => {
        void disableTenant(tenantId);
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
    [addDraft, applyTier, commitDraft, disableTenant]
  );

  useEffect(() => {
    const built = buildGraph({
      health,
      topology,
      drafts,
      selectedTenantId,
      redisFlash
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
  }, [drafts, health, redisFlash, selectedTenantId, topology]);

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
        }
      }
    },
    [selectTenant]
  );

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
      draggingNodeIdRef.current = null;
      if (node.type !== "tenant" || node.data.isDraft || busy) {
        return;
      }
      const tenantId = String(node.data.tenantId || "");
      if (!tenantId) {
        return;
      }

      let targetShardId: string | null = null;
      const hits = getIntersectingNodes(node, true).filter(
        (candidate) => candidate.type === "shard"
      );
      if (hits[0]) {
        targetShardId = String(
          hits[0].data.title || hits[0].id.replace(/^shard-/, "")
        );
      } else if ("clientX" in event) {
        const stack = document.elementsFromPoint(event.clientX, event.clientY);
        const host = stack
          .map((el) => (el instanceof Element ? el.closest("[data-shard-id]") : null))
          .find((el): el is Element => Boolean(el));
        targetShardId = host?.getAttribute("data-shard-id") ?? null;
      }

      const originShardId = dragOriginShardRef.current;
      if (!targetShardId || targetShardId === originShardId) {
        void refresh();
        return;
      }
      void moveTenant(tenantId, targetShardId);
    },
    [busy, getIntersectingNodes, moveTenant, refresh]
  );

  const ensureTenant = useCallback(
    async (
      tenantId: string,
      shardId: string,
      tier: string,
      reason: string
    ): Promise<void> => {
      const existing = topologyRef.current.shards
        .flatMap((entry) => entry.tenants)
        .find((route) => route.tenantId === tenantId);
      if (!existing) {
        await postJson("/tenants", { tenantId, shardId, tier, reason });
        flashRedis();
        return;
      }
      // Local API: move re-activates a disabled route (including same-shard move).
      if (existing.status === "disabled" || existing.shardId !== shardId) {
        await postJson(`/tenants/${encodeURIComponent(tenantId)}/move`, {
          shardId,
          reason
        });
        flashRedis();
      }
      if ((existing.tier || "free") !== tier) {
        await postJson(`/tenants/${encodeURIComponent(tenantId)}/tier`, {
          tier,
          reason
        });
        flashRedis();
      }
    },
    [flashRedis, postJson]
  );

  async function addNoisyNeighbour() {
    setBusy(true);
    setError("");
    setDrafts([]);
    selectionLockedOffRef.current = false;
    try {
      setStatus({ text: "demo: crowding shard-1 with noisy-bot-1…5", tone: "info" });
      for (const tenantId of noisyNeighbourTenants) {
        await ensureTenant(tenantId, "shard-1", "free", "noisy neighbour");
      }
      await postJson("/shards", {
        id: "shard-1",
        name: "Local shard 1",
        region: "local",
        capacity: 1000,
        loadScore: 0.92,
        status: "active"
      });
      await refresh();

      setStatus({ text: "demo: place enterprise-acme on crowded shard-1", tone: "info" });
      await ensureTenant(
        demoEnterpriseTenant,
        "shard-1",
        "enterprise",
        "noisy neighbour enterprise"
      );
      await refresh();
      selectTenant(demoEnterpriseTenant);
      await wait(600);

      setStatus({
        text: "demo: move enterprise-acme from shard-1 to shard-4",
        tone: "info"
      });
      await ensureTenant(
        demoEnterpriseTenant,
        "shard-4",
        "enterprise",
        "isolated from noisy neighbours"
      );
      await postJson("/shards", {
        id: "shard-4",
        name: "Local shard 4",
        region: "local",
        capacity: 1000,
        loadScore: 0.12,
        status: "active"
      });
      flashRedis();
      await refresh();
      selectTenant(demoEnterpriseTenant);
      setDemoActive(true);
      setStatus({ text: "demo: isolation complete", tone: "info" });
    } catch (caughtError) {
      setError(errorMessage(caughtError));
      setStatus({ text: "demo failed", tone: "error" });
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
      for (const shardId of ["shard-1", "shard-2", "shard-3", "shard-4"]) {
        await postJson("/shards", {
          id: shardId,
          name: `Local shard ${shardId.slice(-1)}`,
          region: "local",
          capacity: 1000,
          loadScore: 0,
          status: "active"
        });
      }
      await refresh();
      selectTenant(null);
      setDemoActive(false);
      setStatus({ text: "demo reset", tone: "info" });
    } catch (caughtError) {
      setError(errorMessage(caughtError));
      setStatus({ text: "demo reset failed", tone: "error" });
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
          <div className="noisy-add">
            <button
              className="button button-primary button-compact"
              type="button"
              disabled={busy}
              title="Crowd shard-1 with free noisy-bot-1…5 (annotated loadScore 0.92), place enterprise-acme there, then MoveTenant isolate it on shard-4 (loadScore 0.12)."
              onClick={() => void addNoisyNeighbour()}
            >
              Add a noisy neighbour
            </button>
            <button
              className="button button-secondary button-compact"
              type="button"
              disabled={busy || !demoActive}
              title="Disable demo tenants (noisy-bot-1…5, enterprise-acme) and clear annotated shard loadScores."
              onClick={() => void resetNoisyNeighbour()}
            >
              Reset
            </button>
          </div>
          <div className={`connection-state ${error ? "connection-state-error" : ""}`}>
            <span className="connection-dot" />
            <span>{error ? "API unavailable" : "Live"}</span>
          </div>
          <div className="header-stat">
            <span>{totalTenants} tenants</span>
            <span>{topology.shards.length} shards</span>
          </div>
        </div>
      </header>

      <section className="how-strip" aria-label="How to use">
        <div className="how-hints">
          <span><strong>Shard +</strong> = new tenant (name + Enter)</span>
          <span><strong>Drag tenant</strong> = MoveTenant</span>
          <span><strong>Tenant tier</strong> = change plan</span>
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
              onNodesChange={onNodesChange}
              onNodeClick={onNodeClick}
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
          <div
            className={`status-dock-line ${
              error || status.tone === "error" ? "is-error" : status.tone === "info" ? "is-info" : ""
            }`}
          >
            {error || status.text}
          </div>
          <div className="status-dock-footer">
            <div className="flow-legend">
              <span><i className="legend-swatch tier-free" /> free</span>
              <span><i className="legend-swatch tier-pro" /> pro</span>
              <span><i className="legend-swatch tier-enterprise" /> enterprise</span>
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
    >
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <span className="node-kicker">resolve</span>
      <strong>{data.title}</strong>
      <span className="node-subtitle">{data.subtitle}</span>
      {data.badge ? <span className="node-badge">{data.badge}</span> : null}
      <Handle type="source" position={Position.Right} className="flow-handle" />
    </div>
  );
});

const RedisNode = memo(function RedisNode({ data }: NodeProps<Node<FlowNodeData>>) {
  return (
    <div className={`flow-node flow-node-redis ${data.flashing ? "is-flashing" : ""}`}>
      <Handle type="source" position={Position.Bottom} className="flow-handle" />
      <span className="node-kicker">events</span>
      <strong>{data.title}</strong>
      <span className="node-subtitle">{data.subtitle}</span>
      {data.badge ? <span className="node-badge">{data.badge}</span> : null}
    </div>
  );
});

const ShardNode = memo(function ShardNode({ data }: NodeProps<Node<FlowNodeData>>) {
  const { onAddTenant } = usePlacementActions();
  const overloaded = (data.loadScore ?? 0) >= 0.8;
  return (
    <div
      data-shard-id={data.title}
      className={`flow-node flow-node-shard ${overloaded ? "is-overloaded" : ""} ${
        data.highlighted ? "is-highlighted" : ""
      }`}
    >
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <div className="shard-topline">
        <div className="shard-heading">
          <span className="node-kicker">shard</span>
          <strong className="shard-id">{data.title}</strong>
          <span className="node-subtitle">{data.subtitle}</span>
          {data.badge ? <span className="node-badge">{data.badge}</span> : null}
        </div>
        <button
          className="chip-add nodrag nopan nowheel"
          type="button"
          title={`Add tenant on ${data.title}`}
          onClick={(event: MouseEvent<HTMLButtonElement>) => {
            event.preventDefault();
            event.stopPropagation();
            onAddTenant(data.title);
          }}
        >
          +
        </button>
      </div>
      <div className="load-row">
        <div className="load-track">
          <div
            className="load-fill"
            style={{ width: `${Math.min(100, Math.round((data.loadScore ?? 0) * 100))}%` }}
          />
        </div>
        <span className="load-label">
          {data.tenantCount ?? 0} tenants
          {data.loadScore !== undefined
            ? ` · load ${Math.min(100, Math.round((data.loadScore ?? 0) * 100))}%`
            : ""}
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
      <button
        type="button"
        className="chip-close nodrag nopan nowheel"
        title={isDraft ? "Discard" : "Remove"}
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
        <span className="chip-name">{tenantId}</span>
      )}

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
        {!isDraft ? <code>v{String(data.routeVersion ?? 1)}</code> : <span>new</span>}
      </span>
    </div>
  );
});



const nodeTypes = {
  api: ApiNode,
  redis: RedisNode,
  shard: ShardNode,
  tenant: TenantNode
};

function buildGraph({
  health,
  topology,
  drafts,
  selectedTenantId,
  redisFlash
}: {
  health: HealthSnapshot | null;
  topology: TopologySnapshot;
  drafts: DraftTenant[];
  selectedTenantId: string | null;
  redisFlash: boolean;
}): { nodes: Node<FlowNodeData>[]; edges: Edge[] } {
  const selected = topology.shards
    .flatMap((entry) => entry.tenants)
    .find(
      (route) => route.tenantId === selectedTenantId && route.status !== "disabled"
    );
  const selectedShardId = selected?.shardId ?? null;

  const nodes: Node<FlowNodeData>[] = [
    {
      id: "redis",
      type: "redis",
      position: { x: 24, y: 40 },
      data: {
        kind: "redis",
        title: "Redis Streams",
        subtitle: health?.streamKey
          ? `route-change fan-out · ${health.streamKey}`
          : "route-change fan-out",
        badge: "redis",
        flashing: redisFlash
      },
      draggable: false,
      selectable: false,
      zIndex: 2
    },
    {
      id: "api",
      type: "api",
      position: { x: 24, y: 200 },
      data: {
        kind: "api",
        title: "API + RouteCache",
        subtitle: health ? `API instance ${health.instanceId}` : "waiting for API",
        badge: health?.cache || "sqlite",
        highlighted: Boolean(selected),
        flashing: redisFlash
      },
      draggable: false,
      selectable: false,
      zIndex: 2
    }
  ];

  topology.shards.forEach((entry, index) => {
    const activeTenants = entry.tenants.filter((tenant) => tenant.status !== "disabled");
    const shardDrafts = drafts.filter((draft) => draft.shardId === entry.shard.id);
    const chipCount = activeTenants.length + shardDrafts.length;
    const height = Math.max(
      shardMinHeight,
      chipCount === 0
        ? shardMinHeight
        : chipTopInset + (chipCount - 1) * chipStep + chipHeight + shardBottomPad
    );
    const shardX = 320 + index * (shardWidth + 40);
    const shardY = 36;

    nodes.push({
      id: `shard-${entry.shard.id}`,
      type: "shard",
      position: { x: shardX, y: shardY },
      data: {
        kind: "shard",
        title: entry.shard.id,
        subtitle: entry.shard.name || entry.shard.region || "PostgreSQL shard",
        badge: "postgres",
        loadScore: entry.shard.loadScore,
        tenantCount: activeTenants.length + shardDrafts.length,
        highlighted: selectedShardId === entry.shard.id
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

  const edges: Edge[] = topology.shards.map((entry) => ({
    id: `api-${entry.shard.id}`,
    source: "api",
    target: `shard-${entry.shard.id}`,
    animated: selectedShardId === entry.shard.id,
    style: {
      stroke: selectedShardId === entry.shard.id ? "#59a8ff" : "#3a4a5c",
      strokeWidth: selectedShardId === entry.shard.id ? 2.5 : 1.5
    }
  }));

  edges.push({
    id: "redis-api",
    source: "redis",
    target: "api",
    animated: redisFlash,
    style: {
      stroke: redisFlash ? "#f0b429" : "#4a5563",
      strokeWidth: redisFlash ? 2.5 : 1.25,
      strokeDasharray: "5 4"
    }
  });

  return { nodes, edges };
}


function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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
    shardCount: numberValue(payload.shardCount)
  };
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
      loadScore: optionalNumber(shard.loadScore)
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
    const message =
      isRecord(payload) && typeof payload.message === "string"
        ? payload.message
        : isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : `Request failed (${response.status})`;
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
