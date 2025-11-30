/**
 * Base Async Observer Class
 *
 * Async observers execute outside the transaction context and don't block
 * the observer pipeline response. Ideal for post-database operations like
 * notifications, webhooks, cache invalidation, and audit logging.
 *
 * Async observers:
 * - Execute via setImmediate() - don't block pipeline response
 * - Run outside transaction context - errors don't trigger rollback
 * - Failed executions logged via console.warn() - no pipeline impact
 * - Perfect for Rings 6-9 (PostDatabase, Audit, Integration, Notification)
 */

import type { Observer, ObserverContext } from '@src/lib/observers/interfaces.js';
import type { ObserverRing, OperationType } from '@src/lib/observers/types.js';

/**
 * Abstract base class for async observers
 *
 * Provides non-blocking execution pattern where observer runs asynchronously
 * after the main observer pipeline completes, ensuring fast API response times
 * while still executing necessary post-database operations.
 */
export abstract class BaseAsyncObserver implements Observer {
    abstract readonly ring: ObserverRing;
    readonly operations?: readonly OperationType[];

    // Default timeout for async observer execution (can be overridden)
    protected readonly timeoutMs: number = 10000; // 10 seconds for external operations

    /**
     * Async execution - starts observer execution but returns immediately
     *
     * This method implements the async execution pattern by using setImmediate()
     * to schedule the observer execution outside the current event loop tick,
     * allowing the main pipeline to complete and respond quickly.
     */
    async executeTry(context: ObserverContext): Promise<void> {
        const observerName = this.constructor.name;
        const { system, operation, model } = context;
        const modelName = model.model_name;

        // Execute asynchronously - don't block pipeline
        setImmediate(async () => {
            try {
                // Execute with timeout protection for external operations
                await Promise.race([
                    this.execute(context),
                    this.createTimeoutPromise(observerName)
                ]);

                // // Log successful async execution timing
                console.info(`AsyncObserver: ${observerName}`, {
                    ring: this.ring,
                    operation,
                    modelName,
                    status: 'success'
                });

            } catch (error) {
                // Log failed async execution timing
                console.info(`AsyncObserver: ${observerName}`, {
                    ring: this.ring,
                    operation,
                    modelName,
                    status: 'failed',
                    error: error instanceof Error ? error.message : String(error)
                });

                // Async errors are logged but don't affect transaction or response
                console.warn(`Async observer failed: ${observerName}`, {
                    ring: this.ring,
                    operation,
                    modelName,
                    error: error instanceof Error ? error.message : String(error),
                    timeout: this.timeoutMs
                });
            }
        });

        // Return immediately - pipeline continues without waiting
    }

    /**
     * Pure business logic method - implement this in your async observer
     * @param context Shared context with request data and state
     */
    abstract execute(context: ObserverContext): Promise<void>;

    /**
     * Create timeout promise for async observer execution
     */
    private createTimeoutPromise(observerName: string): Promise<never> {
        return new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Async observer ${observerName} timed out after ${this.timeoutMs}ms`));
            }, this.timeoutMs);
        });
    }

    /**
     * Helper method to check if this observer should execute for the given operation
     */
    shouldExecute(operation: OperationType): boolean {
        return !this.operations || this.operations.includes(operation);
    }
}
