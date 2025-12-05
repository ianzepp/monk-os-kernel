/**
 * EMS Syscalls - Entity Management System operations
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * EMS syscalls provide the interface between user processes and the Entity
 * Management System. Each syscall is an async generator that yields Response
 * messages back to the calling process.
 *
 * Operations:
 * - ems:select  - Query entities (streaming)
 * - ems:create  - Create new entities
 * - ems:update  - Update existing entities
 * - ems:delete  - Soft delete entities
 * - ems:expire  - Hard delete entities
 * - ems:revert  - Restore soft-deleted entities
 *
 * All operations go through the EntityOps observer pipeline, ensuring
 * validation, triggers, and audit logging are applied consistently.
 *
 * INVARIANTS
 * ==========
 * INV-1: All model arguments must be validated as strings
 * INV-2: Every syscall must yield at least one Response (ok, error, item, done)
 * INV-3: Stream responses (select) terminate with 'done'
 * INV-4: Single-record responses (create, update) use 'ok'
 *
 * @module kernel/syscalls/ems
 */

import type { Process } from '@src/kernel/types.js';
import type { Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { EntityOps, EntityRecord } from '@src/ems/entity-ops.js';
import type { SyscallRegistry } from './types.js';

// =============================================================================
// MAIN FACTORY
// =============================================================================

/**
 * Create EMS syscall handlers.
 *
 * @param entityOps - EntityOps instance for database operations
 * @returns Registry of syscall handlers
 */
export function createEmsSyscalls(entityOps: EntityOps): SyscallRegistry {
    return {
        // =====================================================================
        // QUERY OPERATIONS
        // =====================================================================

        /**
         * Select entities matching a filter.
         *
         * Streams matching records as 'item' responses, followed by 'done'.
         *
         * @param _proc - Calling process (unused, reserved for future ACL)
         * @param model - Model name to query
         * @param filter - Filter criteria (where, order, limit, offset)
         * @yields Response stream: item* done | error
         */
        async *'ems:select'(
            _proc: Process,
            model: unknown,
            filter: unknown,
        ): AsyncIterable<Response> {
            if (typeof model !== 'string') {
                yield respond.error('EINVAL', 'model must be a string');

                return;
            }

            const filterData = (typeof filter === 'object' && filter !== null)
                ? filter as Record<string, unknown>
                : {};

            try {
                for await (const record of entityOps.selectAny(model, filterData)) {
                    yield respond.item(record);
                }

                yield respond.done();
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);

                yield respond.error('EIO', msg);
            }
        },

        // =====================================================================
        // MUTATION OPERATIONS
        // =====================================================================

        /**
         * Create a new entity.
         *
         * @param _proc - Calling process
         * @param model - Model name
         * @param fields - Entity fields
         * @yields Response: ok(record) | error
         */
        async *'ems:create'(
            _proc: Process,
            model: unknown,
            fields: unknown,
        ): AsyncIterable<Response> {
            if (typeof model !== 'string') {
                yield respond.error('EINVAL', 'model must be a string');

                return;
            }

            if (typeof fields !== 'object' || fields === null) {
                yield respond.error('EINVAL', 'fields must be an object');

                return;
            }

            try {
                for await (const created of entityOps.createAll(model, [fields as Record<string, unknown>])) {
                    yield respond.ok(created);

                    return;
                }

                yield respond.error('EIO', 'No record created');
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);

                yield respond.error('EIO', msg);
            }
        },

        /**
         * Update an entity by ID.
         *
         * @param _proc - Calling process
         * @param model - Model name
         * @param id - Entity ID
         * @param changes - Fields to update
         * @yields Response: ok(record) | error
         */
        async *'ems:update'(
            _proc: Process,
            model: unknown,
            id: unknown,
            changes: unknown,
        ): AsyncIterable<Response> {
            if (typeof model !== 'string') {
                yield respond.error('EINVAL', 'model must be a string');

                return;
            }

            if (typeof id !== 'string') {
                yield respond.error('EINVAL', 'id must be a string');

                return;
            }

            if (typeof changes !== 'object' || changes === null) {
                yield respond.error('EINVAL', 'changes must be an object');

                return;
            }

            try {
                const updates = [{ id, changes: changes as Partial<EntityRecord> }];

                for await (const updated of entityOps.updateAll(model, updates)) {
                    yield respond.ok(updated);

                    return;
                }

                yield respond.error('ENOENT', `Entity not found: ${id}`);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);

                yield respond.error('EIO', msg);
            }
        },

        /**
         * Delete (soft) an entity by ID.
         *
         * @param _proc - Calling process
         * @param model - Model name
         * @param id - Entity ID
         * @yields Response: ok(record) | error
         */
        async *'ems:delete'(
            _proc: Process,
            model: unknown,
            id: unknown,
        ): AsyncIterable<Response> {
            if (typeof model !== 'string') {
                yield respond.error('EINVAL', 'model must be a string');

                return;
            }

            if (typeof id !== 'string') {
                yield respond.error('EINVAL', 'id must be a string');

                return;
            }

            try {
                for await (const deleted of entityOps.deleteIds(model, [id])) {
                    yield respond.ok(deleted);

                    return;
                }

                yield respond.error('ENOENT', `Entity not found: ${id}`);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);

                yield respond.error('EIO', msg);
            }
        },

        /**
         * Revert (undelete) a soft-deleted entity.
         *
         * @param _proc - Calling process
         * @param model - Model name
         * @param id - Entity ID
         * @yields Response: ok(record) | error
         */
        async *'ems:revert'(
            _proc: Process,
            model: unknown,
            id: unknown,
        ): AsyncIterable<Response> {
            if (typeof model !== 'string') {
                yield respond.error('EINVAL', 'model must be a string');

                return;
            }

            if (typeof id !== 'string') {
                yield respond.error('EINVAL', 'id must be a string');

                return;
            }

            try {
                for await (const reverted of entityOps.revertAll(model, [{ id }])) {
                    yield respond.ok(reverted);

                    return;
                }

                yield respond.error('ENOENT', `Entity not found: ${id}`);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);

                yield respond.error('EIO', msg);
            }
        },

        /**
         * Expire (hard delete) an entity permanently.
         *
         * @param _proc - Calling process
         * @param model - Model name
         * @param id - Entity ID
         * @yields Response: ok | error
         */
        async *'ems:expire'(
            _proc: Process,
            model: unknown,
            id: unknown,
        ): AsyncIterable<Response> {
            if (typeof model !== 'string') {
                yield respond.error('EINVAL', 'model must be a string');

                return;
            }

            if (typeof id !== 'string') {
                yield respond.error('EINVAL', 'id must be a string');

                return;
            }

            try {
                for await (const expired of entityOps.expireAll(model, [{ id }])) {
                    yield respond.ok(expired);

                    return;
                }

                yield respond.error('ENOENT', `Entity not found: ${id}`);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);

                yield respond.error('EIO', msg);
            }
        },
    };
}
