/**
 * BaseObserver Tests
 *
 * Tests for the BaseObserver abstract class which provides:
 * - Timeout handling via executeWithTimeout()
 * - Error wrapping for unknown errors
 * - Consistent observer infrastructure
 */

import { describe, it, expect } from 'bun:test';
import { BaseObserver } from '@src/ems/observers/base-observer.js';
import { ObserverError, EOBSERVER, EOBSTIMEOUT, EOBSINVALID } from '@src/ems/observers/errors.js';
import { ObserverRing, type OperationType } from '@src/ems/observers/types.js';
import { getDialect } from '@src/hal/dialect.js';
import type { ObserverContext } from '@src/ems/observers/interfaces.js';

// =============================================================================
// TEST OBSERVER IMPLEMENTATIONS
// =============================================================================

/**
 * Fast observer that completes immediately.
 */
class FastObserver extends BaseObserver {
    readonly name = 'FastObserver';
    readonly ring = ObserverRing.InputValidation;
    readonly priority = 10;
    readonly operations: readonly OperationType[] = ['create', 'update'];

    executeCalled = false;

    async execute(_context: ObserverContext): Promise<void> {
        this.executeCalled = true;
    }
}

/**
 * Slow observer that takes longer than timeout.
 */
class SlowObserver extends BaseObserver {
    readonly name = 'SlowObserver';
    readonly ring = ObserverRing.InputValidation;
    readonly priority = 10;
    readonly operations: readonly OperationType[] = ['create'];

    // Short timeout for testing
    protected override readonly timeout = 50;

    async execute(_context: ObserverContext): Promise<void> {
        // Sleep longer than timeout
        await new Promise(resolve => setTimeout(resolve, 200));
    }
}

/**
 * Observer that throws ObserverError.
 */
class ObserverErrorThrower extends BaseObserver {
    readonly name = 'ObserverErrorThrower';
    readonly ring = ObserverRing.InputValidation;
    readonly priority = 10;
    readonly operations: readonly OperationType[] = ['create'];

    async execute(_context: ObserverContext): Promise<void> {
        throw new EOBSINVALID('Validation failed', 'test_field');
    }
}

/**
 * Observer that throws a generic Error.
 */
class GenericErrorThrower extends BaseObserver {
    readonly name = 'GenericErrorThrower';
    readonly ring = ObserverRing.InputValidation;
    readonly priority = 10;
    readonly operations: readonly OperationType[] = ['create'];

    async execute(_context: ObserverContext): Promise<void> {
        throw new Error('Something went wrong');
    }
}

/**
 * Observer that throws a string.
 */
class StringThrower extends BaseObserver {
    readonly name = 'StringThrower';
    readonly ring = ObserverRing.InputValidation;
    readonly priority = 10;
    readonly operations: readonly OperationType[] = ['create'];

    async execute(_context: ObserverContext): Promise<void> {
        throw 'String error message';
    }
}

/**
 * Observer with custom timeout.
 */
class CustomTimeoutObserver extends BaseObserver {
    readonly name = 'CustomTimeoutObserver';
    readonly ring = ObserverRing.InputValidation;
    readonly priority = 10;
    readonly operations: readonly OperationType[] = ['create'];

    protected override readonly timeout = 10000; // 10 seconds

    async execute(_context: ObserverContext): Promise<void> {
        // Fast execution
    }
}

/**
 * Observer with models filter.
 */
class ModelFilteredObserver extends BaseObserver {
    readonly name = 'ModelFilteredObserver';
    readonly ring = ObserverRing.InputValidation;
    readonly priority = 10;
    readonly operations: readonly OperationType[] = ['create'];
    override readonly models = ['file', 'folder'] as const;

    async execute(_context: ObserverContext): Promise<void> {
        // Do nothing
    }
}

// =============================================================================
// MOCK CONTEXT
// =============================================================================

function createMockContext(): ObserverContext {
    return {
        system: {
            db: {
                dialect: getDialect('sqlite'),
                execute: async () => 0,
                query: async () => [],
                exec: async () => {},
                transaction: async () => [],
            },
            cache: {
                invalidate: () => {},
            },
        },
        operation: 'create',
        model: {
            modelName: 'test',
            isFrozen: false,
            isImmutable: false,
            requiresSudo: false,
            getImmutableFields: () => new Set(),
            getTrackedFields: () => new Set(),
            getTransformFields: () => new Map(),
            getValidationFields: () => [],
            getFields: () => [],
        },
        record: {
            isNew: () => true,
            old: () => undefined,
            get: () => undefined,
            has: () => false,
            set: () => {},
            getChangedFields: () => [],
            toRecord: () => ({}),
            toChanges: () => ({}),
            getDiff: () => ({}),
            getDiffForFields: () => ({}),
        },
        recordIndex: 0,
        errors: [],
        warnings: [],
    };
}

// =============================================================================
// TESTS
// =============================================================================

describe('BaseObserver', () => {
    // =========================================================================
    // CONFIGURATION TESTS
    // =========================================================================

    describe('configuration', () => {
        it('should have required abstract properties', () => {
            const observer = new FastObserver();

            expect(observer.name).toBe('FastObserver');
            expect(observer.ring).toBe(ObserverRing.InputValidation);
            expect(observer.priority).toBe(10);
            expect(observer.operations).toEqual(['create', 'update']);
        });

        it('should have default timeout of 5000ms', () => {
            const observer = new FastObserver();

            // Access protected property via any cast for testing
            expect((observer as unknown as { timeout: number }).timeout).toBe(5000);
        });

        it('should allow custom timeout', () => {
            const observer = new CustomTimeoutObserver();

            expect((observer as unknown as { timeout: number }).timeout).toBe(10000);
        });

        it('should have optional models filter', () => {
            const unfiltered = new FastObserver();
            const filtered = new ModelFilteredObserver();

            expect(unfiltered.models).toBeUndefined();
            expect(filtered.models).toEqual(['file', 'folder']);
        });
    });

    // =========================================================================
    // EXECUTE WITH TIMEOUT TESTS
    // =========================================================================

    describe('executeWithTimeout', () => {
        it('should complete successfully for fast observers', async () => {
            const observer = new FastObserver();
            const context = createMockContext();

            await observer.executeWithTimeout(context);

            expect(observer.executeCalled).toBe(true);
        });

        it('should throw EOBSTIMEOUT for slow observers', async () => {
            const observer = new SlowObserver();
            const context = createMockContext();

            await expect(observer.executeWithTimeout(context)).rejects.toThrow(EOBSTIMEOUT);

            try {
                await observer.executeWithTimeout(context);
            }
            catch (err) {
                expect(err).toBeInstanceOf(EOBSTIMEOUT);
                expect((err as EOBSTIMEOUT).message).toContain('SlowObserver');
                expect((err as EOBSTIMEOUT).message).toContain('timed out');
                expect((err as EOBSTIMEOUT).message).toContain('50ms');
            }
        });

        it('should re-throw ObserverError as-is', async () => {
            const observer = new ObserverErrorThrower();
            const context = createMockContext();

            try {
                await observer.executeWithTimeout(context);
                expect.unreachable('Should have thrown');
            }
            catch (err) {
                expect(err).toBeInstanceOf(EOBSINVALID);
                expect((err as EOBSINVALID).message).toBe('Validation failed');
                expect((err as EOBSINVALID).field).toBe('test_field');
            }
        });

        it('should wrap generic Error in EOBSERVER', async () => {
            const observer = new GenericErrorThrower();
            const context = createMockContext();

            try {
                await observer.executeWithTimeout(context);
                expect.unreachable('Should have thrown');
            }
            catch (err) {
                expect(err).toBeInstanceOf(EOBSERVER);
                expect((err as EOBSERVER).message).toContain('GenericErrorThrower');
                expect((err as EOBSERVER).message).toContain('Something went wrong');
            }
        });

        it('should wrap non-Error throws in EOBSERVER', async () => {
            const observer = new StringThrower();
            const context = createMockContext();

            try {
                await observer.executeWithTimeout(context);
                expect.unreachable('Should have thrown');
            }
            catch (err) {
                expect(err).toBeInstanceOf(EOBSERVER);
                expect((err as EOBSERVER).message).toContain('StringThrower');
                expect((err as EOBSERVER).message).toContain('String error message');
            }
        });
    });

    // =========================================================================
    // ERROR INHERITANCE TESTS
    // =========================================================================

    describe('error handling', () => {
        it('should preserve ObserverError subclass type', async () => {
            const observer = new ObserverErrorThrower();
            const context = createMockContext();

            try {
                await observer.executeWithTimeout(context);
            }
            catch (err) {
                // Should be the specific subclass, not wrapped
                expect(err).toBeInstanceOf(ObserverError);
                expect(err).toBeInstanceOf(EOBSINVALID);
                expect(err).not.toBeInstanceOf(EOBSERVER);
            }
        });

        it('should include observer name in wrapped errors', async () => {
            const observer = new GenericErrorThrower();
            const context = createMockContext();

            try {
                await observer.executeWithTimeout(context);
            }
            catch (err) {
                expect((err as ObserverError).message).toMatch(/GenericErrorThrower/);
            }
        });

        it('should include timeout duration in timeout errors', async () => {
            const observer = new SlowObserver();
            const context = createMockContext();

            try {
                await observer.executeWithTimeout(context);
            }
            catch (err) {
                expect((err as EOBSTIMEOUT).message).toContain('50ms');
            }
        });
    });

    // =========================================================================
    // EDGE CASES - STUPID USER TESTS
    // =========================================================================

    describe('edge cases', () => {
        it('should handle observer that throws null', async () => {
            class NullThrower extends BaseObserver {
                readonly name = 'NullThrower';
                readonly ring = ObserverRing.InputValidation;
                readonly priority = 10;
                readonly operations: readonly OperationType[] = ['create'];

                async execute(): Promise<void> {
                    throw null;
                }
            }

            const observer = new NullThrower();
            const context = createMockContext();

            try {
                await observer.executeWithTimeout(context);
                expect.unreachable('Should have thrown');
            }
            catch (err) {
                expect(err).toBeInstanceOf(EOBSERVER);
                expect((err as EOBSERVER).message).toContain('NullThrower');
                expect((err as EOBSERVER).message).toContain('null');
            }
        });

        it('should handle observer that throws undefined', async () => {
            class UndefinedThrower extends BaseObserver {
                readonly name = 'UndefinedThrower';
                readonly ring = ObserverRing.InputValidation;
                readonly priority = 10;
                readonly operations: readonly OperationType[] = ['create'];

                async execute(): Promise<void> {
                    throw undefined;
                }
            }

            const observer = new UndefinedThrower();
            const context = createMockContext();

            try {
                await observer.executeWithTimeout(context);
                expect.unreachable('Should have thrown');
            }
            catch (err) {
                expect(err).toBeInstanceOf(EOBSERVER);
                expect((err as EOBSERVER).message).toContain('UndefinedThrower');
            }
        });

        it('should handle observer that throws number', async () => {
            class NumberThrower extends BaseObserver {
                readonly name = 'NumberThrower';
                readonly ring = ObserverRing.InputValidation;
                readonly priority = 10;
                readonly operations: readonly OperationType[] = ['create'];

                async execute(): Promise<void> {
                    throw 42;
                }
            }

            const observer = new NumberThrower();
            const context = createMockContext();

            try {
                await observer.executeWithTimeout(context);
                expect.unreachable('Should have thrown');
            }
            catch (err) {
                expect(err).toBeInstanceOf(EOBSERVER);
                expect((err as EOBSERVER).message).toContain('42');
            }
        });

        it('should handle observer that throws object', async () => {
            class ObjectThrower extends BaseObserver {
                readonly name = 'ObjectThrower';
                readonly ring = ObserverRing.InputValidation;
                readonly priority = 10;
                readonly operations: readonly OperationType[] = ['create'];

                async execute(): Promise<void> {
                    throw { code: 'ERR', detail: 'bad stuff' };
                }
            }

            const observer = new ObjectThrower();
            const context = createMockContext();

            try {
                await observer.executeWithTimeout(context);
                expect.unreachable('Should have thrown');
            }
            catch (err) {
                expect(err).toBeInstanceOf(EOBSERVER);
            }
        });

        it('should handle observer that throws empty string', async () => {
            class EmptyStringThrower extends BaseObserver {
                readonly name = 'EmptyStringThrower';
                readonly ring = ObserverRing.InputValidation;
                readonly priority = 10;
                readonly operations: readonly OperationType[] = ['create'];

                async execute(): Promise<void> {
                    throw '';
                }
            }

            const observer = new EmptyStringThrower();
            const context = createMockContext();

            try {
                await observer.executeWithTimeout(context);
                expect.unreachable('Should have thrown');
            }
            catch (err) {
                expect(err).toBeInstanceOf(EOBSERVER);
            }
        });

        it('should handle concurrent executeWithTimeout calls', async () => {
            const observer = new FastObserver();
            const context = createMockContext();

            // Fire multiple concurrent calls
            const results = await Promise.all([
                observer.executeWithTimeout(context),
                observer.executeWithTimeout(context),
                observer.executeWithTimeout(context),
            ]);

            // All should complete successfully
            expect(results).toHaveLength(3);
            expect(observer.executeCalled).toBe(true);
        });

        it('should handle observer with zero timeout', async () => {
            class ZeroTimeoutObserver extends BaseObserver {
                readonly name = 'ZeroTimeoutObserver';
                readonly ring = ObserverRing.InputValidation;
                readonly priority = 10;
                readonly operations: readonly OperationType[] = ['create'];
                protected override readonly timeout = 0;

                async execute(): Promise<void> {
                    // Even instant execution might lose race with 0ms timeout
                }
            }

            const observer = new ZeroTimeoutObserver();
            const context = createMockContext();

            // With 0ms timeout, behavior is undefined - might timeout or succeed
            // Just verify it doesn't crash
            try {
                await observer.executeWithTimeout(context);
            }
            catch (err) {
                // Timeout is acceptable
                expect(err).toBeInstanceOf(EOBSTIMEOUT);
            }
        });

        it('should handle observer with negative timeout (treated as 0)', async () => {
            class NegativeTimeoutObserver extends BaseObserver {
                readonly name = 'NegativeTimeoutObserver';
                readonly ring = ObserverRing.InputValidation;
                readonly priority = 10;
                readonly operations: readonly OperationType[] = ['create'];
                protected override readonly timeout = -100;

                async execute(): Promise<void> {
                    // Instant
                }
            }

            const observer = new NegativeTimeoutObserver();
            const context = createMockContext();

            // Negative timeout becomes 0 in setTimeout, behavior undefined
            try {
                await observer.executeWithTimeout(context);
            }
            catch (err) {
                expect(err).toBeInstanceOf(EOBSTIMEOUT);
            }
        });

        it('should handle observer with very large timeout', async () => {
            class LargeTimeoutObserver extends BaseObserver {
                readonly name = 'LargeTimeoutObserver';
                readonly ring = ObserverRing.InputValidation;
                readonly priority = 10;
                readonly operations: readonly OperationType[] = ['create'];
                protected override readonly timeout = Number.MAX_SAFE_INTEGER;

                async execute(): Promise<void> {
                    // Instant execution
                }
            }

            const observer = new LargeTimeoutObserver();
            const context = createMockContext();

            // Should complete without issues (no actual timeout wait)
            await observer.executeWithTimeout(context);
        });

        it('should handle observer with empty operations array', () => {
            class EmptyOpsObserver extends BaseObserver {
                readonly name = 'EmptyOpsObserver';
                readonly ring = ObserverRing.InputValidation;
                readonly priority = 10;
                readonly operations: readonly OperationType[] = [];

                async execute(): Promise<void> {}
            }

            const observer = new EmptyOpsObserver();

            expect(observer.operations).toEqual([]);
        });

        it('should handle observer with empty models array', () => {
            class EmptyModelsObserver extends BaseObserver {
                readonly name = 'EmptyModelsObserver';
                readonly ring = ObserverRing.InputValidation;
                readonly priority = 10;
                readonly operations: readonly OperationType[] = ['create'];
                override readonly models: readonly string[] = [];

                async execute(): Promise<void> {}
            }

            const observer = new EmptyModelsObserver();

            expect(observer.models).toEqual([]);
        });

        it('should handle observer with empty name', () => {
            class EmptyNameObserver extends BaseObserver {
                readonly name = '';
                readonly ring = ObserverRing.InputValidation;
                readonly priority = 10;
                readonly operations: readonly OperationType[] = ['create'];

                async execute(): Promise<void> {
                    throw new Error('fail');
                }
            }

            const observer = new EmptyNameObserver();
            const context = createMockContext();

            // Error message should still work with empty name
            expect(observer.executeWithTimeout(context)).rejects.toThrow(EOBSERVER);
        });

        it('should handle observer with special characters in name', async () => {
            class SpecialNameObserver extends BaseObserver {
                readonly name = 'Observer<with>special&chars"quotes\'';
                readonly ring = ObserverRing.InputValidation;
                readonly priority = 10;
                readonly operations: readonly OperationType[] = ['create'];

                async execute(): Promise<void> {
                    throw new Error('fail');
                }
            }

            const observer = new SpecialNameObserver();
            const context = createMockContext();

            try {
                await observer.executeWithTimeout(context);
            }
            catch (err) {
                expect((err as EOBSERVER).message).toContain('Observer<with>special&chars');
            }
        });

        it('should handle observer with unicode name', async () => {
            class UnicodeNameObserver extends BaseObserver {
                readonly name = '观察者🔍émoji';
                readonly ring = ObserverRing.InputValidation;
                readonly priority = 10;
                readonly operations: readonly OperationType[] = ['create'];

                async execute(): Promise<void> {
                    throw new Error('fail');
                }
            }

            const observer = new UnicodeNameObserver();
            const context = createMockContext();

            try {
                await observer.executeWithTimeout(context);
            }
            catch (err) {
                expect((err as EOBSERVER).message).toContain('观察者🔍émoji');
            }
        });

        it('should handle Error with no message', async () => {
            class NoMessageErrorThrower extends BaseObserver {
                readonly name = 'NoMessageErrorThrower';
                readonly ring = ObserverRing.InputValidation;
                readonly priority = 10;
                readonly operations: readonly OperationType[] = ['create'];

                async execute(): Promise<void> {
                    throw new Error();
                }
            }

            const observer = new NoMessageErrorThrower();
            const context = createMockContext();

            try {
                await observer.executeWithTimeout(context);
                expect.unreachable('Should have thrown');
            }
            catch (err) {
                expect(err).toBeInstanceOf(EOBSERVER);
                expect((err as EOBSERVER).message).toContain('NoMessageErrorThrower');
            }
        });
    });
});
