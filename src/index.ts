export type TenantTier = "free" | "pro" | "enterprise" | (string & {});
export type RouteVersion = number;
export type RouteCacheSource = "cache" | "store";

export interface TenantRoute<TMetadata = Record<string, unknown>> {
  tenantId: string;
  shardId: string;
  routeVersion: RouteVersion;
  tier?: TenantTier;
  status?: "active" | "moving" | "disabled" | (string & {});
  reason?: string;
  updatedAt?: Date | string | number;
  metadata?: TMetadata;
}

export interface ShardDefinition<TMetadata = Record<string, unknown>> {
  id: string;
  name?: string;
  status?: "active" | "draining" | "disabled" | (string & {});
  region?: string;
  capacity?: number;
  loadScore?: number;
  metadata?: TMetadata;
}

export type RouteEventType =
  | "tenant.created"
  | "tenant.assigned"
  | "tenant.moved"
  | "tenant.tier_changed"
  | "tenant.disabled"
  | "shard.provisioned"
  | "route.cache_invalidated"
  | (string & {});

export interface RouteEvent<TMetadata = Record<string, unknown>> {
  type: RouteEventType;
  tenantId?: string;
  shardId?: string;
  routeVersion?: RouteVersion;
  route?: TenantRoute;
  occurredAt?: Date | string | number;
  metadata?: TMetadata;
}

export type Unsubscribe = () => void | Promise<void>;
export type RouteEventHandler = (event: RouteEvent) => void | Promise<void>;

export interface RouteStore<TRoute extends TenantRoute = TenantRoute> {
  getTenantRoute(tenantId: string): Promise<TRoute | null> | TRoute | null;
  listTenantRoutes?(): Promise<TRoute[]> | TRoute[];
}

export interface RouteEventBus {
  subscribe(
    handler: RouteEventHandler
  ): Promise<Unsubscribe> | Unsubscribe;
  publish?(event: RouteEvent): Promise<void> | void;
}

export interface RouteEventPublisher {
  publish(event: RouteEvent): Promise<void> | void;
}

export interface TenantRouteRegistry<TRoute extends TenantRoute = TenantRoute>
  extends RouteStore<TRoute>
{
  setTenantRoute(route: TRoute): Promise<void> | void;
  deleteTenantRoute?(tenantId: string): Promise<void> | void;
}

export interface ShardRegistry {
  setShard(shard: ShardDefinition): Promise<void> | void;
  getShard?(shardId: string): Promise<ShardDefinition | null> | ShardDefinition | null;
}

export interface RouteCache<TRoute extends TenantRoute = TenantRoute> {
  get(tenantId: string): Promise<TRoute | null> | TRoute | null;
  set(route: TRoute): Promise<void> | void;
  delete(tenantId: string): Promise<void> | void;
  clear?(): Promise<void> | void;
}

export interface MemoryRouteCacheOptions {
  ttlMs?: number;
}

export interface TenantShardRouterConfig<
  TRoute extends TenantRoute = TenantRoute
> {
  routeStore: RouteStore<TRoute>;
  events?: RouteEventBus;
  cache?: RouteCache<TRoute> | MemoryRouteCacheOptions;
}

export interface ResolveRouteOptions {
  bypassCache?: boolean;
}

export interface ExplainRouteResult<TRoute extends TenantRoute = TenantRoute> {
  tenantId: string;
  route: TRoute | null;
  source: RouteCacheSource | "none";
  cacheHit: boolean;
  routeVersion: RouteVersion | null;
}

export interface MemoryRouteStoreOptions<
  TRoute extends TenantRoute = TenantRoute
> {
  routes?: TRoute[];
  shards?: ShardDefinition[];
}

export interface TenantRouteCommandsConfig<
  TRoute extends TenantRoute = TenantRoute
> {
  routeRegistry: TenantRouteRegistry<TRoute>;
  shardRegistry: ShardRegistry;
  events: RouteEventPublisher;
  now?: () => Date;
}

export interface AssignTenantToShardInput<
  TMetadata = Record<string, unknown>
> {
  tenantId: string;
  shardId: string;
  tier?: TenantTier;
  reason?: string;
  metadata?: TMetadata;
}

export interface ChangeTenantTierInput {
  tenantId: string;
  tier: TenantTier;
  reason?: string;
}

export interface DisableTenantInput {
  tenantId: string;
  reason?: string;
}

export class TenantRouteNotFoundError extends Error {
  tenantId: string;

  constructor(tenantId: string) {
    super(`No tenant route found for "${tenantId}".`);
    this.name = "TenantRouteNotFoundError";
    this.tenantId = tenantId;
  }
}

export function createTenantRouter<
  TRoute extends TenantRoute = TenantRoute
>(config: TenantShardRouterConfig<TRoute>): TenantShardRouter<TRoute> {
  return new TenantShardRouter(config);
}

export function createTenantRouteCommands<
  TRoute extends TenantRoute = TenantRoute
>(config: TenantRouteCommandsConfig<TRoute>): TenantRouteCommands<TRoute> {
  return new TenantRouteCommands(config);
}

export class TenantShardRouter<TRoute extends TenantRoute = TenantRoute> {
  private readonly routeStore: RouteStore<TRoute>;
  private readonly cache: RouteCache<TRoute>;
  private readonly events?: RouteEventBus;
  private readonly unsubscribeReady?: Promise<Unsubscribe>;
  private unsubscribe?: Unsubscribe;

  constructor(config: TenantShardRouterConfig<TRoute>) {
    if (!config || typeof config !== "object") {
      throw new TenantRouterError(
        "INVALID_CONFIG",
        "Tenant router config must be an object."
      );
    }

    if (!config.routeStore) {
      throw new TenantRouterError(
        "INVALID_ROUTE_STORE",
        "Tenant router config requires a routeStore."
      );
    }

    this.routeStore = config.routeStore;
    this.cache = isRouteCache(config.cache)
      ? config.cache
      : createMemoryRouteCache(config.cache);
    this.events = config.events;

    if (this.events) {
      this.unsubscribeReady = Promise.resolve(
        this.events.subscribe((event) => this.handleRouteEvent(event))
      ).then((unsubscribe) => {
        this.unsubscribe = unsubscribe;
        return unsubscribe;
      });
    }
  }

  async resolve(
    tenantId: string,
    options: ResolveRouteOptions = {}
  ): Promise<TRoute> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const route = await this.findRoute(normalizedTenantId, options);

    if (!route) {
      throw new TenantRouteNotFoundError(normalizedTenantId);
    }

    return route;
  }

  async getRoute(
    tenantId: string,
    options: ResolveRouteOptions = {}
  ): Promise<TRoute | null> {
    return this.findRoute(normalizeTenantId(tenantId), options);
  }

  async explain(
    tenantId: string,
    options: ResolveRouteOptions = {}
  ): Promise<ExplainRouteResult<TRoute>> {
    const normalizedTenantId = normalizeTenantId(tenantId);

    if (!options.bypassCache) {
      const cached = await this.cache.get(normalizedTenantId);
      if (cached) {
        return {
          tenantId: normalizedTenantId,
          route: cached,
          source: "cache",
          cacheHit: true,
          routeVersion: cached.routeVersion
        };
      }
    }

    const route = await this.routeStore.getTenantRoute(normalizedTenantId);
    if (route) {
      await this.cache.set(route);
      return {
        tenantId: normalizedTenantId,
        route,
        source: "store",
        cacheHit: false,
        routeVersion: route.routeVersion
      };
    }

    return {
      tenantId: normalizedTenantId,
      route: null,
      source: "none",
      cacheHit: false,
      routeVersion: null
    };
  }

  async invalidate(tenantId: string): Promise<void> {
    await this.cache.delete(normalizeTenantId(tenantId));
  }

  async close(): Promise<void> {
    const unsubscribe = this.unsubscribe ?? (await this.unsubscribeReady);
    if (unsubscribe) {
      await unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  private async findRoute(
    tenantId: string,
    options: ResolveRouteOptions
  ): Promise<TRoute | null> {
    if (!options.bypassCache) {
      const cached = await this.cache.get(tenantId);
      if (cached) {
        return cached;
      }
    }

    const route = await this.routeStore.getTenantRoute(tenantId);
    if (route) {
      await this.cache.set(route);
    }

    return route;
  }

  private async handleRouteEvent(event: RouteEvent): Promise<void> {
    const tenantId = event.tenantId ?? event.route?.tenantId;
    if (!tenantId) {
      return;
    }

    if (event.route) {
      await this.cache.set(event.route as TRoute);
      return;
    }

    await this.cache.delete(tenantId);
  }
}

export class TenantRouteCommands<TRoute extends TenantRoute = TenantRoute> {
  private readonly routeRegistry: TenantRouteRegistry<TRoute>;
  private readonly shardRegistry: ShardRegistry;
  private readonly events: RouteEventPublisher;
  private readonly now: () => Date;

  constructor(config: TenantRouteCommandsConfig<TRoute>) {
    if (!config || typeof config !== "object") {
      throw new TenantRouterError(
        "INVALID_COMMAND_CONFIG",
        "Tenant route commands config must be an object."
      );
    }

    if (!config.routeRegistry || !config.shardRegistry || !config.events) {
      throw new TenantRouterError(
        "INVALID_COMMAND_CONFIG",
        "Tenant route commands require routeRegistry, shardRegistry, and events."
      );
    }

    this.routeRegistry = config.routeRegistry;
    this.shardRegistry = config.shardRegistry;
    this.events = config.events;
    this.now = config.now ?? (() => new Date());
  }

  async createTenant(
    input: AssignTenantToShardInput
  ): Promise<TRoute> {
    const tenantId = normalizeTenantId(input.tenantId);
    const existing = await this.routeRegistry.getTenantRoute(tenantId);
    if (existing) {
      throw new TenantRouterError(
        "TENANT_ROUTE_ALREADY_EXISTS",
        `Tenant route already exists for "${tenantId}".`
      );
    }

    return this.writeRoute("tenant.created", input, undefined);
  }

  async assignTenantToShard(
    input: AssignTenantToShardInput
  ): Promise<TRoute> {
    return this.writeRoute(
      "tenant.assigned",
      input,
      await this.routeRegistry.getTenantRoute(normalizeTenantId(input.tenantId))
    );
  }

  async moveTenantToShard(
    input: AssignTenantToShardInput
  ): Promise<TRoute> {
    const existing = await this.requireRoute(input.tenantId);
    return this.writeRoute("tenant.moved", input, existing);
  }

  async changeTenantTier(input: ChangeTenantTierInput): Promise<TRoute> {
    const existing = await this.requireRoute(input.tenantId);
    const route = {
      ...existing,
      tier: input.tier,
      reason: input.reason ?? existing.reason,
      routeVersion: existing.routeVersion + 1,
      updatedAt: this.now()
    } as TRoute;

    return this.persistAndPublish("tenant.tier_changed", route);
  }

  async disableTenant(input: DisableTenantInput): Promise<TRoute> {
    const existing = await this.requireRoute(input.tenantId);
    const route = {
      ...existing,
      status: "disabled",
      reason: input.reason ?? existing.reason,
      routeVersion: existing.routeVersion + 1,
      updatedAt: this.now()
    } as TRoute;

    return this.persistAndPublish("tenant.disabled", route);
  }

  async provisionShard(shard: ShardDefinition): Promise<ShardDefinition> {
    if (!shard || typeof shard !== "object" || !String(shard.id ?? "").trim()) {
      throw new TenantRouterError(
        "INVALID_SHARD",
        "Shard must have a non-empty id."
      );
    }

    await this.shardRegistry.setShard(shard);
    await this.events.publish({
      type: "shard.provisioned",
      shardId: shard.id,
      occurredAt: this.now()
    });
    return shard;
  }

  private async requireRoute(tenantId: string): Promise<TRoute> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const route = await this.routeRegistry.getTenantRoute(normalizedTenantId);
    if (!route) {
      throw new TenantRouteNotFoundError(normalizedTenantId);
    }

    return route;
  }

  private async writeRoute(
    type: Extract<RouteEventType, string>,
    input: AssignTenantToShardInput,
    previous: TRoute | null | undefined
  ): Promise<TRoute> {
    const shardId = normalizeShardId(input.shardId);
    const route = {
      tenantId: normalizeTenantId(input.tenantId),
      shardId,
      routeVersion: (previous?.routeVersion ?? 0) + 1,
      tier: input.tier ?? previous?.tier,
      status: "active",
      reason: input.reason ?? previous?.reason,
      metadata: input.metadata ?? previous?.metadata,
      updatedAt: this.now()
    } as TRoute;

    return this.persistAndPublish(type, route);
  }

  private async persistAndPublish(
    type: RouteEventType,
    route: TRoute
  ): Promise<TRoute> {
    await this.routeRegistry.setTenantRoute(route);
    await this.events.publish({
      type,
      tenantId: route.tenantId,
      shardId: route.shardId,
      routeVersion: route.routeVersion,
      route,
      occurredAt: this.now()
    });
    return route;
  }
}

export function createMemoryRouteStore<
  TRoute extends TenantRoute = TenantRoute
>(options: MemoryRouteStoreOptions<TRoute> = {}): MemoryRouteStore<TRoute> {
  return new MemoryRouteStore(options);
}

export class MemoryRouteStore<TRoute extends TenantRoute = TenantRoute>
  implements TenantRouteRegistry<TRoute>, ShardRegistry
{
  private readonly routes = new Map<string, TRoute>();
  private readonly shards = new Map<string, ShardDefinition>();

  constructor(options: MemoryRouteStoreOptions<TRoute> = {}) {
    for (const route of options.routes ?? []) {
      this.setTenantRoute(route);
    }

    for (const shard of options.shards ?? []) {
      this.setShard(shard);
    }
  }

  getTenantRoute(tenantId: string): TRoute | null {
    return this.routes.get(normalizeTenantId(tenantId)) ?? null;
  }

  listTenantRoutes(): TRoute[] {
    return [...this.routes.values()];
  }

  setTenantRoute(route: TRoute): void {
    this.routes.set(normalizeTenantId(route.tenantId), route);
  }

  deleteTenantRoute(tenantId: string): void {
    this.routes.delete(normalizeTenantId(tenantId));
  }

  setShard(shard: ShardDefinition): void {
    this.shards.set(shard.id, shard);
  }

  getShard(shardId: string): ShardDefinition | null {
    return this.shards.get(shardId) ?? null;
  }

  listShards(): ShardDefinition[] {
    return [...this.shards.values()];
  }
}

export function createMemoryRouteCache<
  TRoute extends TenantRoute = TenantRoute
>(options: MemoryRouteCacheOptions = {}): MemoryRouteCache<TRoute> {
  return new MemoryRouteCache(options);
}

export class MemoryRouteCache<TRoute extends TenantRoute = TenantRoute>
  implements RouteCache<TRoute>
{
  private readonly ttlMs?: number;
  private readonly entries = new Map<
    string,
    { route: TRoute; expiresAt: number | null }
  >();

  constructor(options: MemoryRouteCacheOptions = {}) {
    this.ttlMs = options.ttlMs;
  }

  get(tenantId: string): TRoute | null {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const entry = this.entries.get(normalizedTenantId);

    if (!entry) {
      return null;
    }

    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.entries.delete(normalizedTenantId);
      return null;
    }

    return entry.route;
  }

  set(route: TRoute): void {
    this.entries.set(normalizeTenantId(route.tenantId), {
      route,
      expiresAt: this.ttlMs === undefined ? null : Date.now() + this.ttlMs
    });
  }

  delete(tenantId: string): void {
    this.entries.delete(normalizeTenantId(tenantId));
  }

  clear(): void {
    this.entries.clear();
  }
}

export function createMemoryRouteEvents(): MemoryRouteEvents {
  return new MemoryRouteEvents();
}

export class MemoryRouteEvents implements RouteEventBus {
  private readonly handlers = new Set<RouteEventHandler>();

  subscribe(handler: RouteEventHandler): Unsubscribe {
    this.handlers.add(handler);

    return () => {
      this.handlers.delete(handler);
    };
  }

  async publish(event: RouteEvent): Promise<void> {
    await Promise.all([...this.handlers].map((handler) => handler(event)));
  }
}

function normalizeTenantId(tenantId: string): string {
  const normalizedTenantId = String(tenantId ?? "").trim();
  if (!normalizedTenantId) {
    throw new TenantRouterError(
      "INVALID_TENANT_ID",
      "Tenant id must be a non-empty string."
    );
  }

  return normalizedTenantId;
}

function normalizeShardId(shardId: string): string {
  const normalizedShardId = String(shardId ?? "").trim();
  if (!normalizedShardId) {
    throw new TenantRouterError(
      "INVALID_SHARD_ID",
      "Shard id must be a non-empty string."
    );
  }

  return normalizedShardId;
}

function isRouteCache<TRoute extends TenantRoute>(
  cache: RouteCache<TRoute> | MemoryRouteCacheOptions | undefined
): cache is RouteCache<TRoute> {
  return (
    !!cache &&
    typeof (cache as RouteCache<TRoute>).get === "function" &&
    typeof (cache as RouteCache<TRoute>).set === "function" &&
    typeof (cache as RouteCache<TRoute>).delete === "function"
  );
}

export type MatchSource = "header" | "host" | "path" | "fallback" | "none";

export interface TenantDefinition<TMetadata = Record<string, unknown>> {
  id: string;
  name?: string;
  enabled?: boolean;
  domains?: string | string[];
  subdomains?: string | string[];
  pathPrefixes?: string | string[];
  headers?: Record<string, string | string[]>;
  match?: {
    domains?: string | string[];
    subdomains?: string | string[];
    pathPrefixes?: string | string[];
    headers?: Record<string, string | string[]>;
  };
  metadata?: TMetadata;
  [key: string]: unknown;
}

export interface TenantMatcherConfig<
  TTenant extends TenantDefinition = TenantDefinition
> {
  tenants: TTenant[];
  baseDomain?: string;
  fallbackTenantId?: string;
}

export interface HeadersLike {
  get(name: string): string | number | null | undefined;
}

export interface TenantRequestInput {
  url?: string | URL;
  host?: string;
  hostname?: string;
  path?: string;
  pathname?: string;
  headers?:
    | HeadersLike
    | Record<string, string | string[] | number | null | undefined>
    | Iterable<[string, string]>;
}

export interface MatchTenantOptions {
  includeCandidates?: boolean;
}

export interface TenantCandidate<
  TTenant extends TenantDefinition = TenantDefinition
> {
  tenantId: string;
  tenant: TTenant;
  source: Exclude<MatchSource, "fallback" | "none">;
  value?: string;
  pattern?: string;
}

export interface TenantResolution<
  TTenant extends TenantDefinition = TenantDefinition
> {
  matched: boolean;
  tenant: TTenant | null;
  tenantId: string | null;
  source: MatchSource;
  value?: string;
  pattern?: string;
  candidates?: TenantCandidate<TTenant>[];
}

interface NormalizedConfig<TTenant extends TenantDefinition>
  extends TenantMatcherConfig<TTenant> {
  baseDomain: string;
  fallbackTenantId?: string;
  tenants: TTenant[];
}

interface NormalizedRequest {
  url: URL | null;
  host: string;
  path: string;
  headers: HeaderReader;
}

interface HeaderReader {
  get(name: string): string;
}

type HeaderSource =
  | HeadersLike
  | Record<string, string | string[] | number | null | undefined>
  | Iterable<[string, string]>;

type MatchableSource = Exclude<MatchSource, "fallback" | "none">;

interface BaseRule<TTenant extends TenantDefinition> {
  tenant: TTenant;
  tenantIndex: number;
  source: MatchableSource;
  pattern: string;
  score: number;
}

interface HeaderRule<TTenant extends TenantDefinition>
  extends BaseRule<TTenant> {
  source: "header";
  headerName: string;
  headerValue: string;
}

interface ExactHostRule<TTenant extends TenantDefinition>
  extends BaseRule<TTenant> {
  source: "host";
  kind: "exact";
  host: string;
}

interface WildcardHostRule<TTenant extends TenantDefinition>
  extends BaseRule<TTenant> {
  source: "host";
  kind: "wildcard";
  host: string;
  suffix: string;
}

type HostRule<TTenant extends TenantDefinition> =
  | ExactHostRule<TTenant>
  | WildcardHostRule<TTenant>;

interface PathRule<TTenant extends TenantDefinition> extends BaseRule<TTenant> {
  source: "path";
  prefix: string;
}

type TenantRule<TTenant extends TenantDefinition> =
  | HeaderRule<TTenant>
  | HostRule<TTenant>
  | PathRule<TTenant>;

interface CompiledRules<TTenant extends TenantDefinition> {
  headers: HeaderRule<TTenant>[];
  hosts: HostRule<TTenant>[];
  paths: PathRule<TTenant>[];
}

type InternalCandidate<TTenant extends TenantDefinition> = TenantRule<TTenant> & {
  value: string;
};

const MATCH_SOURCES = Object.freeze({
  HEADER: "header",
  HOST: "host",
  PATH: "path",
  FALLBACK: "fallback",
  NONE: "none"
} satisfies Record<string, MatchSource>);

const SOURCE_SCORE = Object.freeze({
  header: 4000,
  host: 3000,
  path: 2000
});

export class TenantRouterError extends Error {
  code: string;
  details?: unknown;

  constructor(code: string, message: string, details: unknown = undefined) {
    super(message);
    this.name = "TenantRouterError";
    this.code = code;
    this.details = details;
  }
}

export function createTenantMatcher<
  TTenant extends TenantDefinition = TenantDefinition
>(config: TenantMatcherConfig<TTenant>): TenantMatcher<TTenant> {
  return new TenantMatcher(config);
}

export function matchTenant<
  TTenant extends TenantDefinition = TenantDefinition
>(
  input: string | URL | TenantRequestInput,
  config: TenantMatcherConfig<TTenant>,
  options: MatchTenantOptions = {}
): TenantResolution<TTenant> {
  return createTenantMatcher(config).resolve(input, options);
}

export class TenantMatcher<TTenant extends TenantDefinition = TenantDefinition> {
  readonly config: NormalizedConfig<TTenant>;
  readonly tenants: TTenant[];

  private readonly tenantMap: Map<string, TTenant>;
  private readonly rules: CompiledRules<TTenant>;

  constructor(config: TenantMatcherConfig<TTenant>) {
    this.config = normalizeConfig(config);
    this.tenants = this.config.tenants;
    this.tenantMap = new Map();

    for (const tenant of this.tenants) {
      this.tenantMap.set(tenant.id, tenant);
    }

    this.rules = compileRules(this.config);
  }

  resolve(
    input: string | URL | TenantRequestInput,
    options: MatchTenantOptions = {}
  ): TenantResolution<TTenant> {
    const request = normalizeInput(input);
    const candidates: InternalCandidate<TTenant>[] = [];

    collectHeaderCandidates(candidates, this.rules.headers, request.headers);
    collectHostCandidates(candidates, this.rules.hosts, request.host);
    collectPathCandidates(candidates, this.rules.paths, request.path);

    candidates.sort(compareCandidates);

    if (candidates.length > 0) {
      const winner = candidates[0];
      return buildResolution({
        matched: true,
        tenant: winner.tenant,
        source: winner.source,
        value: winner.value,
        pattern: winner.pattern,
        candidates,
        includeCandidates: options.includeCandidates === true
      });
    }

    const fallback = this.config.fallbackTenantId
      ? this.tenantMap.get(this.config.fallbackTenantId)
      : null;

    if (fallback) {
      return buildResolution({
        matched: false,
        tenant: fallback,
        source: MATCH_SOURCES.FALLBACK,
        value: undefined,
        pattern: undefined,
        candidates,
        includeCandidates: options.includeCandidates === true
      });
    }

    return {
      matched: false,
      tenant: null,
      tenantId: null,
      source: MATCH_SOURCES.NONE,
      value: undefined,
      pattern: undefined,
      candidates: options.includeCandidates === true ? [] : undefined
    };
  }

  getTenant(id: string): TTenant | null {
    return this.tenantMap.get(String(id)) ?? null;
  }

  listTenants(): TTenant[] {
    return [...this.tenants];
  }
}

function normalizeConfig<TTenant extends TenantDefinition>(
  config: TenantMatcherConfig<TTenant>
): NormalizedConfig<TTenant> {
  if (!config || typeof config !== "object") {
    throw new TenantRouterError(
      "INVALID_CONFIG",
      "Tenant router config must be an object."
    );
  }

  if (!Array.isArray(config.tenants)) {
    throw new TenantRouterError(
      "INVALID_TENANTS",
      "Tenant router config requires a tenants array."
    );
  }

  const seen = new Set<string>();
  const tenants = config.tenants.map((tenant, index) => {
    if (!tenant || typeof tenant !== "object") {
      throw new TenantRouterError(
        "INVALID_TENANT",
        `Tenant at index ${index} must be an object.`
      );
    }

    const id = String(tenant.id ?? "").trim();
    if (!id) {
      throw new TenantRouterError(
        "INVALID_TENANT_ID",
        `Tenant at index ${index} requires a non-empty id.`
      );
    }

    if (seen.has(id)) {
      throw new TenantRouterError(
        "DUPLICATE_TENANT_ID",
        `Tenant id "${id}" is configured more than once.`,
        { tenantId: id }
      );
    }
    seen.add(id);

    return {
      ...tenant,
      id,
      enabled: tenant.enabled !== false
    } as TTenant;
  });

  const fallbackTenantId =
    config.fallbackTenantId === undefined || config.fallbackTenantId === null
      ? undefined
      : String(config.fallbackTenantId);

  if (fallbackTenantId && !seen.has(fallbackTenantId)) {
    throw new TenantRouterError(
      "UNKNOWN_FALLBACK_TENANT",
      `Fallback tenant "${fallbackTenantId}" is not configured.`,
      { tenantId: fallbackTenantId }
    );
  }

  return {
    baseDomain: normalizeHost(config.baseDomain),
    fallbackTenantId,
    tenants
  };
}

function compileRules<TTenant extends TenantDefinition>(
  config: NormalizedConfig<TTenant>
): CompiledRules<TTenant> {
  const headers: HeaderRule<TTenant>[] = [];
  const hosts: HostRule<TTenant>[] = [];
  const paths: PathRule<TTenant>[] = [];

  config.tenants.forEach((tenant, tenantIndex) => {
    if (!tenant.enabled) {
      return;
    }

    compileHeaderRules(headers, tenant, tenantIndex);
    compileHostRules(hosts, tenant, tenantIndex, config.baseDomain);
    compilePathRules(paths, tenant, tenantIndex);
  });

  return { headers, hosts, paths };
}

function compileHeaderRules<TTenant extends TenantDefinition>(
  rules: HeaderRule<TTenant>[],
  tenant: TTenant,
  tenantIndex: number
): void {
  const headers = tenant.headers ?? tenant.match?.headers;
  if (!headers || typeof headers !== "object") {
    return;
  }

  for (const [name, expected] of Object.entries(headers)) {
    const normalizedName = String(name).trim().toLowerCase();
    if (!normalizedName) {
      continue;
    }

    for (const value of asArray(expected)) {
      const normalizedValue = String(value).trim().toLowerCase();
      if (!normalizedValue) {
        continue;
      }

      rules.push({
        tenant,
        tenantIndex,
        source: MATCH_SOURCES.HEADER,
        headerName: normalizedName,
        headerValue: normalizedValue,
        pattern: `${normalizedName}: ${normalizedValue}`,
        score: SOURCE_SCORE.header + normalizedName.length + normalizedValue.length
      });
    }
  }
}

function compileHostRules<TTenant extends TenantDefinition>(
  rules: HostRule<TTenant>[],
  tenant: TTenant,
  tenantIndex: number,
  baseDomain: string
): void {
  const rawDomains = [
    ...asArray(tenant.domains ?? tenant.match?.domains),
    ...subdomainsToDomains(tenant.subdomains ?? tenant.match?.subdomains, baseDomain)
  ];
  const seen = new Set<string>();

  for (const rawDomain of rawDomains) {
    const domain = normalizeHost(rawDomain);
    if (!domain || seen.has(domain)) {
      continue;
    }
    seen.add(domain);

    if (domain.startsWith("*.")) {
      const suffix = domain.slice(1);
      rules.push({
        tenant,
        tenantIndex,
        source: MATCH_SOURCES.HOST,
        kind: "wildcard",
        host: domain,
        suffix,
        pattern: domain,
        score: SOURCE_SCORE.host + 100 + suffix.length
      });
      continue;
    }

    rules.push({
      tenant,
      tenantIndex,
      source: MATCH_SOURCES.HOST,
      kind: "exact",
      host: domain,
      pattern: domain,
      score: SOURCE_SCORE.host + 500 + domain.length
    });
  }
}

function compilePathRules<TTenant extends TenantDefinition>(
  rules: PathRule<TTenant>[],
  tenant: TTenant,
  tenantIndex: number
): void {
  const prefixes = tenant.pathPrefixes ?? tenant.match?.pathPrefixes;

  for (const rawPrefix of asArray(prefixes)) {
    const prefix = normalizePath(rawPrefix);
    if (!prefix) {
      continue;
    }

    rules.push({
      tenant,
      tenantIndex,
      source: MATCH_SOURCES.PATH,
      prefix,
      pattern: prefix,
      score: SOURCE_SCORE.path + prefix.length
    });
  }
}

function collectHeaderCandidates<TTenant extends TenantDefinition>(
  candidates: InternalCandidate<TTenant>[],
  rules: HeaderRule<TTenant>[],
  headers: HeaderReader
): void {
  if (!headers || rules.length === 0) {
    return;
  }

  for (const rule of rules) {
    const actual = headers.get(rule.headerName);
    if (!actual) {
      continue;
    }

    const values = splitHeaderValues(actual);
    if (values.includes(rule.headerValue)) {
      candidates.push({
        ...rule,
        value: actual
      });
    }
  }
}

function collectHostCandidates<TTenant extends TenantDefinition>(
  candidates: InternalCandidate<TTenant>[],
  rules: HostRule<TTenant>[],
  host: string
): void {
  if (!host || rules.length === 0) {
    return;
  }

  for (const rule of rules) {
    if (rule.kind === "exact" && host === rule.host) {
      candidates.push({
        ...rule,
        value: host
      });
      continue;
    }

    if (
      rule.kind === "wildcard" &&
      host.endsWith(rule.suffix) &&
      host.length > rule.suffix.length
    ) {
      candidates.push({
        ...rule,
        value: host
      });
    }
  }
}

function collectPathCandidates<TTenant extends TenantDefinition>(
  candidates: InternalCandidate<TTenant>[],
  rules: PathRule<TTenant>[],
  path: string
): void {
  if (!path || rules.length === 0) {
    return;
  }

  for (const rule of rules) {
    if (pathMatchesPrefix(path, rule.prefix)) {
      candidates.push({
        ...rule,
        value: path
      });
    }
  }
}

function buildResolution<TTenant extends TenantDefinition>({
  matched,
  tenant,
  source,
  value,
  pattern,
  candidates,
  includeCandidates
}: {
  matched: boolean;
  tenant: TTenant;
  source: MatchSource;
  value?: string;
  pattern?: string;
  candidates: InternalCandidate<TTenant>[];
  includeCandidates: boolean;
}): TenantResolution<TTenant> {
  return {
    matched,
    tenant,
    tenantId: tenant.id,
    source,
    value,
    pattern,
    candidates: includeCandidates ? candidates.map(toPublicCandidate) : undefined
  };
}

function toPublicCandidate<TTenant extends TenantDefinition>(
  candidate: InternalCandidate<TTenant>
): TenantCandidate<TTenant> {
  return {
    tenantId: candidate.tenant.id,
    tenant: candidate.tenant,
    source: candidate.source,
    value: candidate.value,
    pattern: candidate.pattern
  };
}

function compareCandidates<TTenant extends TenantDefinition>(
  a: InternalCandidate<TTenant>,
  b: InternalCandidate<TTenant>
): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }

  return a.tenantIndex - b.tenantIndex;
}

function normalizeInput(input: string | URL | TenantRequestInput): NormalizedRequest {
  if (input instanceof URL) {
    return {
      url: input,
      host: normalizeHost(input.host),
      path: normalizePath(input.pathname),
      headers: createHeaderReader()
    };
  }

  if (typeof input === "string") {
    return normalizeStringInput(input);
  }

  if (!input || typeof input !== "object") {
    throw new TenantRouterError(
      "INVALID_INPUT",
      "Tenant router input must be a string, URL, or request-like object."
    );
  }

  const headers = createHeaderReader(input.headers);
  const host =
    normalizeHost(input.host) ||
    normalizeHost(headers.get("host")) ||
    normalizeHost(input.hostname);
  const url = parseUrl(input.url, host);
  const path = normalizePath(input.path ?? input.pathname ?? url?.pathname);

  return {
    url,
    host: normalizeHost(url?.host) || host,
    path,
    headers
  };
}

function normalizeStringInput(input: string): NormalizedRequest {
  const value = input.trim();
  const url = parseUrl(value);

  if (url) {
    return {
      url,
      host: normalizeHost(url.host),
      path: normalizePath(url.pathname),
      headers: createHeaderReader()
    };
  }

  if (value.startsWith("/")) {
    return {
      url: null,
      host: "",
      path: normalizePath(value),
      headers: createHeaderReader()
    };
  }

  return {
    url: null,
    host: normalizeHost(value),
    path: "/",
    headers: createHeaderReader()
  };
}

function parseUrl(value: string | URL | undefined, host: string | undefined = undefined): URL | null {
  if (value instanceof URL) {
    return value;
  }

  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    if (!host) {
      return null;
    }
  }

  try {
    const path = value.startsWith("/") ? value : `/${value}`;
    return new URL(path, `http://${host}`);
  } catch {
    return null;
  }
}

function createHeaderReader(headers: HeaderSource | undefined = undefined): HeaderReader {
  if (!headers) {
    return {
      get() {
        return "";
      }
    };
  }

  if (isHeadersLike(headers)) {
    return {
      get(name: string) {
        const value = headers.get(name);
        return value === null || value === undefined ? "" : String(value);
      }
    };
  }

  const map = new Map<string, string>();

  if (isHeaderIterable(headers)) {
    for (const [name, value] of headers) {
      map.set(String(name).toLowerCase(), normalizeHeaderValue(value));
    }
  } else {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      map.set(String(name).toLowerCase(), normalizeHeaderValue(value));
    }
  }

  return {
    get(name: string) {
      return map.get(String(name).toLowerCase()) ?? "";
    }
  };
}

function isHeadersLike(headers: HeaderSource): headers is HeadersLike {
  return typeof (headers as { get?: unknown }).get === "function";
}

function isHeaderIterable(
  headers: HeaderSource
): headers is Iterable<[string, string]> {
  return (
    typeof (headers as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
      "function" && !Array.isArray(headers)
  );
}

function normalizeHeaderValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(",");
  }

  return value === null || value === undefined ? "" : String(value);
}

function splitHeaderValues(value: string): string[] {
  return String(value)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function subdomainsToDomains(
  subdomains: string | string[] | undefined,
  baseDomain: string
): string[] {
  if (!baseDomain) {
    return [];
  }

  return asArray(subdomains).map((subdomain) => {
    const normalized = String(subdomain).trim().toLowerCase();
    return normalized ? `${normalized}.${baseDomain}` : "";
  });
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function normalizeHost(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  let host = String(value).trim().toLowerCase();
  if (!host) {
    return "";
  }

  if (host.startsWith("http://") || host.startsWith("https://")) {
    try {
      host = new URL(host).host;
    } catch {
      return "";
    }
  }

  if (host.startsWith("[") && host.includes("]")) {
    const end = host.indexOf("]");
    return host.slice(0, end + 1);
  }

  host = host.split("/")[0];
  host = host.replace(/:\d+$/, "");
  host = host.replace(/\.$/, "");

  return host;
}

function normalizePath(value: unknown): string {
  if (value === undefined || value === null) {
    return "/";
  }

  let path = String(value).trim();
  if (!path) {
    return "/";
  }

  if (path.startsWith("http://") || path.startsWith("https://")) {
    try {
      path = new URL(path).pathname;
    } catch {
      return "/";
    }
  }

  path = path.split("?")[0].split("#")[0];

  if (!path.startsWith("/")) {
    path = `/${path}`;
  }

  if (path.length > 1) {
    path = path.replace(/\/+$/, "");
  }

  return path || "/";
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  if (prefix === "/") {
    return true;
  }

  return path === prefix || path.startsWith(`${prefix}/`);
}
