/**
 * EntityOps Tests
 *
 * Tests for the EntityOps class which provides entity-aware streaming
 * operations with observer pipeline integration.
 *
 * EntityOps builds on DatabaseOps and adds:
 * - Model/field metadata via ModelCache
 * - Observer pipeline via ObserverRunner (Rings 0-8)
 * - Automatic timestamps (created_at, updated_at, trashed_at)
 * - Soft delete / revert / expire semantics
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { BunHAL } from '@src/hal/index.js';
import { createDatabase } from '@src/ems/database.js';
import { ModelCache } from '@src/ems/model-cache.js';
import { EntityOps, collect } from '@src/ems/entity-ops.js';
import { createObserverRunner, ObserverRunner } from '@src/ems/observers/index.js';
import type { DatabaseConnection } from '@src/hal/connection.js';
import { loadVfsSchema } from '../helpers/test-os.js';

// =============================================================================
// TEST SETUP
// =============================================================================

describe('EntityOps', () => {
    let hal: BunHAL;
    let db: DatabaseConnection;
    let cache: ModelCache;
    let runner: ObserverRunner;
    let entityOps: EntityOps;

    beforeEach(async () => {
        hal = new BunHAL();
        await hal.init();
        db = await createDatabase(hal.channel, hal.file);
        await loadVfsSchema(db, hal);
        cache = new ModelCache(db);
        runner = createObserverRunner();
        entityOps = new EntityOps(db, cache, runner);
    });

    afterEach(async () => {
        await db.close();
        await hal.shutdown();
    });

    // =========================================================================
    // CONSTRUCTOR TESTS
    // =========================================================================

    describe('constructor', () => {
        it('should create instance with required dependencies', () => {
            expect(entityOps).toBeInstanceOf(EntityOps);
        });

        it('should expose system context', () => {
            const ctx = entityOps.getSystemContext();

            expect(ctx.db).toBe(db);
            expect(ctx.cache).toBe(cache);
            expect(ctx.runner).toBe(runner);
        });

        it('should expose individual components', () => {
            expect(entityOps.getConnection()).toBe(db);
            expect(entityOps.getCache()).toBe(cache);
            expect(entityOps.getRunner()).toBe(runner);
        });

        it('should expose underlying DatabaseOps', () => {
            const dbOps = entityOps.getDatabaseOps();

            expect(dbOps).toBeDefined();
            expect(dbOps.getConnection()).toBe(db);
        });
    });

    // =========================================================================
    // SELECT OPERATIONS (bypass observer pipeline)
    // =========================================================================

    describe('selectAny', () => {
        it('should stream records matching filter', async () => {
            // Create test records first with unique owner for this test
            const uniqueOwner = `select-user-${Date.now()}`;

            await collect(
                entityOps.createAll('file', [
                    { pathname: 'select-test-1.txt', owner: uniqueOwner },
                    { pathname: 'select-test-2.txt', owner: 'other-user' },
                ]),
            );

            // Select by filter on owner (which is in detail table)
            const files = await collect(
                entityOps.selectAny('file', { where: { owner: uniqueOwner } }),
            );

            expect(files).toHaveLength(1);
            expect(files[0]!.owner).toBe(uniqueOwner);
        });

        it('should apply limit', async () => {
            // Create multiple records with unique owner
            const uniqueOwner = `limit-test-${Date.now()}`;

            await collect(
                entityOps.createAll('file', [
                    { pathname: 'limit-1.txt', owner: uniqueOwner },
                    { pathname: 'limit-2.txt', owner: uniqueOwner },
                    { pathname: 'limit-3.txt', owner: uniqueOwner },
                ]),
            );

            const files = await collect(
                entityOps.selectAny('file', { where: { owner: uniqueOwner }, limit: 2 }),
            );

            expect(files.length).toBeLessThanOrEqual(2);
        });

        it('should exclude trashed records by default', async () => {
            // Create and trash a record with unique owner
            const uniqueOwner = `trash-test-${Date.now()}`;
            const created = await collect(
                entityOps.createAll('file', [{ pathname: 'trashed.txt', owner: uniqueOwner }]),
            );
            const id = created[0]?.id;

            if (id) {
                await collect(entityOps.deleteIds('file', [id]));
            }

            // Select should not include trashed (filter by owner in detail table)
            const files = await collect(
                entityOps.selectAny('file', { where: { owner: uniqueOwner } }),
            );

            expect(files).toHaveLength(0);
        });

        it('should include trashed records when option set', async () => {
            // Create and trash a record with unique owner
            const uniqueOwner = `include-trash-${Date.now()}`;
            const created = await collect(
                entityOps.createAll('file', [{ pathname: 'include-trashed.txt', owner: uniqueOwner }]),
            );
            const id = created[0]?.id;

            if (id) {
                await collect(entityOps.deleteIds('file', [id]));
            }

            // Select with trashed: 'include' (filter by owner in detail table)
            const files = await collect(
                entityOps.selectAny('file', { where: { owner: uniqueOwner } }, { trashed: 'include' }),
            );

            expect(files).toHaveLength(1);
        });
    });

    describe('selectIds', () => {
        it('should stream records by IDs', async () => {
            const created = await collect(
                entityOps.createAll('file', [
                    { pathname: 'by-id-1.txt', owner: 'test' },
                    { pathname: 'by-id-2.txt', owner: 'test' },
                ]),
            );

            const ids = created.map(r => r.id);
            const files = await collect(entityOps.selectIds('file', ids));

            expect(files).toHaveLength(2);
        });

        it('should return empty for empty ID list', async () => {
            const files = await collect(entityOps.selectIds('file', []));

            expect(files).toHaveLength(0);
        });
    });

    // =========================================================================
    // CREATE OPERATIONS (through observer pipeline)
    // =========================================================================

    describe('createAll', () => {
        it('should create records with auto-generated ID', async () => {
            const created = await collect(
                entityOps.createAll('file', [{ pathname: 'auto-id.txt', owner: 'test' }]),
            );

            expect(created).toHaveLength(1);
            expect(created[0]!.id).toBeTruthy();
            expect(created[0]!.id.length).toBe(32); // UUID without dashes
        });

        it('should set created_at and updated_at timestamps', async () => {
            const before = new Date().toISOString();
            const created = await collect(
                entityOps.createAll('file', [{ pathname: 'timestamps.txt', owner: 'test' }]),
            );
            const after = new Date().toISOString();

            const record = created[0]!;

            expect(record.created_at).toBeTruthy();
            expect(record.updated_at).toBeTruthy();
            expect(record.created_at >= before).toBe(true);
            expect(record.created_at <= after).toBe(true);
        });

        it('should persist record to database', async () => {
            const created = await collect(
                entityOps.createAll('file', [{ pathname: 'persist.txt', owner: 'persist-owner' }]),
            );

            // Verify via direct query
            const rows = await db.query<{ pathname: string }>(
                'SELECT pathname FROM entities WHERE id = ?',
                [created[0]!.id],
            );

            expect(rows).toHaveLength(1);
            expect(rows[0]!.pathname).toBe('persist.txt');
        });

        it('should allow providing custom ID', async () => {
            const customId = 'custom12345678901234567890ab';
            const created = await collect(
                entityOps.createAll('file', [{ id: customId, pathname: 'custom-id.txt', owner: 'test' }]),
            );

            expect(created[0]!.id).toBe(customId);
        });

        it('should stream multiple records', async () => {
            const input = [
                { pathname: 'multi-1.txt', owner: 'test' },
                { pathname: 'multi-2.txt', owner: 'test' },
                { pathname: 'multi-3.txt', owner: 'test' },
            ];

            const created = await collect(entityOps.createAll('file', input));

            expect(created).toHaveLength(3);
            expect(new Set(created.map(r => r.id)).size).toBe(3); // All unique IDs
        });
    });

    // =========================================================================
    // UPDATE OPERATIONS (through observer pipeline)
    // =========================================================================

    describe('updateAll', () => {
        it('should update record and return updated version', async () => {
            // Create first
            const created = await collect(
                entityOps.createAll('file', [{ pathname: 'update-me.txt', owner: 'original' }]),
            );

            // Update
            const updated = await collect(
                entityOps.updateAll('file', [{ id: created[0]!.id, changes: { owner: 'changed' } }]),
            );

            expect(updated).toHaveLength(1);
            expect(updated[0]!.owner).toBe('changed');
        });

        it('should update updated_at timestamp', async () => {
            const created = await collect(
                entityOps.createAll('file', [{ pathname: 'ts-update.txt', owner: 'test' }]),
            );

            // Small delay to ensure timestamp differs
            await new Promise(r => setTimeout(r, 10));

            const updated = await collect(
                entityOps.updateAll('file', [{ id: created[0]!.id, changes: { owner: 'new' } }]),
            );

            expect(updated[0]!.updated_at > created[0]!.updated_at).toBe(true);
        });

        it('should throw for non-existent record', async () => {
            const promise = collect(
                entityOps.updateAll('file', [{ id: 'nonexistent12345678901234', changes: { owner: 'x' } }]),
            );

            await expect(promise).rejects.toThrow();
        });
    });

    describe('updateIds', () => {
        it('should update multiple records with same changes', async () => {
            const created = await collect(
                entityOps.createAll('file', [
                    { pathname: 'batch-1.txt', owner: 'old' },
                    { pathname: 'batch-2.txt', owner: 'old' },
                ]),
            );

            const ids = created.map(r => r.id);
            const updated = await collect(entityOps.updateIds('file', ids, { owner: 'new' }));

            expect(updated).toHaveLength(2);
            expect(updated.every(r => r.owner === 'new')).toBe(true);
        });
    });

    // =========================================================================
    // DELETE OPERATIONS - Soft Delete (through observer pipeline)
    // =========================================================================

    describe('deleteAll / deleteIds', () => {
        it('should soft delete by setting trashed_at', async () => {
            const created = await collect(
                entityOps.createAll('file', [{ pathname: 'soft-delete.txt', owner: 'test' }]),
            );

            const deleted = await collect(entityOps.deleteIds('file', [created[0]!.id]));

            expect(deleted).toHaveLength(1);

            // Verify trashed_at is set
            const rows = await db.query<{ trashed_at: string | null }>(
                'SELECT trashed_at FROM file WHERE id = ?',
                [created[0]!.id],
            );

            expect(rows[0]!.trashed_at).toBeTruthy();
        });

        it('should not hard delete the record', async () => {
            const created = await collect(
                entityOps.createAll('file', [{ pathname: 'no-hard-delete.txt', owner: 'test' }]),
            );

            await collect(entityOps.deleteIds('file', [created[0]!.id]));

            // Record should still exist
            const rows = await db.query('SELECT id FROM file WHERE id = ?', [created[0]!.id]);

            expect(rows).toHaveLength(1);
        });

        it('should throw for non-existent record', async () => {
            const promise = collect(entityOps.deleteIds('file', ['nonexistent12345678901234']));

            await expect(promise).rejects.toThrow();
        });
    });

    // =========================================================================
    // REVERT OPERATIONS - Undo Soft Delete (through observer pipeline)
    // =========================================================================

    describe('revertAll', () => {
        it('should clear trashed_at and restore record', async () => {
            // Create and delete
            const created = await collect(
                entityOps.createAll('file', [{ pathname: 'revert-me.txt', owner: 'test' }]),
            );

            await collect(entityOps.deleteIds('file', [created[0]!.id]));

            // Revert
            const reverted = await collect(
                entityOps.revertAll('file', [{ id: created[0]!.id }]),
            );

            expect(reverted).toHaveLength(1);
            expect(reverted[0]!.trashed_at).toBeNull();
        });

        it('should throw for non-trashed record', async () => {
            const created = await collect(
                entityOps.createAll('file', [{ pathname: 'not-trashed.txt', owner: 'test' }]),
            );

            // Try to revert non-trashed - should throw
            const promise = collect(entityOps.revertAll('file', [{ id: created[0]!.id }]));

            await expect(promise).rejects.toThrow();
        });
    });

    // =========================================================================
    // EXPIRE OPERATIONS - Hard Delete (through observer pipeline)
    // =========================================================================

    describe('expireAll', () => {
        it('should hard delete from detail table', async () => {
            const created = await collect(
                entityOps.createAll('file', [{ pathname: 'expire-me.txt', owner: 'test' }]),
            );

            await collect(entityOps.expireAll('file', [{ id: created[0]!.id }]));

            // Record should be gone from detail table
            const rows = await db.query('SELECT id FROM file WHERE id = ?', [created[0]!.id]);

            expect(rows).toHaveLength(0);
        });

        it('should leave stale entry in entities table (cache-only)', async () => {
            // The entities table is used for path resolution / model dispatch only.
            // Stale entries are acceptable because actual data access goes through
            // the detail table which properly filters on expired_at.
            const created = await collect(
                entityOps.createAll('file', [{ pathname: 'expire-entity.txt', owner: 'test' }]),
            );

            await collect(entityOps.expireAll('file', [{ id: created[0]!.id }]));

            // Entity entry remains (stale) - this is expected behavior
            const entityRows = await db.query('SELECT id FROM entities WHERE id = ?', [created[0]!.id]);

            expect(entityRows).toHaveLength(1);

            // But detail table entry is gone
            const detailRows = await db.query('SELECT id FROM file WHERE id = ?', [created[0]!.id]);

            expect(detailRows).toHaveLength(0);
        });
    });

    // =========================================================================
    // UPSERT OPERATIONS (through observer pipeline)
    // =========================================================================

    describe('upsertAll', () => {
        it('should create new record when ID not present', async () => {
            const upserted = await collect(
                entityOps.upsertAll('file', [{ pathname: 'upsert-new.txt', owner: 'test' }]),
            );

            expect(upserted).toHaveLength(1);
            expect(upserted[0]!.id).toBeTruthy();
        });

        it('should update existing record when ID exists', async () => {
            // Create first
            const created = await collect(
                entityOps.createAll('file', [{ pathname: 'upsert-existing.txt', owner: 'old' }]),
            );

            // Upsert with same ID
            const upserted = await collect(
                entityOps.upsertAll('file', [
                    { id: created[0]!.id, changes: { owner: 'updated' } },
                ]),
            );

            expect(upserted).toHaveLength(1);
            expect(upserted[0]!.owner).toBe('updated');
        });
    });

    // =========================================================================
    // EMPTY OBSERVER RUNNER (proof that Ring 5 is required)
    // =========================================================================

    describe('with empty observer runner', () => {
        it('should not persist records without Ring 5 observers', async () => {
            const emptyRunner = new ObserverRunner();
            const emptyOps = new EntityOps(db, cache, emptyRunner);

            // Create yields record but doesn't persist (no SQL executed)
            const results = await collect(
                emptyOps.createAll('file', [{ pathname: 'ghost.txt', owner: 'ghost' }]),
            );

            // Record is yielded (createAll doesn't know INSERT was skipped)
            expect(results).toHaveLength(1);

            // But verify not in database
            const rows = await db.query(
                'SELECT id FROM entities WHERE pathname = ?',
                ['ghost.txt'],
            );

            expect(rows).toHaveLength(0);
        });
    });
});
