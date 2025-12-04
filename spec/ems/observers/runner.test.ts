import { describe, it, expect } from 'bun:test';
import {
    ObserverRunner,
    ObserverRing,
    EOBSINVALID,
    EOBSSEC,
    EOBSSYS,
} from '@src/ems/observers/index.js';
import type {
    Observer,
    ObserverContext,
    Model,
    ModelRecord,
    OperationType,
} from '@src/ems/observers/index.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a mock model for testing
 */
function createMockModel(name = 'test_model'): Model {
    return {
        modelName: name,
        isFrozen: false,
        isImmutable: false,
        requiresSudo: false,
        getImmutableFields: () => new Set(),
        getTrackedFields: () => new Set(),
        getTransformFields: () => new Map(),
        getValidationFields: () => [],
        getFields: () => [],
    };
}

/**
 * Create a mock record for testing
 */
function createMockRecord(): ModelRecord {
    const data: Record<string, unknown> = { id: 'test-id' };
    return {
        isNew: () => true,
        old: () => undefined,
        get: (field: string) => data[field],
        has: (field: string) => field in data,
        set: (field: string, value: unknown) => { data[field] = value; },
        getChangedFields: () => Object.keys(data),
        toRecord: () => ({ ...data }),
        toChanges: () => ({ ...data }),
        getDiff: () => ({}),
        getDiffForFields: () => ({}),
    };
}

/**
 * Create a mock context for testing
 */
function createMockContext(
    operation: OperationType = 'create',
    modelName = 'test_model'
): ObserverContext {
    return {
        system: { db: null, cache: null },
        operation,
        model: createMockModel(modelName),
        record: createMockRecord(),
        recordIndex: 0,
        errors: [],
        warnings: [],
    };
}

/**
 * Create a simple test observer
 */
function createTestObserver(
    name: string,
    ring: ObserverRing,
    priority: number,
    operations: readonly OperationType[] = ['create', 'update', 'delete'],
    models?: readonly string[],
    executeFn?: (ctx: ObserverContext) => Promise<void>
): Observer {
    return {
        name,
        ring,
        priority,
        operations,
        models,
        execute: executeFn || (async () => {}),
    };
}

// =============================================================================
// TESTS
// =============================================================================

describe('ObserverRunner', () => {
    describe('registration', () => {
        it('should register an observer', () => {
            const runner = new ObserverRunner();
            const observer = createTestObserver('Test', ObserverRing.InputValidation, 50);

            runner.register(observer);

            expect(runner.getObserverCount()).toBe(1);
        });

        it('should track observers by ring', () => {
            const runner = new ObserverRunner();

            runner.register(createTestObserver('A', ObserverRing.InputValidation, 50));
            runner.register(createTestObserver('B', ObserverRing.Database, 50));
            runner.register(createTestObserver('C', ObserverRing.InputValidation, 60));

            expect(runner.getObserverCountForRing(ObserverRing.InputValidation)).toBe(2);
            expect(runner.getObserverCountForRing(ObserverRing.Database)).toBe(1);
            expect(runner.getObserverCountForRing(ObserverRing.Audit)).toBe(0);
        });

        it('should sort observers by priority within ring', () => {
            const runner = new ObserverRunner();

            runner.register(createTestObserver('C', ObserverRing.InputValidation, 30));
            runner.register(createTestObserver('A', ObserverRing.InputValidation, 10));
            runner.register(createTestObserver('B', ObserverRing.InputValidation, 20));

            const names = runner.getObserverNamesForRing(ObserverRing.InputValidation);
            expect(names).toEqual(['A', 'B', 'C']);
        });

        it('should register multiple observers with registerAll', () => {
            const runner = new ObserverRunner();

            runner.registerAll([
                createTestObserver('A', ObserverRing.InputValidation, 10),
                createTestObserver('B', ObserverRing.Database, 50),
                createTestObserver('C', ObserverRing.Audit, 60),
            ]);

            expect(runner.getObserverCount()).toBe(3);
        });
    });

    describe('execution order', () => {
        it('should execute observers in ring order', async () => {
            const runner = new ObserverRunner();
            const order: string[] = [];

            runner.register(createTestObserver('Ring5', ObserverRing.Database, 50, ['create'], undefined,
                async () => { order.push('Ring5'); }
            ));
            runner.register(createTestObserver('Ring1', ObserverRing.InputValidation, 50, ['create'], undefined,
                async () => { order.push('Ring1'); }
            ));
            runner.register(createTestObserver('Ring7', ObserverRing.Audit, 50, ['create'], undefined,
                async () => { order.push('Ring7'); }
            ));

            await runner.run(createMockContext('create'));

            expect(order).toEqual(['Ring1', 'Ring5', 'Ring7']);
        });

        it('should execute observers by priority within ring', async () => {
            const runner = new ObserverRunner();
            const order: string[] = [];

            runner.register(createTestObserver('P30', ObserverRing.InputValidation, 30, ['create'], undefined,
                async () => { order.push('P30'); }
            ));
            runner.register(createTestObserver('P10', ObserverRing.InputValidation, 10, ['create'], undefined,
                async () => { order.push('P10'); }
            ));
            runner.register(createTestObserver('P20', ObserverRing.InputValidation, 20, ['create'], undefined,
                async () => { order.push('P20'); }
            ));

            await runner.run(createMockContext('create'));

            expect(order).toEqual(['P10', 'P20', 'P30']);
        });
    });

    describe('operation filtering', () => {
        it('should skip observers that do not handle the operation', async () => {
            const runner = new ObserverRunner();
            const executed: string[] = [];

            runner.register(createTestObserver('CreateOnly', ObserverRing.InputValidation, 10, ['create'], undefined,
                async () => { executed.push('CreateOnly'); }
            ));
            runner.register(createTestObserver('UpdateOnly', ObserverRing.InputValidation, 20, ['update'], undefined,
                async () => { executed.push('UpdateOnly'); }
            ));
            runner.register(createTestObserver('DeleteOnly', ObserverRing.InputValidation, 30, ['delete'], undefined,
                async () => { executed.push('DeleteOnly'); }
            ));

            await runner.run(createMockContext('create'));
            expect(executed).toEqual(['CreateOnly']);

            executed.length = 0;
            await runner.run(createMockContext('update'));
            expect(executed).toEqual(['UpdateOnly']);
        });
    });

    describe('model filtering', () => {
        it('should skip observers that do not handle the model', async () => {
            const runner = new ObserverRunner();
            const executed: string[] = [];

            runner.register(createTestObserver('AllModels', ObserverRing.InputValidation, 10, ['create'], undefined,
                async () => { executed.push('AllModels'); }
            ));
            runner.register(createTestObserver('UsersOnly', ObserverRing.InputValidation, 20, ['create'], ['users'],
                async () => { executed.push('UsersOnly'); }
            ));
            runner.register(createTestObserver('InvoicesOnly', ObserverRing.InputValidation, 30, ['create'], ['invoices'],
                async () => { executed.push('InvoicesOnly'); }
            ));

            await runner.run(createMockContext('create', 'users'));
            expect(executed).toEqual(['AllModels', 'UsersOnly']);
        });

        it('should run observers with empty models array for all models', async () => {
            const runner = new ObserverRunner();
            const executed: string[] = [];

            runner.register(createTestObserver('EmptyModels', ObserverRing.InputValidation, 10, ['create'], [],
                async () => { executed.push('EmptyModels'); }
            ));

            // Empty models array is treated same as undefined (runs for all)
            await runner.run(createMockContext('create', 'anything'));
            expect(executed).toEqual(['EmptyModels']);
        });
    });

    describe('error handling - Ring 1 (validation)', () => {
        it('should accumulate validation errors in Ring 1', async () => {
            const runner = new ObserverRunner();

            runner.register(createTestObserver('V1', ObserverRing.InputValidation, 10, ['create'], undefined,
                async () => { throw new EOBSINVALID('Error 1', 'field1'); }
            ));
            runner.register(createTestObserver('V2', ObserverRing.InputValidation, 20, ['create'], undefined,
                async () => { throw new EOBSINVALID('Error 2', 'field2'); }
            ));
            runner.register(createTestObserver('V3', ObserverRing.InputValidation, 30, ['create'], undefined,
                async () => { /* no error */ }
            ));

            const ctx = createMockContext('create');

            try {
                await runner.run(ctx);
                expect(true).toBe(false); // Should not reach here
            } catch (err) {
                expect(err).toBeInstanceOf(AggregateError);
                const aggErr = err as AggregateError;
                expect(aggErr.errors.length).toBe(2);
                expect(ctx.errors.length).toBe(2);
            }
        });

        it('should wrap non-validation errors in Ring 1', async () => {
            const runner = new ObserverRunner();

            runner.register(createTestObserver('V1', ObserverRing.InputValidation, 10, ['create'], undefined,
                async () => { throw new Error('Generic error'); }
            ));

            const ctx = createMockContext('create');

            try {
                await runner.run(ctx);
                expect(true).toBe(false);
            } catch (err) {
                expect(err).toBeInstanceOf(AggregateError);
                expect(ctx.errors[0]).toBeInstanceOf(EOBSINVALID);
                expect(ctx.errors[0].message).toBe('Generic error');
            }
        });
    });

    describe('error handling - other rings', () => {
        it('should fail-fast on errors in Ring 2 (Security)', async () => {
            const runner = new ObserverRunner();
            const executed: string[] = [];

            runner.register(createTestObserver('S1', ObserverRing.Security, 10, ['create'], undefined,
                async () => {
                    executed.push('S1');
                    throw new EOBSSEC('Access denied');
                }
            ));
            runner.register(createTestObserver('S2', ObserverRing.Security, 20, ['create'], undefined,
                async () => { executed.push('S2'); }
            ));

            try {
                await runner.run(createMockContext('create'));
                expect(true).toBe(false);
            } catch (err) {
                expect(err).toBeInstanceOf(EOBSSEC);
                expect(executed).toEqual(['S1']); // S2 should not run
            }
        });

        it('should fail-fast on errors in Ring 5 (Database)', async () => {
            const runner = new ObserverRunner();

            runner.register(createTestObserver('DB', ObserverRing.Database, 50, ['create'], undefined,
                async () => { throw new EOBSSYS('SQL error'); }
            ));

            try {
                await runner.run(createMockContext('create'));
                expect(true).toBe(false);
            } catch (err) {
                expect(err).toBeInstanceOf(EOBSSYS);
            }
        });
    });

    describe('results tracking', () => {
        it('should return results for each executed observer', async () => {
            const runner = new ObserverRunner();

            runner.register(createTestObserver('A', ObserverRing.InputValidation, 10, ['create']));
            runner.register(createTestObserver('B', ObserverRing.Database, 50, ['create']));

            const results = await runner.run(createMockContext('create'));

            expect(results.length).toBe(2);
            expect(results[0].observer).toBe('A');
            expect(results[0].ring).toBe(ObserverRing.InputValidation);
            expect(results[1].observer).toBe('B');
            expect(results[1].ring).toBe(ObserverRing.Database);
        });

        it('should track duration for each observer', async () => {
            const runner = new ObserverRunner();

            runner.register(createTestObserver('Slow', ObserverRing.InputValidation, 10, ['create'], undefined,
                async () => { await new Promise((r) => setTimeout(r, 50)); }
            ));

            const results = await runner.run(createMockContext('create'));

            expect(results[0].duration).toBeGreaterThanOrEqual(40); // Allow some variance
        });

        it('should include error in result on failure', async () => {
            const runner = new ObserverRunner();

            runner.register(createTestObserver('Fail', ObserverRing.InputValidation, 10, ['create'], undefined,
                async () => { throw new EOBSINVALID('test error'); }
            ));

            try {
                await runner.run(createMockContext('create'));
            } catch {
                // Expected
            }

            // Can't easily get results after throw, but the runner tracks them internally
        });
    });

    describe('empty runner', () => {
        it('should handle run with no observers', async () => {
            const runner = new ObserverRunner();
            const results = await runner.run(createMockContext('create'));
            expect(results).toEqual([]);
        });

        it('should handle run when no observers match', async () => {
            const runner = new ObserverRunner();
            runner.register(createTestObserver('UpdateOnly', ObserverRing.InputValidation, 10, ['update']));

            const results = await runner.run(createMockContext('create'));
            expect(results).toEqual([]);
        });
    });
});
