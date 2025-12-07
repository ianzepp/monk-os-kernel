/**
 * EMS Syscalls - Entity Management System operations
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * EMS syscalls provide the interface between user processes and the Entity
 * Management System. Each syscall is a standalone async generator function
 * that receives explicit dependencies (proc, ems) and yields Response messages.
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
 * DESIGN: EMS syscalls need proc and EMS
 * ======================================
 * The proc is currently unused but reserved for future ACL checks.
 * The EMS instance provides access to EntityOps for database operations.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All model arguments must be validated as strings
 * INV-2: Every syscall must yield at least one Response (ok, error, item, done)
 * INV-3: Stream responses (select) terminate with 'done'
 * INV-4: Single-record responses (create, update) use 'ok'
 *
 * @module syscall/ems
 */

import type { EMS } from '@src/ems/ems.js';
import type { EntityRecord } from '@src/ems/entity-ops.js';
import type { Process, Response } from './types.js';
import { respond } from './types.js';

// =============================================================================
// QUERY OPERATIONS
// =============================================================================

/**
 * Select entities matching a filter.
 *
 * Streams matching records as 'item' responses, followed by 'done'.
 *
 * @param proc - Calling process (reserved for future ACL)
 * @param ems - EMS instance
 * @param model - Model name to query
 * @param filter - Filter criteria (where, order, limit, offset)
 */
export async function* emsSelect(
    _proc: Process,
    ems: EMS,
    model: unknown,
    filter?: unknown,
): AsyncIterable<Response> {
    if (typeof model !== 'string') {
        yield respond.error('EINVAL', 'model must be a string');

        return;
    }

    const filterData = (typeof filter === 'object' && filter !== null)
        ? filter as Record<string, unknown>
        : {};

    try {
        for await (const record of ems.ops.selectAny(model, filterData)) {
            yield respond.item(record);
        }

        yield respond.done();
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', msg);
    }
}

// =============================================================================
// MUTATION OPERATIONS
// =============================================================================

/**
 * Create a new entity.
 *
 * @param proc - Calling process
 * @param ems - EMS instance
 * @param model - Model name
 * @param fields - Entity fields
 */
export async function* emsCreate(
    _proc: Process,
    ems: EMS,
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
        for await (const created of ems.ops.createAll(model, [fields as Record<string, unknown>])) {
            yield respond.ok(created);

            return;
        }

        yield respond.error('EIO', 'No record created');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', msg);
    }
}

/**
 * Update an entity by ID.
 *
 * @param proc - Calling process
 * @param ems - EMS instance
 * @param model - Model name
 * @param id - Entity ID
 * @param changes - Fields to update
 */
export async function* emsUpdate(
    _proc: Process,
    ems: EMS,
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

        for await (const updated of ems.ops.updateAll(model, updates)) {
            yield respond.ok(updated);

            return;
        }

        yield respond.error('ENOENT', `Entity not found: ${id}`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', msg);
    }
}

/**
 * Delete (soft) an entity by ID.
 *
 * @param proc - Calling process
 * @param ems - EMS instance
 * @param model - Model name
 * @param id - Entity ID
 */
export async function* emsDelete(
    _proc: Process,
    ems: EMS,
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
        for await (const deleted of ems.ops.deleteIds(model, [id])) {
            yield respond.ok(deleted);

            return;
        }

        yield respond.error('ENOENT', `Entity not found: ${id}`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', msg);
    }
}

/**
 * Revert (undelete) a soft-deleted entity.
 *
 * @param proc - Calling process
 * @param ems - EMS instance
 * @param model - Model name
 * @param id - Entity ID
 */
export async function* emsRevert(
    _proc: Process,
    ems: EMS,
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
        for await (const reverted of ems.ops.revertAll(model, [{ id }])) {
            yield respond.ok(reverted);

            return;
        }

        yield respond.error('ENOENT', `Entity not found: ${id}`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', msg);
    }
}

/**
 * Expire (hard delete) an entity permanently.
 *
 * @param proc - Calling process
 * @param ems - EMS instance
 * @param model - Model name
 * @param id - Entity ID
 */
export async function* emsExpire(
    _proc: Process,
    ems: EMS,
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
        for await (const expired of ems.ops.expireAll(model, [{ id }])) {
            yield respond.ok(expired);

            return;
        }

        yield respond.error('ENOENT', `Entity not found: ${id}`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        yield respond.error('EIO', msg);
    }
}
