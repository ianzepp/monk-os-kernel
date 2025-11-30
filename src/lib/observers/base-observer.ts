/**
 * Base Observer Class
 *
 * Provides the executeTry/execute pattern for consistent error handling,
 * logging, and timeout management across all observers.
 *
 * Single-record model: Observers receive one record at a time via context.record.
 * The ObserverRunner handles iteration over the batch.
 */

import type { Observer, ObserverContext } from '@src/lib/observers/interfaces.js';
import type { ObserverRing, OperationType } from '@src/lib/observers/types.js';
import {
    ValidationError,
    BusinessLogicError,
    SystemError,
    ValidationWarning,
    ObserverTimeoutError
} from '@src/lib/observers/errors.js';

/**
 * Abstract base class for all observers
 *
 * Provides:
 * - Error handling and categorization
 * - Execution time tracking and logging
 * - Timeout protection
 * - Consistent logging format
 *
 * Single-record model:
 * - context.record contains the current ModelRecord being processed
 * - context.recordIndex contains the index in the original batch
 * - Override execute() to implement your observer logic
 */
export abstract class BaseObserver implements Observer {
    abstract readonly ring: ObserverRing;
    readonly operations?: readonly OperationType[];
    readonly models?: readonly string[];

    /**
     * Execution priority within a ring (lower numbers execute first)
     *
     * Default: 50 (middle priority)
     * Range: 0-100 recommended (but any number is valid)
     *
     * Examples:
     * - 0-20: High priority (validation, security checks)
     * - 40-60: Normal priority (default business logic)
     * - 80-100: Low priority (cleanup, notifications)
     *
     * Use explicit priorities when execution order matters within a ring.
     */
    readonly priority: number = 50;

    // Default timeout for observer execution (can be overridden)
    protected readonly timeoutMs: number = 5000; // 5 seconds

    /**
     * Public method - handles errors, timeouts, logging, and profiling
     *
     * This method should be called by the ObserverRunner. It wraps the
     * execute() method with consistent error handling, logging, and execution profiling.
     */
    async executeTry(context: ObserverContext): Promise<void> {
        const observerName = this.constructor.name;
        const { operation, model, recordIndex } = context;
        const modelName = model.model_name;

        try {
            // Execute with timeout protection
            await Promise.race([
                this.execute(context),
                this.createTimeoutPromise(observerName)
            ]);

            // Log successful execution
            console.info(`Observer: ${observerName}`, {
                ring: this.ring,
                operation,
                modelName,
                recordIndex,
                status: 'success'
            });

        } catch (error) {
            // Log failed execution
            console.info(`Observer: ${observerName}`, {
                ring: this.ring,
                operation,
                modelName,
                recordIndex,
                status: 'failed',
                error: error instanceof Error ? error.message : String(error)
            });

            // Handle observer error
            this.handleObserverError(error, observerName, context);
        }
    }

    /**
     * Single-record processing method - override this in your observer
     *
     * The record is available via context.record (ModelRecord instance).
     * The record index is available via context.recordIndex.
     *
     * Error handling guidelines:
     * - Throw ValidationError for invalid input data
     * - Throw BusinessLogicError for business rule violations
     * - Throw SystemError for unrecoverable system failures
     * - Add warnings to context.warnings for non-blocking issues
     */
    abstract execute(context: ObserverContext): Promise<void>;

    /**
     * Create timeout promise for observer execution
     */
    private createTimeoutPromise(observerName: string): Promise<never> {
        return new Promise((_, reject) => {
            setTimeout(() => {
                reject(new ObserverTimeoutError(observerName, this.timeoutMs));
            }, this.timeoutMs);
        });
    }

    /**
     * Categorize and handle errors from observer execution
     */
    private handleObserverError(
        error: unknown,
        observerName: string,
        context: ObserverContext
    ): void {
        if (error instanceof ValidationError) {
            // Recoverable validation errors - collect for user feedback
            context.errors.push(error);

        } else if (error instanceof BusinessLogicError) {
            // Recoverable business logic errors - collect for user feedback
            context.errors.push(error);

        } else if (error instanceof SystemError || error instanceof ObserverTimeoutError) {
            // Unrecoverable system errors - should rollback entire transaction
            console.warn('Observer system error', {
                observerName,
                operation: context.operation,
                modelName: context.model?.model_name ?? 'unknown',
                recordIndex: context.recordIndex,
                error: error.message
            });
            throw error; // Propagate to rollback transaction

        } else if (error instanceof Error) {
            // Unknown errors become warnings - don't block execution
            const warning = new ValidationWarning(
                `Observer ${observerName}: ${error.message}`,
                undefined,
                'UNKNOWN_ERROR'
            );
            context.warnings.push(warning);
            console.warn('Observer unknown error', {
                observerName,
                operation: context.operation,
                modelName: context.model?.model_name ?? 'unknown',
                recordIndex: context.recordIndex,
                error: error.message
            });

        } else {
            // Non-Error objects become warnings
            const warning = new ValidationWarning(
                `Observer ${observerName}: ${String(error)}`,
                undefined,
                'UNKNOWN_ERROR'
            );
            context.warnings.push(warning);
            console.warn('Observer unknown error (non-Error object)', {
                observerName,
                operation: context.operation,
                modelName: context.model?.model_name ?? 'unknown',
                recordIndex: context.recordIndex,
                error: String(error)
            });
        }
    }

    /**
     * Helper method to check if this observer should execute for the given operation
     */
    shouldExecute(operation: OperationType): boolean {
        return !this.operations || this.operations.includes(operation);
    }

    /**
     * Helper method for observers to validate required fields on context.record
     */
    protected validateRequiredFields(context: ObserverContext, requiredFields: string[]): void {
        const record = context.record;
        for (const field of requiredFields) {
            const value = record.get(field);
            if (value === undefined || value === null || value === '') {
                throw new ValidationError(`Required field '${field}' is missing or empty`, field);
            }
        }
    }

    /**
     * Helper method for observers to validate field format on context.record
     */
    protected validateFieldFormat(context: ObserverContext, field: string, pattern: RegExp, errorMessage?: string): void {
        const value = context.record.get(field);
        if (value && !pattern.test(String(value))) {
            const message = errorMessage || `Field '${field}' has invalid format`;
            throw new ValidationError(message, field);
        }
    }

}
