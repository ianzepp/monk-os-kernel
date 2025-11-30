/**
 * Observer Runner
 *
 * Executes observers in ordered rings (0-9) with error aggregation,
 * timeout protection, and performance monitoring.
 *
 * Single-record model: The runner iterates over records and passes
 * one record at a time to each observer. This eliminates redundant
 * looping inside observers and simplifies observer logic.
 */

import type { SystemContext } from '@src/lib/system-context-types.js';
import { Model } from '@src/lib/model.js';
import { ModelRecord } from '@src/lib/model-record.js';
import type {
    Observer,
    ObserverContext,
    ObserverStats,
    ObserverExecutionSummary
} from '@src/lib/observers/interfaces.js';
import type {
    ObserverRing,
    OperationType,
    ObserverResult
} from '@src/lib/observers/types.js';
import { RING_OPERATION_MATRIX } from '@src/lib/observers/types.js';
import { ValidationError } from '@src/lib/observers/errors.js';
import type { ValidationWarning } from '@src/lib/observers/errors.js';
import { ObserverLoader } from '@src/lib/observers/loader.js';

/**
 * Extended ValidationError with record index for batch error reporting
 */
interface IndexedValidationError extends ValidationError {
    recordIndex?: number;
}

/**
 * Observer execution engine with ring-based execution
 *
 * Execution model:
 * - Outer loop: iterate over records
 * - Inner loop: for each record, execute all rings in order
 * - Observers receive single record via context.record
 */
export class ObserverRunner {
    private readonly defaultTimeout = 5000; // 5 seconds
    private readonly collectStats = true;

    /**
     * Execute observers for a model operation with selective ring execution
     *
     * Iterates over records, running the full ring pipeline for each record.
     * Collects errors with record indices for batch error reporting.
     * Fails entire batch if any record fails validation (before Ring 5).
     */
    async execute(
        system: SystemContext,
        operation: OperationType,
        model: Model,
        records: ModelRecord[],
        depth: number = 0
    ): Promise<ObserverResult> {
        const startTime = Date.now();
        const stats: ObserverStats[] = [];
        const allErrors: IndexedValidationError[] = [];
        const allWarnings: ValidationWarning[] = [];
        const ringsExecuted: ObserverRing[] = [];

        // Get relevant rings for this operation (selective execution)
        const relevantRings = RING_OPERATION_MATRIX[operation] || [5]; // Default: Database only

        console.info('Observer pipeline started', {
            operation,
            modelName: model.model_name,
            recordCount: records.length,
            ringCount: relevantRings.length,
            rings: relevantRings
        });

        try {
            // Outer loop: iterate over records
            for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
                const record = records[recordIndex];

                // Create per-record context
                const context = this._createContext(system, operation, model, record, recordIndex);

                // Inner loop: execute all rings for this record
                let recordFailed = false;
                for (const ring of relevantRings) {
                    context.currentRing = ring as ObserverRing;

                    // Track rings executed (only on first record to avoid duplicates)
                    if (recordIndex === 0) {
                        ringsExecuted.push(ring as ObserverRing);
                    }

                    const shouldContinue = await this._executeObserverRing(ring as ObserverRing, context, stats);

                    if (!shouldContinue) {
                        // Validation failed - collect errors with record index
                        for (const error of context.errors) {
                            (error as IndexedValidationError).recordIndex = recordIndex;
                            allErrors.push(error as IndexedValidationError);
                        }
                        recordFailed = true;
                        break; // Stop processing this record
                    }
                }

                // Collect warnings regardless of success/failure
                allWarnings.push(...context.warnings);

                // If record failed validation (pre-Ring 5), continue to collect more errors
                // but mark that we have failures
                if (recordFailed) {
                    continue;
                }

                // Collect any errors from post-database rings
                if (context.errors.length > 0) {
                    for (const error of context.errors) {
                        (error as IndexedValidationError).recordIndex = recordIndex;
                        allErrors.push(error as IndexedValidationError);
                    }
                }
            }

            const totalTime = Date.now() - startTime;

            // If any errors occurred, return failure
            if (allErrors.length > 0) {
                return this._createFailureResult(model, operation, allErrors, allWarnings, stats, ringsExecuted, totalTime);
            }

            return this._createSuccessResult(model, operation, records.length, allWarnings, stats, ringsExecuted, totalTime);

        } catch (error) {
            const totalTime = Date.now() - startTime;
            return this._createErrorResult(model, operation, error, allWarnings, totalTime);
        }
    }

    /**
     * Create observer context for a single record
     */
    private _createContext(
        system: SystemContext,
        operation: OperationType,
        model: Model,
        record: ModelRecord,
        recordIndex: number
    ): ObserverContext {
        return {
            system,
            operation,
            model,
            record,
            recordIndex,
            errors: [],
            warnings: [],
            startTime: Date.now(),
            currentRing: undefined,
            currentObserver: undefined
        };
    }

    /**
     * Create successful execution result
     */
    private _createSuccessResult(
        model: Model,
        operation: OperationType,
        recordCount: number,
        warnings: ValidationWarning[],
        stats: ObserverStats[],
        ringsExecuted: ObserverRing[],
        totalTime: number
    ): ObserverResult {
        console.info('Observer execution completed', {
            success: true,
            operation,
            modelName: model.model_name,
            recordCount,
            totalTimeMs: totalTime,
            ringsExecuted: ringsExecuted.length,
            observersExecuted: stats.length,
            warningCount: warnings.length
        });

        return {
            success: true,
            errors: [],
            warnings
        };
    }

    /**
     * Create failure result for validation errors
     */
    private _createFailureResult(
        model: Model,
        operation: OperationType,
        errors: IndexedValidationError[],
        warnings: ValidationWarning[],
        stats: ObserverStats[],
        ringsExecuted: ObserverRing[],
        totalTime: number
    ): ObserverResult {
        console.warn('Observer execution failed with validation errors', {
            success: false,
            operation,
            modelName: model.model_name,
            totalTimeMs: totalTime,
            ringsExecuted: ringsExecuted.length,
            errorCount: errors.length,
            warningCount: warnings.length
        });

        return {
            success: false,
            errors,
            warnings
        };
    }

    /**
     * Create error result for unexpected execution failures
     */
    private _createErrorResult(
        model: Model,
        operation: OperationType,
        error: unknown,
        warnings: ValidationWarning[],
        totalTime: number
    ): ObserverResult {
        console.warn('Observer execution failed unexpectedly', {
            operation,
            modelName: model.model_name,
            totalTimeMs: totalTime,
            error: error instanceof Error ? error.message : String(error)
        });

        return {
            success: false,
            errors: [{
                message: `Observer execution failed: ${error}`,
                code: 'OBSERVER_EXECUTION_ERROR'
            } as ValidationError],
            warnings
        };
    }


    /**
     * Execute observers for a specific ring on the current record
     */
    private async _executeObserverRing(
        ring: ObserverRing,
        context: ObserverContext,
        stats: ObserverStats[]
    ): Promise<boolean> {
        const observers = ObserverLoader.getObservers(context.model.model_name, ring);

        // Sort observers by priority (lower numbers execute first)
        // This ensures deterministic execution order within a ring
        const sortedObservers = observers.sort((a, b) => {
            const priorityA = a.priority ?? 50; // Default to 50 if not specified
            const priorityB = b.priority ?? 50;
            return priorityA - priorityB;
        });

        for (const observer of sortedObservers) {
            if (this._shouldExecuteObserver(observer, context)) {
                const observerStats = await this._executeObserver(observer, context);
                if (this.collectStats) {
                    stats.push(observerStats);
                }
            }
        }

        // Check for errors after each pre-database ring
        if (context.errors.length > 0 && ring < 5) {
            return false; // Stop execution for this record
        }

        return true; // Continue execution
    }

    /**
     * Execute a single observer with timeout protection
     */
    private async _executeObserver(
        observer: Observer,
        context: ObserverContext
    ): Promise<ObserverStats> {
        const startTime = Date.now();
        context.currentObserver = observer.name || 'unnamed';

        const timeout = observer.timeout || this.defaultTimeout;
        let success = true;
        let errorCount = 0;
        let warningCount = 0;

        try {
            // Execute observer with timeout protection
            await Promise.race([
                observer.executeTry(context),
                this._createTimeoutPromise(timeout, observer.name || 'unnamed')
            ]);

        } catch (error) {
            success = false;
            errorCount++;

            const validationError = new ValidationError(
                `Observer execution failed: ${error}`,
                undefined,
                'OBSERVER_ERROR'
            );
            context.errors.push(validationError);

            // Note: Observer errors should be handled by BaseObserver.executeTry()
            // This is a fallback that shouldn't normally execute
        }

        // Count errors/warnings added by this observer
        const currentErrors = context.errors.length;
        const currentWarnings = context.warnings.length;

        errorCount = Math.max(errorCount, currentErrors);
        warningCount = currentWarnings;

        const executionTime = Date.now() - startTime;

        return {
            observerName: observer.name || 'unnamed',
            ring: observer.ring,
            model: context.model.model_name,
            operation: context.operation,
            executionTimeMs: executionTime,
            success,
            errorCount,
            warningCount
        };
    }

    /**
     * Check if observer should be executed for this context
     */
    private _shouldExecuteObserver(observer: Observer, context: ObserverContext): boolean {
        // Passthrough mode: only execute ring 5 (database)
        // Used for high-throughput inserts (sensors, logs, telemetry)
        if (context.model.isPassthrough() && observer.ring !== 5) {
            return false;
        }

        // Check operation targeting
        if (observer.operations && observer.operations.length > 0) {
            if (!observer.operations.includes(context.operation)) {
                return false;
            }
        }

        // Check adapter targeting (e.g., PostgreSQL-only observers)
        // If no adapters specified, observer runs on all adapters
        if (observer.adapters && observer.adapters.length > 0) {
            const currentAdapter = context.system.adapter?.getType();
            if (!currentAdapter || !observer.adapters.includes(currentAdapter)) {
                return false;
            }
        }

        return true;
    }

    /**
     * Create timeout promise that rejects after specified milliseconds
     */
    private _createTimeoutPromise(timeoutMs: number, observerName: string): Promise<never> {
        return new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Observer timeout (${timeoutMs}ms): ${observerName}`));
            }, timeoutMs);
        });
    }

    /**
     * Validate observer execution context
     */
    static validateContext(context: Partial<ObserverContext>): context is ObserverContext {
        return !!(
            context.system &&
            context.operation &&
            context.model &&
            context.record &&
            typeof context.recordIndex === 'number' &&
            context.errors &&
            context.warnings &&
            typeof context.startTime === 'number'
        );
    }

}
