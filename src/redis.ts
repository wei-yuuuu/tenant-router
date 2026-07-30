import { createClient } from "redis";

import type {
  RouteEvent,
  RouteEventBus,
  RouteEventHandler,
  TenantRoute,
  Unsubscribe
} from "./index.ts";

type RedisClient = ReturnType<typeof createClient>;

export interface RedisRouteEventsOptions {
  url?: string;
  client?: RedisClient;
  streamKey?: string;
  startId?: string;
  blockMs?: number;
  readCount?: number;
}

export function createRedisRouteEvents(
  options: RedisRouteEventsOptions
): RedisRouteEvents {
  return new RedisRouteEvents(options);
}

export class RedisRouteEvents implements RouteEventBus {
  private readonly publisher: RedisClient;
  private readonly subscriber: RedisClient;
  private readonly ownsPublisher: boolean;
  private readonly streamKey: string;
  private readonly blockMs: number;
  private readonly readCount: number;
  private nextId: string;
  private readonly handlers = new Set<RouteEventHandler>();
  private subscriberReady?: Promise<void>;
  private consumerTask?: Promise<void>;
  private closing = false;

  constructor(options: RedisRouteEventsOptions) {
    if (!options || typeof options !== "object") {
      throw new Error("Redis route events options must be an object.");
    }

    if (options.client) {
      this.publisher = options.client;
      this.ownsPublisher = false;
    } else {
      if (!options.url) {
        throw new Error("Redis route events requires a url or client.");
      }

      this.publisher = createClient({ url: options.url });
      this.ownsPublisher = true;
    }

    this.subscriber = this.publisher.duplicate();
    this.streamKey = options.streamKey ?? "tenant-router:route-events";
    this.nextId = options.startId ?? "0-0";
    this.blockMs = options.blockMs ?? 5_000;
    this.readCount = options.readCount ?? 100;

    if (!Number.isFinite(this.blockMs) || this.blockMs <= 0) {
      throw new Error("Redis route events blockMs must be positive.");
    }

    if (!Number.isInteger(this.readCount) || this.readCount <= 0) {
      throw new Error("Redis route events readCount must be a positive integer.");
    }
  }

  async publish(event: RouteEvent): Promise<void> {
    await this.ensureConnected(this.publisher);
    await this.publisher.xAdd(this.streamKey, "*", {
      event: JSON.stringify(event)
    });
  }

  async subscribe(handler: RouteEventHandler): Promise<Unsubscribe> {
    this.handlers.add(handler);
    await this.startSubscriber();

    return async () => {
      this.handlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.closing = true;
    this.handlers.clear();

    if (this.consumerTask) {
      await this.consumerTask;
    }

    if (this.subscriber.isOpen) {
      await this.subscriber.quit();
    }

    if (this.ownsPublisher && this.publisher.isOpen) {
      await this.publisher.quit();
    }
  }

  private async startSubscriber(): Promise<void> {
    if (!this.subscriberReady) {
      this.subscriberReady = this.initializeSubscriber();
    }

    await this.subscriberReady;
  }

  private async initializeSubscriber(): Promise<void> {
    await this.ensureConnected(this.subscriber);
    this.consumerTask = this.consume();
  }

  private async consume(): Promise<void> {
    while (!this.closing) {
      const result = await this.subscriber.xRead(
        [{ key: this.streamKey, id: this.nextId }],
        { BLOCK: this.blockMs, COUNT: this.readCount }
      );

      if (!result) {
        continue;
      }

      for (const stream of result) {
        for (const message of stream.messages) {
          this.nextId = message.id;
          await this.dispatch(message.message.event);
        }
      }
    }
  }

  private async dispatch(payload: string): Promise<void> {
    const event = parseRouteEvent(payload);
    if (!event) {
      return;
    }

    await Promise.all([...this.handlers].map((handler) => handler(event)));
  }

  private async ensureConnected(client: RedisClient): Promise<void> {
    if (!client.isOpen) {
      await client.connect();
    }
  }
}

function parseRouteEvent(payload: string): RouteEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return null;
  }

  const event: RouteEvent = { type: parsed.type };
  if (typeof parsed.eventId === "string") event.eventId = parsed.eventId;
  if (typeof parsed.tenantId === "string") event.tenantId = parsed.tenantId;
  if (typeof parsed.shardId === "string") event.shardId = parsed.shardId;
  if (typeof parsed.routeVersion === "number") {
    event.routeVersion = parsed.routeVersion;
  }
  if (
    typeof parsed.occurredAt === "string" ||
    typeof parsed.occurredAt === "number"
  ) {
    event.occurredAt = parsed.occurredAt;
  }
  if (isTenantRoute(parsed.route)) event.route = parsed.route;
  if (isRecord(parsed.metadata)) event.metadata = parsed.metadata;
  return event;
}

function isTenantRoute(value: unknown): value is TenantRoute {
  return (
    isRecord(value) &&
    typeof value.tenantId === "string" &&
    typeof value.shardId === "string" &&
    typeof value.routeVersion === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
