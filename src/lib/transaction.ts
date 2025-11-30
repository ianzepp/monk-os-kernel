/**
 * Transaction Runner
 *
 * Core transaction lifecycle management, decoupled from any HTTP framework.
 * Provides a single source of truth for transaction handling that can be
 * used by route handlers, app packages, background jobs, and CLI tools.
 */

import { System, type SystemInit } from '@src/lib/system.js';
import { createAdapter } from '@src/lib/database/index.js';

/**
 * Options for transaction execution
 */
export interface TransactionOptions {
    /** Skip namespace cache loading (useful for bootstrap operations) */
    skipCacheLoad?: boolean;
    /** Custom logging context for debugging */
    logContext?: Record<string, any>;
}

/**
 * Result wrapper that includes the System instance for post-transaction access
 */
export interface TransactionResult<T> {
    result: T;
    system: System;
}

/**
 * Core transaction runner - framework-agnostic
 *
 * Handles the complete transaction lifecycle:
 * 1. Creates System from SystemInit
 * 2. Creates and connects database adapter
 * 3. Begins transaction
 * 4. Loads namespace cache (unless skipped)
 * 5. Executes handler
 * 6. Commits on success, rolls back on error
 * 7. Cleans up adapter connection
 *
 * @param init - System initialization parameters (from JWT or direct)
 * @param handler - Async function to execute within the transaction
 * @param options - Optional configuration
 * @returns The result of the handler function
 * @throws Re-throws any error from handler after rollback
 *
 * @example
 * // Direct usage for app/job contexts
 * const result = await runTransaction(systemInit, async (system) => {
 *     return await system.database.selectOne('users', userId);
 * });
 *
 * @example
 * // With options
 * await runTransaction(systemInit, async (system) => {
 *     await system.describe.models.createOne({ model_name: 'foo' });
 * }, { skipCacheLoad: true });
 */
export async function runTransaction<T>(
    init: SystemInit,
    handler: (system: System) => Promise<T>,
    options: TransactionOptions = {}
): Promise<T> {
    const system = new System(init);
    const adapter = createAdapter({
        dbType: init.dbType,
        db: init.dbName,
        ns: init.nsName,
    });

    const logContext = {
        dbType: init.dbType,
        namespace: init.nsName,
        tenant: init.tenant,
        ...options.logContext,
    };

    try {
        // Connect and begin transaction
        await adapter.connect();
        await adapter.beginTransaction();

        // Set adapter on system for database operations
        system.adapter = adapter;

        // Load namespace cache if needed (most operations need this)
        if (!options.skipCacheLoad && system.namespace && !system.namespace.isLoaded()) {
            await system.namespace.loadAll(system);
        }

        console.info('Transaction started', {
            ...logContext,
            cacheLoaded: system.namespace?.isLoaded() ?? false,
        });

        // Execute handler within transaction
        const result = await handler(system);

        // Commit on success
        await adapter.commit();
        console.info('Transaction committed', logContext);

        return result;

    } catch (error) {
        // Rollback on any error
        try {
            await adapter.rollback();
            console.info('Transaction rolled back', {
                ...logContext,
                error: error instanceof Error ? error.message : String(error),
            });
        } catch (rollbackError) {
            console.warn('Failed to rollback transaction', {
                ...logContext,
                rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            });
        }

        // Re-throw original error for caller to handle
        throw error;

    } finally {
        // Always clean up
        await adapter.disconnect();
        system.adapter = null;
    }
}

/**
 * Run transaction and return both result and system instance
 *
 * Useful when caller needs access to system state after transaction completes
 * (e.g., for reading correlationId or other metadata).
 *
 * @param init - System initialization parameters
 * @param handler - Async function to execute within the transaction
 * @param options - Optional configuration
 * @returns Object containing both the result and the system instance
 */
export async function runTransactionWithSystem<T>(
    init: SystemInit,
    handler: (system: System) => Promise<T>,
    options: TransactionOptions = {}
): Promise<TransactionResult<T>> {
    let capturedSystem: System | null = null;

    const result = await runTransaction(init, async (system) => {
        capturedSystem = system;
        return await handler(system);
    }, options);

    return {
        result,
        system: capturedSystem!,
    };
}

/**
 * Run a read-only operation with search_path scoping
 *
 * ============================================================================
 * DESIGN DECISIONS
 * ============================================================================
 *
 * WHY THIS EXISTS (vs runTransaction):
 * ------------------------------------
 * This function is optimized for read-only streaming operations where we need
 * tenant isolation (via search_path) but don't need transaction semantics.
 *
 * For streaming queries, we want to yield records one at a time to the HTTP
 * response without buffering the entire result set in memory. This requires
 * keeping the database connection open while streaming.
 *
 * WHY WE USE BEGIN + SET LOCAL (not just SET):
 * --------------------------------------------
 * PostgreSQL has two ways to set search_path:
 *
 *   SET search_path = tenant_schema
 *     - Session-scoped: persists for the entire connection lifetime
 *     - Risk: if connection is returned to pool without reset, next request
 *       could inherit wrong tenant's search_path (data leak!)
 *     - Relies on pool behavior (DISCARD ALL) for safety
 *
 *   BEGIN; SET LOCAL search_path = tenant_schema
 *     - Transaction-scoped: automatically reverts when transaction ends
 *     - Safe: even if pool doesn't reset, search_path reverts on tx end
 *     - No risk of cross-tenant data leakage
 *
 * We use SET LOCAL for defense-in-depth security.
 *
 * WHY WE DON'T COMMIT (implicit rollback):
 * ----------------------------------------
 * For read-only operations, COMMIT vs ROLLBACK is semantically identical -
 * there's nothing to persist. When we disconnect, PostgreSQL implicitly
 * rolls back any open transaction.
 *
 * Benefits of not explicitly committing:
 *   - Clearer intent: this is read-only, nothing to commit
 *   - Slightly faster: one less round-trip to database
 *   - Simpler error handling: just disconnect on any error
 *
 * LONG-RUNNING TRANSACTION CONCERNS:
 * ----------------------------------
 * Open transactions (even read-only) can delay PostgreSQL's vacuum process
 * because MVCC keeps old row versions visible to the transaction's snapshot.
 *
 *   Stream duration  | Impact
 *   -----------------|--------
 *   < 1 minute       | Negligible
 *   1-10 minutes     | Minor vacuum delay
 *   > 10 minutes     | Could cause table bloat
 *
 * For typical API streaming (thousands/millions of rows), expect seconds to
 * ~1 minute. This is acceptable for most workloads.
 *
 * STREAMING FLOW:
 * ---------------
 *   1. Get connection from pool
 *   2. BEGIN (starts transaction scope)
 *   3. SET LOCAL search_path = tenant_schema
 *   4. Execute query, return async generator
 *   5. Caller iterates generator, streaming to HTTP response
 *   6. When generator exhausts (or error), disconnect
 *   7. Connection returns to pool (implicit rollback cleans up)
 *
 * ============================================================================
 *
 * @param init - System initialization parameters (from JWT)
 * @param handler - Async function that may return an AsyncGenerator for streaming
 * @param options - Optional configuration
 * @returns The result of the handler (may be AsyncGenerator)
 */
export async function runWithSearchPath<T>(
    init: SystemInit,
    handler: (system: System) => Promise<T>,
    options: TransactionOptions = {}
): Promise<T> {
    const system = new System(init);
    const adapter = createAdapter({
        dbType: init.dbType,
        db: init.dbName,
        ns: init.nsName,
    });

    const logContext = {
        dbType: init.dbType,
        namespace: init.nsName,
        tenant: init.tenant,
        ...options.logContext,
    };

    // Connect and set up search_path scope
    await adapter.connect();
    await adapter.beginTransaction(); // Required for SET LOCAL scoping
    system.adapter = adapter;

    // Load namespace cache if needed
    if (!options.skipCacheLoad && system.namespace && !system.namespace.isLoaded()) {
        await system.namespace.loadAll(system);
    }

    console.debug('Search path scope started', logContext);

    try {
        // Execute handler - may return AsyncGenerator for streaming
        const result = await handler(system);

        // Check if result is an async iterable (streaming)
        if (result !== null && typeof result === 'object' && Symbol.asyncIterator in result) {
            // Wrap the generator to ensure cleanup after iteration completes
            return wrapAsyncIterableWithCleanup(
                result as AsyncIterable<unknown>,
                adapter,
                system,
                logContext
            ) as T;
        }

        // Non-streaming result: clean up immediately
        await adapter.disconnect();
        system.adapter = null;
        console.debug('Search path scope ended (non-streaming)', logContext);

        return result;

    } catch (error) {
        // Clean up on error
        await adapter.disconnect();
        system.adapter = null;
        console.debug('Search path scope ended (error)', {
            ...logContext,
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
}

/**
 * Wrap an async iterable to ensure database cleanup after iteration
 *
 * This creates a new async generator that:
 * 1. Yields all values from the source iterable
 * 2. Disconnects the adapter when iteration completes (success or error)
 * 3. Handles client disconnect (generator abandoned) via finally block
 */
async function* wrapAsyncIterableWithCleanup<T>(
    iterable: AsyncIterable<T>,
    adapter: ReturnType<typeof createAdapter>,
    system: System,
    logContext: Record<string, any>
): AsyncGenerator<T, void, unknown> {
    try {
        for await (const item of iterable) {
            yield item;
        }
        console.debug('Search path scope ended (stream complete)', logContext);
    } catch (error) {
        console.debug('Search path scope ended (stream error)', {
            ...logContext,
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    } finally {
        // Always clean up, even if client disconnects mid-stream
        await adapter.disconnect();
        system.adapter = null;
    }
}
