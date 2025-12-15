# HAL Redis Device - Cache + Pub/Sub with Memory Fallback

## Status: Draft
## Author: Claude + Ian
## Date: December 2024

---

## 1. Motivation

Currently, pub/sub in Monk OS is:
- In-memory only (`PubsubPort` in kernel/resource)
- Single-process (messages don't cross node boundaries)
- Not usable for watch() notifications across distributed deployments

We want:
- **Memory backend** for dev/testing/single-node
- **Redis backend** for production/multi-node
- **Same kernel API** regardless of backend
- **watch() built on pub/sub** instead of Postgres LISTEN/NOTIFY

This decouples "where data lives" (SQLite/Postgres) from "how events propagate" (memory/Redis).

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Userspace                                                   │
│                                                              │
│  port:open({ type: 'pubsub', topics: ['event.*'] })         │
│  port:send(portId, 'event.chat', { text: 'hello' })         │
│  for await (msg of port:recv(portId)) { ... }               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Kernel - PubsubPort                                         │
│                                                              │
│  Delegates to HAL.pubsub                                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  HAL - PubsubDevice                                          │
│                                                              │
│  ┌─────────────────┐    ┌─────────────────┐                 │
│  │ MemoryPubsub    │ OR │ RedisPubsub     │                 │
│  │ (default)       │    │ (if configured) │                 │
│  └─────────────────┘    └─────────────────┘                 │
└─────────────────────────────────────────────────────────────┘
                                    │
                                    ▼ (if Redis)
                          ┌─────────────────┐
                          │  Redis Server   │
                          │  (external)     │
                          └─────────────────┘
```

---

## 3. HAL Interface

### 3.1 RedisDevice - Combined Interface

```typescript
// src/hal/redis.ts

/**
 * HAL device for Redis-like operations.
 *
 * Provides cache (key-value) and pub/sub functionality.
 * Memory implementation for dev/single-node, Redis for production.
 */
interface RedisDevice {
    // =========================================================================
    // CACHE - Key/Value Operations
    // =========================================================================

    /**
     * Get a value by key.
     * @returns Value or null if not found/expired
     */
    get(key: string): Promise<string | null>;

    /**
     * Set a value with optional TTL.
     * @param key - Key to set
     * @param value - Value to store
     * @param opts - Options: ex (seconds), px (milliseconds)
     */
    set(key: string, value: string, opts?: { ex?: number; px?: number }): Promise<void>;

    /**
     * Delete one or more keys.
     * @returns Number of keys deleted
     */
    del(...keys: string[]): Promise<number>;

    /**
     * Check if key exists.
     */
    exists(key: string): Promise<boolean>;

    /**
     * Set TTL on existing key (seconds).
     * @returns true if timeout was set, false if key doesn't exist
     */
    expire(key: string, seconds: number): Promise<boolean>;

    /**
     * Get remaining TTL (seconds).
     * @returns TTL in seconds, -1 if no TTL, -2 if key doesn't exist
     */
    ttl(key: string): Promise<number>;

    /**
     * Increment integer value.
     * Creates key with value 1 if doesn't exist.
     */
    incr(key: string): Promise<number>;

    /**
     * Increment by specific amount.
     */
    incrby(key: string, increment: number): Promise<number>;

    /**
     * Decrement integer value.
     */
    decr(key: string): Promise<number>;

    /**
     * Get multiple keys at once.
     * @returns Array of values (null for missing keys)
     */
    mget(...keys: string[]): Promise<(string | null)[]>;

    /**
     * Set multiple keys at once.
     * @param entries - Key-value pairs
     */
    mset(entries: Record<string, string>): Promise<void>;

    /**
     * Set if not exists.
     * @returns true if key was set, false if already existed
     */
    setnx(key: string, value: string): Promise<boolean>;

    // =========================================================================
    // PUBSUB - Messaging Operations
    // =========================================================================

    /**
     * Subscribe to topic patterns.
     */
    subscribe(patterns: string[]): Promise<PubsubSubscription>;

    /**
     * Publish message to topic.
     * @returns Number of subscribers that received the message
     */
    publish(topic: string, payload: unknown): Promise<number>;

    /**
     * Get subscriber count for a pattern.
     */
    subscriberCount(pattern: string): Promise<number>;

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Shutdown device, close connections.
     */
    shutdown(): Promise<void>;
}
```

### 3.2 PubsubSubscription Interface

```typescript
// src/hal/pubsub.ts

/**
 * Message received from a subscription.
 */
interface PubsubMessage {
    /** The topic/channel the message was published to */
    topic: string;

    /** The message payload (already deserialized) */
    payload: unknown;

    /** Pattern that matched this topic (for wildcard subscriptions) */
    pattern: string;
}

/**
 * Subscription handle for managing a pub/sub subscription.
 */
interface PubsubSubscription {
    /** Unique subscription ID */
    readonly id: string;

    /** Patterns this subscription is listening to */
    readonly patterns: readonly string[];

    /** Async iterator of incoming messages */
    messages(): AsyncIterable<PubsubMessage>;

    /** Unsubscribe and clean up */
    close(): Promise<void>;
}

/**
 * HAL device for pub/sub messaging.
 *
 * Supports glob-style pattern matching:
 * - `*` matches one level (e.g., `event.*` matches `event.chat` but not `event.chat.room`)
 * - `**` matches any levels (e.g., `event.**` matches `event.chat.room.123`)
 */
interface PubsubDevice {
    /**
     * Create a subscription to one or more topic patterns.
     *
     * @param patterns - Topic patterns to subscribe to
     * @returns Subscription handle
     */
    subscribe(patterns: string[]): Promise<PubsubSubscription>;

    /**
     * Publish a message to a topic.
     *
     * @param topic - Exact topic to publish to (no wildcards)
     * @param payload - Message payload (will be serialized)
     * @returns Number of subscribers that received the message
     */
    publish(topic: string, payload: unknown): Promise<number>;

    /**
     * Get subscription count for a topic pattern.
     * Useful for debugging/monitoring.
     */
    subscriberCount(pattern: string): Promise<number>;

    /**
     * Shutdown the device, closing all subscriptions.
     */
    shutdown(): Promise<void>;
}
```

### 3.3 HAL Configuration

```typescript
// In HALConfig
interface HALConfig {
    // ... existing config ...

    redis?: {
        /**
         * Backend type.
         * - 'memory': In-process cache + pub/sub (default)
         * - 'redis': External Redis server
         */
        type: 'memory' | 'redis';

        /**
         * Redis connection URL (required if type: 'redis')
         * Format: redis://[[username:]password@]host[:port][/database]
         */
        url?: string;

        /**
         * Key prefix for all operations.
         * Useful for multi-tenant or namespacing.
         * Default: 'monk:'
         */
        prefix?: string;

        /**
         * Default TTL for cache entries (seconds).
         * 0 = no expiration.
         * Default: 0
         */
        defaultTTL?: number;
    };
}
```

---

## 4. Memory Implementation

Default implementation for single-node/development:

```typescript
// src/hal/redis/memory.ts

class MemoryRedis implements RedisDevice {
    // =========================================================================
    // CACHE STATE
    // =========================================================================

    /** Key-value store */
    private cache = new Map<string, string>();

    /** TTL timers */
    private timers = new Map<string, Timer>();

    /** Expiration times (ms timestamp) */
    private expires = new Map<string, number>();

    // =========================================================================
    // PUBSUB STATE
    // =========================================================================

    /** Map of pattern -> Set of subscription IDs */
    private subscriptions = new Map<string, Set<string>>();

    /** Map of subscription ID -> subscription state */
    private state = new Map<string, {
        patterns: string[];
        queue: PubsubMessage[];
        waiters: Array<(msg: PubsubMessage) => void>;
        closed: boolean;
    }>();

    // =========================================================================
    // CACHE METHODS
    // =========================================================================

    async get(key: string): Promise<string | null> {
        // Check expiration
        const expireTime = this.expires.get(key);
        if (expireTime && Date.now() > expireTime) {
            this.del(key);
            return null;
        }
        return this.cache.get(key) ?? null;
    }

    async set(key: string, value: string, opts?: { ex?: number; px?: number }): Promise<void> {
        this.cache.set(key, value);

        // Clear existing timer
        const existingTimer = this.timers.get(key);
        if (existingTimer) clearTimeout(existingTimer);

        // Set TTL if specified
        const ttlMs = opts?.px ?? (opts?.ex ? opts.ex * 1000 : 0);
        if (ttlMs > 0) {
            this.expires.set(key, Date.now() + ttlMs);
            this.timers.set(key, setTimeout(() => this.del(key), ttlMs));
        } else {
            this.expires.delete(key);
            this.timers.delete(key);
        }
    }

    async del(...keys: string[]): Promise<number> {
        let count = 0;
        for (const key of keys) {
            if (this.cache.has(key)) {
                this.cache.delete(key);
                this.expires.delete(key);
                const timer = this.timers.get(key);
                if (timer) clearTimeout(timer);
                this.timers.delete(key);
                count++;
            }
        }
        return count;
    }

    async exists(key: string): Promise<boolean> {
        return (await this.get(key)) !== null;
    }

    async expire(key: string, seconds: number): Promise<boolean> {
        if (!this.cache.has(key)) return false;

        const ttlMs = seconds * 1000;
        this.expires.set(key, Date.now() + ttlMs);

        const existingTimer = this.timers.get(key);
        if (existingTimer) clearTimeout(existingTimer);

        this.timers.set(key, setTimeout(() => this.del(key), ttlMs));
        return true;
    }

    async ttl(key: string): Promise<number> {
        if (!this.cache.has(key)) return -2;
        const expireTime = this.expires.get(key);
        if (!expireTime) return -1;
        return Math.max(0, Math.ceil((expireTime - Date.now()) / 1000));
    }

    async incr(key: string): Promise<number> {
        return this.incrby(key, 1);
    }

    async incrby(key: string, increment: number): Promise<number> {
        const current = await this.get(key);
        const value = (current ? parseInt(current, 10) : 0) + increment;
        await this.set(key, value.toString());
        return value;
    }

    async decr(key: string): Promise<number> {
        return this.incrby(key, -1);
    }

    async mget(...keys: string[]): Promise<(string | null)[]> {
        return Promise.all(keys.map(k => this.get(k)));
    }

    async mset(entries: Record<string, string>): Promise<void> {
        for (const [key, value] of Object.entries(entries)) {
            await this.set(key, value);
        }
    }

    async setnx(key: string, value: string): Promise<boolean> {
        if (await this.exists(key)) return false;
        await this.set(key, value);
        return true;
    }

    // =========================================================================
    // PUBSUB METHODS
    // =========================================================================

    async subscribe(patterns: string[]): Promise<PubsubSubscription> {
        const id = crypto.randomUUID();
        const state = {
            patterns,
            queue: [] as PubsubMessage[],
            waiters: [] as Array<(msg: PubsubMessage) => void>,
            closed: false,
        };

        this.state.set(id, state);

        for (const pattern of patterns) {
            if (!this.subscriptions.has(pattern)) {
                this.subscriptions.set(pattern, new Set());
            }
            this.subscriptions.get(pattern)!.add(id);
        }

        return {
            id,
            patterns,
            messages: () => this.iterate(id),
            close: () => this.unsubscribe(id),
        };
    }

    async publish(topic: string, payload: unknown): Promise<number> {
        let count = 0;

        for (const [pattern, subIds] of this.subscriptions) {
            if (this.matches(pattern, topic)) {
                for (const subId of subIds) {
                    const state = this.state.get(subId);
                    if (state && !state.closed) {
                        const msg = { topic, payload, pattern };

                        // If someone is waiting, deliver directly
                        const waiter = state.waiters.shift();
                        if (waiter) {
                            waiter(msg);
                        } else {
                            state.queue.push(msg);
                        }
                        count++;
                    }
                }
            }
        }

        return count;
    }

    private async *iterate(id: string): AsyncIterable<PubsubMessage> {
        const state = this.state.get(id);
        if (!state) return;

        while (!state.closed) {
            // Drain queue first
            if (state.queue.length > 0) {
                yield state.queue.shift()!;
                continue;
            }

            // Wait for next message
            const msg = await new Promise<PubsubMessage | null>((resolve) => {
                if (state.closed) {
                    resolve(null);
                    return;
                }
                state.waiters.push(resolve as (msg: PubsubMessage) => void);
            });

            if (msg === null) break;
            yield msg;
        }
    }

    private async unsubscribe(id: string): Promise<void> {
        const state = this.state.get(id);
        if (!state) return;

        state.closed = true;

        // Wake up any waiters
        for (const waiter of state.waiters) {
            waiter(null as any);
        }

        // Remove from pattern maps
        for (const pattern of state.patterns) {
            this.subscriptions.get(pattern)?.delete(id);
        }

        this.state.delete(id);
    }

    private matches(pattern: string, topic: string): boolean {
        // Convert glob pattern to regex
        // event.* -> event\.[^.]+
        // event.** -> event\..*
        const regex = pattern
            .replace(/\./g, '\\.')
            .replace(/\*\*/g, '.*')
            .replace(/\*/g, '[^.]+');

        return new RegExp(`^${regex}$`).test(topic);
    }

    async subscriberCount(pattern: string): Promise<number> {
        return this.subscriptions.get(pattern)?.size ?? 0;
    }

    async shutdown(): Promise<void> {
        for (const id of this.state.keys()) {
            await this.unsubscribe(id);
        }
    }
}
```

---

## 5. Redis Implementation

Production implementation for multi-node:

```typescript
// src/hal/redis/redis.ts

/**
 * Redis-backed cache + pub/sub implementation.
 *
 * Uses native Redis commands for cache operations.
 * Uses native Redis PSUBSCRIBE for pattern matching.
 * Each subscription gets its own Redis connection (Redis requirement).
 */
class RedisBackend implements RedisDevice {
    private readonly url: string;
    private readonly prefix: string;

    /** Shared connection for cache + PUBLISH commands */
    private conn: RedisConnection | null = null;

    /** Active subscriptions (each needs own connection) */
    private subscriptions = new Map<string, {
        conn: RedisConnection;
        patterns: string[];
        closed: boolean;
    }>();

    constructor(config: { url: string; prefix?: string }) {
        this.url = config.url;
        this.prefix = config.prefix ?? 'monk:';
    }

    private key(k: string): string {
        return `${this.prefix}${k}`;
    }

    private async getConn(): Promise<RedisConnection> {
        if (!this.conn) {
            this.conn = await this.connect();
        }
        return this.conn;
    }

    // =========================================================================
    // CACHE METHODS
    // =========================================================================

    async get(key: string): Promise<string | null> {
        const conn = await this.getConn();
        return conn.get(this.key(key));
    }

    async set(key: string, value: string, opts?: { ex?: number; px?: number }): Promise<void> {
        const conn = await this.getConn();
        if (opts?.ex) {
            await conn.setex(this.key(key), opts.ex, value);
        } else if (opts?.px) {
            await conn.psetex(this.key(key), opts.px, value);
        } else {
            await conn.set(this.key(key), value);
        }
    }

    async del(...keys: string[]): Promise<number> {
        const conn = await this.getConn();
        return conn.del(...keys.map(k => this.key(k)));
    }

    async exists(key: string): Promise<boolean> {
        const conn = await this.getConn();
        return (await conn.exists(this.key(key))) === 1;
    }

    async expire(key: string, seconds: number): Promise<boolean> {
        const conn = await this.getConn();
        return (await conn.expire(this.key(key), seconds)) === 1;
    }

    async ttl(key: string): Promise<number> {
        const conn = await this.getConn();
        return conn.ttl(this.key(key));
    }

    async incr(key: string): Promise<number> {
        const conn = await this.getConn();
        return conn.incr(this.key(key));
    }

    async incrby(key: string, increment: number): Promise<number> {
        const conn = await this.getConn();
        return conn.incrby(this.key(key), increment);
    }

    async decr(key: string): Promise<number> {
        const conn = await this.getConn();
        return conn.decr(this.key(key));
    }

    async mget(...keys: string[]): Promise<(string | null)[]> {
        const conn = await this.getConn();
        return conn.mget(...keys.map(k => this.key(k)));
    }

    async mset(entries: Record<string, string>): Promise<void> {
        const conn = await this.getConn();
        const prefixed: Record<string, string> = {};
        for (const [k, v] of Object.entries(entries)) {
            prefixed[this.key(k)] = v;
        }
        await conn.mset(prefixed);
    }

    async setnx(key: string, value: string): Promise<boolean> {
        const conn = await this.getConn();
        return (await conn.setnx(this.key(key), value)) === 1;
    }

    // =========================================================================
    // PUBSUB METHODS
    // =========================================================================

    async subscribe(patterns: string[]): Promise<PubsubSubscription> {
        const id = crypto.randomUUID();

        // Each subscription needs its own connection
        // (Redis enters subscriber mode and can't do other commands)
        const conn = await this.connect();

        const prefixedPatterns = patterns.map(p => `${this.prefix}${p}`);
        await conn.psubscribe(...prefixedPatterns);

        const state = { conn, patterns, closed: false };
        this.subscriptions.set(id, state);

        return {
            id,
            patterns,
            messages: () => this.iterate(id, prefixedPatterns),
            close: () => this.unsubscribe(id),
        };
    }

    async publish(topic: string, payload: unknown): Promise<number> {
        if (!this.publishConn) {
            this.publishConn = await this.connect();
        }

        const prefixedTopic = `${this.prefix}${topic}`;
        const message = JSON.stringify(payload);

        return this.publishConn.publish(prefixedTopic, message);
    }

    private async *iterate(
        id: string,
        prefixedPatterns: string[]
    ): AsyncIterable<PubsubMessage> {
        const state = this.subscriptions.get(id);
        if (!state) return;

        // Redis client provides async iterator for messages
        for await (const [channel, message] of state.conn.messages()) {
            if (state.closed) break;

            // Strip prefix from topic
            const topic = channel.startsWith(this.prefix)
                ? channel.slice(this.prefix.length)
                : channel;

            // Find which pattern matched
            const pattern = prefixedPatterns.find(p =>
                this.redisPatternMatches(p, channel)
            ) ?? channel;

            yield {
                topic,
                payload: JSON.parse(message),
                pattern: pattern.startsWith(this.prefix)
                    ? pattern.slice(this.prefix.length)
                    : pattern,
            };
        }
    }

    private async unsubscribe(id: string): Promise<void> {
        const state = this.subscriptions.get(id);
        if (!state) return;

        state.closed = true;
        await state.conn.punsubscribe();
        await state.conn.quit();

        this.subscriptions.delete(id);
    }

    private redisPatternMatches(pattern: string, channel: string): boolean {
        // Redis uses * for single-level and doesn't have **
        // Our ** gets converted to * for Redis, so we need to recheck
        // This is a simplification - real impl would track original patterns
        return true; // Redis already filtered for us
    }

    private async connect(): Promise<RedisConnection> {
        // Use Bun's native Redis support or a client library
        // This is a placeholder for the actual connection logic
        throw new Error('TODO: Implement Redis connection');
    }

    async subscriberCount(pattern: string): Promise<number> {
        if (!this.publishConn) {
            this.publishConn = await this.connect();
        }

        const result = await this.publishConn.pubsubNumsub(`${this.prefix}${pattern}`);
        return result[1] ?? 0;
    }

    async shutdown(): Promise<void> {
        for (const id of this.subscriptions.keys()) {
            await this.unsubscribe(id);
        }

        if (this.publishConn) {
            await this.publishConn.quit();
            this.publishConn = null;
        }
    }
}
```

---

## 6. Kernel Integration

### 6.1 PubsubPort Changes

```typescript
// src/kernel/resource/pubsub-port.ts

/**
 * PubsubPort - Kernel port backed by HAL PubsubDevice.
 *
 * CHANGE: Delegates to HAL instead of maintaining its own subscriptions.
 */
class PubsubPort implements Port {
    readonly id: string;
    readonly type = 'pubsub';

    private subscription: PubsubSubscription | null = null;
    private closed = false;

    constructor(
        private readonly hal: HAL,
        private readonly patterns: string[],
    ) {
        this.id = hal.entropy.uuid();
    }

    async init(): Promise<void> {
        this.subscription = await this.hal.redis.subscribe(this.patterns);
    }

    async *recv(): AsyncIterable<PortMessage> {
        if (!this.subscription) {
            throw new EBADF('Port not initialized');
        }

        for await (const msg of this.subscription.messages()) {
            yield {
                from: msg.topic,
                data: msg.payload,
                meta: { pattern: msg.pattern },
            };
        }
    }

    async send(topic: string, data: unknown): Promise<void> {
        await this.hal.redis.publish(topic, data);
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;

        await this.subscription?.close();
        this.subscription = null;
    }
}
```

### 6.2 Syscall Changes

No changes needed - existing syscalls work:

```typescript
// port:open already supports pubsub type
case 'pubsub':
    const port = new PubsubPort(hal, opts.topics);
    await port.init();
    return port;
```

---

## 7. EMS Integration - watch()

With HAL pubsub in place, watch() becomes simple:

### 7.1 Observer Publishes Changes

```typescript
// src/ems/ring/5/99-pubsub-notify.ts

/**
 * Ring 5 observer that publishes entity changes to pub/sub.
 * Runs after SQL persistence, before cache invalidation.
 */
class PubsubNotifyObserver extends Observer {
    readonly ring = 5;
    readonly priority = 99; // After SQL writes

    constructor(private readonly hal: HAL) {
        super();
    }

    async *onCreate(batch: EntityBatch): AsyncIterable<EntityBatch> {
        yield batch;

        // Publish after yielding (non-blocking)
        for (const entity of batch.entities) {
            await this.hal.redis.publish(`entity.${batch.model}.create`, {
                id: entity.id,
                model: batch.model,
                data: entity,
            });
        }
    }

    async *onUpdate(batch: EntityBatch): AsyncIterable<EntityBatch> {
        yield batch;

        for (const entity of batch.entities) {
            await this.hal.redis.publish(`entity.${batch.model}.update`, {
                id: entity.id,
                model: batch.model,
                data: entity,
            });
        }
    }

    async *onDelete(batch: EntityBatch): AsyncIterable<EntityBatch> {
        yield batch;

        for (const entity of batch.entities) {
            await this.hal.redis.publish(`entity.${batch.model}.delete`, {
                id: entity.id,
                model: batch.model,
            });
        }
    }
}
```

### 7.2 EntityOps.watch()

```typescript
// In EntityOps

async *watch<T extends EntityRecord>(
    model: string,
    filter?: { where?: Partial<T> }
): AsyncIterable<{ op: 'create' | 'update' | 'delete'; entity: T }> {
    // Subscribe to all changes for this model
    const sub = await this.hal.redis.subscribe([`entity.${model}.*`]);

    try {
        for await (const msg of sub.messages()) {
            const event = msg.payload as {
                id: string;
                model: string;
                data?: T;
            };

            // Apply client-side filter
            if (filter?.where) {
                const matches = Object.entries(filter.where).every(
                    ([k, v]) => event.data?.[k as keyof T] === v
                );
                if (!matches) continue;
            }

            // Extract operation from topic
            const op = msg.topic.split('.').pop() as 'create' | 'update' | 'delete';

            yield { op, entity: event.data as T };
        }
    } finally {
        await sub.close();
    }
}
```

### 7.3 Usage

```typescript
// Watch all account changes
for await (const { op, entity } of ems.watch('account')) {
    console.log(`Account ${entity.id} was ${op}d`);
}

// Watch specific connection's events (for SSE)
for await (const { op, entity } of ems.watch('event', {
    where: { connection_id: 'abc-123' }
})) {
    sseStream.send(entity);
}
```

---

## 8. SSE/Gateway Integration

With watch() working, SSE becomes trivial:

```typescript
// In Gateway or HTTP handler

async handleSSE(req: Request, connectionId: string): Promise<Response> {
    const stream = new ReadableStream({
        async start(controller) {
            const encoder = new TextEncoder();

            // Watch for events targeting this connection
            for await (const { entity } of ems.watch('event', {
                where: { connection_id: connectionId }
            })) {
                const data = `data: ${JSON.stringify(entity)}\n\n`;
                controller.enqueue(encoder.encode(data));
            }
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
}

// Userspace pushes to browser by creating an event
await ems.create('event', {
    connection_id: 'abc-123',
    type: 'chat.message',
    payload: { text: 'Hello from server!' },
});
// -> Browser receives it via SSE automatically
```

---

## 9. Implementation Plan

### Phase 1: HAL RedisDevice Interface (1 day)
1. Define `RedisDevice` interface in `src/hal/redis.ts`
2. Define `PubsubSubscription` interface
3. Add `redis` to HAL interface
4. Factory function to create Memory or Redis backend based on config

### Phase 2: Memory Implementation (1-2 days)
1. Implement `MemoryRedis` class with cache operations (get, set, del, expire, etc.)
2. Implement pub/sub operations (subscribe, publish)
3. TTL management with timers
4. Comprehensive tests for all cache operations
5. Tests for pub/sub pattern matching

### Phase 3: Kernel Integration (1 day)
1. Update `PubsubPort` to use `hal.redis`
2. Verify existing pubsub syscalls work
3. Add cache syscalls if needed (`cache:get`, `cache:set`, etc.)
4. Tests

### Phase 4: EMS watch() (1 day)
1. Add `PubsubNotifyObserver` to Ring 5
2. Implement `EntityOps.watch()`
3. Tests

### Phase 5: Redis Backend (2 days)
1. Implement `RedisBackend` class
2. Redis connection management (connection pooling, reconnection)
3. Configuration loading from HAL config
4. Integration tests with real Redis (docker-compose)
5. Verify memory/redis backends are interchangeable

### Phase 6: SSE Integration (1 day)
1. Gateway SSE handler using watch()
2. Event model for connection-targeted messages
3. End-to-end test

### Total: ~7-8 days

---

## 10. Cache Use Cases

With `hal.redis` providing cache operations, common patterns become simple:

### Session Storage
```typescript
// Store session with 1-hour TTL
await hal.redis.set(`session:${token}`, JSON.stringify(user), { ex: 3600 });

// Retrieve session
const data = await hal.redis.get(`session:${token}`);
const user = data ? JSON.parse(data) : null;
```

### Rate Limiting
```typescript
async function checkRateLimit(ip: string, limit: number, windowSec: number): Promise<boolean> {
    const key = `ratelimit:${ip}`;
    const count = await hal.redis.incr(key);

    if (count === 1) {
        await hal.redis.expire(key, windowSec);
    }

    return count <= limit;
}
```

### Distributed Locks (simple version)
```typescript
async function acquireLock(name: string, ttlSec: number): Promise<boolean> {
    return hal.redis.setnx(`lock:${name}`, Date.now().toString());
    // Note: For production, use SET with NX and EX options atomically
}

async function releaseLock(name: string): Promise<void> {
    await hal.redis.del(`lock:${name}`);
}
```

### Hot Data Cache
```typescript
async function getUser(id: string): Promise<User> {
    const cached = await hal.redis.get(`user:${id}`);
    if (cached) return JSON.parse(cached);

    const user = await ems.ops.selectOne('user', { where: { id } });
    await hal.redis.set(`user:${id}`, JSON.stringify(user), { ex: 300 }); // 5 min

    return user;
}
```

---

## 11. Open Questions

1. **Pattern syntax**: Use glob (`event.*`, `event.**`) or Redis-native (`event.*`)?
   - Recommendation: Glob, translate to Redis patterns internally

2. **Message serialization**: JSON only, or support MessagePack?
   - Recommendation: JSON for simplicity, can add MessagePack later

3. **Backpressure**: What happens if subscriber is slow?
   - Memory: Queue grows (need max size?)
   - Redis: Messages are fire-and-forget anyway

4. **Pub/sub persistence**: Should events be stored, or fire-and-forget?
   - Recommendation: Fire-and-forget. If you need persistence, write to EMS table and watch() will notify.

5. **Redis library**: Use Bun's built-in Redis support (if available) or ioredis?
   - Needs investigation - Bun may have native Redis in the future

6. **Cache eviction**: Should memory backend have max size / LRU eviction?
   - Recommendation: Yes, add `maxKeys` config option with LRU eviction

7. **Syscalls for cache**: Expose cache operations as syscalls, or HAL-only?
   - Recommendation: HAL-only initially. Add syscalls if userspace needs direct cache access.

---

## 12. Rejected Alternatives

### Postgres LISTEN/NOTIFY
- Pro: No additional dependency
- Con: Only works with Postgres, not SQLite
- Con: More complex notification payload handling
- Con: Connection management complexity

### Separate message queue service
- Pro: More features (persistence, replay, consumer groups)
- Con: Significant complexity
- Con: Another service to manage
- Con: Overkill for event notification use case

### WebSocket-based internal pub/sub
- Pro: Native browser support
- Con: Adds HTTP layer where not needed
- Con: More complex than direct pub/sub
