/**
 * EntityOps.watch() Tests
 *
 * Tests for real-time entity change notifications via pub/sub.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { BunHAL } from '@src/hal/index.js';
import { createDatabase } from '@src/ems/database.js';
import { ModelCache } from '@src/ems/model-cache.js';
import { EntityOps, type EntityRecord, type WatchEvent } from '@src/ems/entity-ops.js';
import { createObserverRunner } from '@src/ems/observers/registry.js';
import type { DatabaseConnection } from '@src/hal/connection.js';
import { loadVfsSchema } from '../helpers/test-os.js';

// =============================================================================
// TEST SETUP
// =============================================================================

let hal: BunHAL;
let db: DatabaseConnection;
let cache: ModelCache;
let entityOps: EntityOps;

beforeEach(async () => {
    hal = new BunHAL();
    await hal.init();
    db = await createDatabase(hal.channel, hal.file);
    await loadVfsSchema(db, hal);
    cache = new ModelCache(db);
    const runner = createObserverRunner();

    entityOps = new EntityOps(hal, db, cache, runner);
});

afterEach(async () => {
    await db.close();
    await hal.shutdown();
});

// =============================================================================
// HELPER TYPES
// =============================================================================

interface FileRecord extends EntityRecord {
    pathname: string;
    owner: string;
}

// =============================================================================
// TESTS
// =============================================================================

describe('EntityOps.watch()', () => {
    it('should receive create events', async () => {
        const events: WatchEvent<FileRecord>[] = [];
        let watchResolved = false;

        // Start watching in background
        const watchPromise = (async () => {
            for await (const event of entityOps.watch<FileRecord>('file')) {
                events.push(event);
                // Stop after first event
                break;
            }

            watchResolved = true;
        })();

        // Give watcher time to subscribe
        await new Promise(resolve => setTimeout(resolve, 50));

        // Create a file
        await entityOps.createOne<FileRecord>('file', {
            pathname: 'test-create.txt',
            owner: 'test-user',
        });

        // Wait for watch to receive event
        await watchPromise;

        expect(watchResolved).toBe(true);
        expect(events).toHaveLength(1);
        expect(events[0]!.op).toBe('create');
        expect(events[0]!.entity.pathname).toBe('test-create.txt');
        expect(events[0]!.entity.owner).toBe('test-user');
    });

    it('should receive update events', async () => {
        // Create a file first
        const created = await entityOps.createOne<FileRecord>('file', {
            pathname: 'test-update.txt',
            owner: 'original-owner',
        });

        const events: WatchEvent<FileRecord>[] = [];

        // Start watching in background
        const watchPromise = (async () => {
            for await (const event of entityOps.watch<FileRecord>('file')) {
                events.push(event);
                // Stop after first event (skip create, get update)
                if (event.op === 'update') {
                    break;
                }
            }
        })();

        // Give watcher time to subscribe
        await new Promise(resolve => setTimeout(resolve, 50));

        // Update the file
        await entityOps.updateOne<FileRecord>('file', created.id, {
            owner: 'new-owner',
        });

        // Wait for watch to receive event
        await watchPromise;

        const updateEvent = events.find(e => e.op === 'update');

        expect(updateEvent).toBeDefined();
        expect(updateEvent!.entity.owner).toBe('new-owner');
        expect(updateEvent!.changes).toBeDefined();
        expect(updateEvent!.changes!.owner).toBe('new-owner');
    });

    it('should receive delete events', async () => {
        // Create a file first
        const created = await entityOps.createOne<FileRecord>('file', {
            pathname: 'test-delete.txt',
            owner: 'test-owner',
        });

        const events: WatchEvent<FileRecord>[] = [];

        // Start watching in background
        const watchPromise = (async () => {
            for await (const event of entityOps.watch<FileRecord>('file')) {
                events.push(event);
                // Stop after delete event
                if (event.op === 'delete') {
                    break;
                }
            }
        })();

        // Give watcher time to subscribe
        await new Promise(resolve => setTimeout(resolve, 50));

        // Delete the file
        await entityOps.deleteOne<FileRecord>('file', created.id);

        // Wait for watch to receive event
        await watchPromise;

        const deleteEvent = events.find(e => e.op === 'delete');

        expect(deleteEvent).toBeDefined();
        expect(deleteEvent!.entity.id).toBe(created.id);
    });

    it('should filter events by where clause', async () => {
        const events: WatchEvent<FileRecord>[] = [];
        let eventCount = 0;

        // Start watching with filter
        const watchPromise = (async () => {
            for await (const event of entityOps.watch<FileRecord>('file', {
                where: { owner: 'target-owner' },
            })) {
                events.push(event);
                eventCount++;
                // Stop after 2 events (should only match the filtered ones)
                if (eventCount >= 2) {
                    break;
                }
            }
        })();

        // Give watcher time to subscribe
        await new Promise(resolve => setTimeout(resolve, 50));

        // Create files with different owners
        await entityOps.createOne<FileRecord>('file', {
            pathname: 'other.txt',
            owner: 'other-owner',
        });
        await entityOps.createOne<FileRecord>('file', {
            pathname: 'target1.txt',
            owner: 'target-owner',
        });
        await entityOps.createOne<FileRecord>('file', {
            pathname: 'another.txt',
            owner: 'another-owner',
        });
        await entityOps.createOne<FileRecord>('file', {
            pathname: 'target2.txt',
            owner: 'target-owner',
        });

        // Wait for watch to receive events
        await watchPromise;

        // Should only have events for target-owner files
        expect(events).toHaveLength(2);
        expect(events.every(e => e.entity.owner === 'target-owner')).toBe(true);
        expect(events.map(e => e.entity.pathname)).toContain('target1.txt');
        expect(events.map(e => e.entity.pathname)).toContain('target2.txt');
    });

    it('should handle multiple concurrent watchers', async () => {
        const events1: WatchEvent<FileRecord>[] = [];
        const events2: WatchEvent<FileRecord>[] = [];

        // Start two watchers
        const watch1 = (async () => {
            for await (const event of entityOps.watch<FileRecord>('file')) {
                events1.push(event);
                if (events1.length >= 2) {
                    break;
                }
            }
        })();

        const watch2 = (async () => {
            for await (const event of entityOps.watch<FileRecord>('file')) {
                events2.push(event);
                if (events2.length >= 2) {
                    break;
                }
            }
        })();

        // Give watchers time to subscribe
        await new Promise(resolve => setTimeout(resolve, 50));

        // Create two files
        await entityOps.createOne<FileRecord>('file', {
            pathname: 'multi1.txt',
            owner: 'owner1',
        });
        await entityOps.createOne<FileRecord>('file', {
            pathname: 'multi2.txt',
            owner: 'owner2',
        });

        // Wait for both watchers
        await Promise.all([watch1, watch2]);

        // Both watchers should receive both events
        expect(events1).toHaveLength(2);
        expect(events2).toHaveLength(2);
    });
});

describe('PubsubNotify observer', () => {
    it('should publish to correct topic format', async () => {
        // Subscribe directly to check topic format
        const subscription = await hal.redis.subscribe(['entity.file.*']);
        const messages: Array<{ topic: string; payload: unknown }> = [];

        const collectPromise = (async () => {
            for await (const msg of subscription.messages()) {
                messages.push(msg);
                if (messages.length >= 1) {
                    break;
                }
            }
        })();

        // Give subscriber time
        await new Promise(resolve => setTimeout(resolve, 50));

        // Create triggers publish
        await entityOps.createOne<FileRecord>('file', {
            pathname: 'topic-test.txt',
            owner: 'test',
        });

        await collectPromise;
        await subscription.close();

        expect(messages).toHaveLength(1);
        expect(messages[0]!.topic).toBe('entity.file.create');
    });

    it('should include entity data in payload', async () => {
        const subscription = await hal.redis.subscribe(['entity.file.create']);
        let payload: Record<string, unknown> | null = null;

        const collectPromise = (async () => {
            for await (const msg of subscription.messages()) {
                payload = msg.payload as Record<string, unknown>;
                break;
            }
        })();

        await new Promise(resolve => setTimeout(resolve, 50));

        const created = await entityOps.createOne<FileRecord>('file', {
            pathname: 'payload-test.txt',
            owner: 'payload-owner',
        });

        await collectPromise;
        await subscription.close();

        expect(payload).not.toBeNull();
        expect(payload!.id).toBe(created.id);
        expect(payload!.model).toBe('file');
        expect(payload!.operation).toBe('create');
        expect(payload!.data).toBeDefined();
        expect((payload!.data as Record<string, unknown>).pathname).toBe('payload-test.txt');
        expect(payload!.timestamp).toBeDefined();
    });
});
