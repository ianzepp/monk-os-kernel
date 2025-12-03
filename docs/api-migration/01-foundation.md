# Phase 1: Foundation - Observer Infrastructure

## Overview

The observer pipeline is the core enforcement mechanism. All mutations flow through a 10-ring pipeline where each ring has a specific semantic purpose. Observers intercept operations and can validate, transform, reject, or augment data.

## Ring System

```
Ring 0: Data Preparation     - Merge input with existing data
Ring 1: Input Validation     - Type checking, constraints, required fields
Ring 2: Security             - Existence checks, soft-delete protection
Ring 3: Business Logic       - Custom business rules
Ring 4: Enrichment           - Auto-transforms, computed fields
Ring 5: Database             - Actual SQL execution
Ring 6: Post-Database        - DDL for schema changes
Ring 7: Audit                - Change tracking, logging
Ring 8: Integration          - Cache invalidation, webhooks
Ring 9: Notification         - Events, triggers
```

## Files to Port

### 1. Observer Types (`src/db/observers/types.ts`)

**Source:** `monk-api/src/lib/observers/types.ts`

```typescript
/**
 * Observer ring assignments
 */
export enum ObserverRing {
    DataPreparation = 0,
    InputValidation = 1,
    Security = 2,
    BusinessLogic = 3,
    Enrichment = 4,
    Database = 5,
    PostDatabase = 6,
    Audit = 7,
    Integration = 8,
    Notification = 9,
}

/**
 * Operations that can be observed
 */
export type OperationType =
    | 'create'
    | 'update'
    | 'delete'
    | 'revert'
    | 'expire'
    | 'access';

/**
 * Result of observer execution
 */
export interface ObserverResult {
    observer: string;
    ring: ObserverRing;
    duration: number;
    error?: Error;
    warnings?: string[];
}
```

**Simplifications for OS:**
- Remove PostgreSQL-specific operations if not needed
- Can reduce to create/update/delete initially

### 2. Observer Interfaces (`src/db/observers/interfaces.ts`)

**Source:** `monk-api/src/lib/observers/interfaces.ts`

```typescript
import type { Model } from '../model';
import type { ModelRecord } from '../model-record';
import type { ObserverRing, OperationType } from './types';

/**
 * Context passed to each observer
 */
export interface ObserverContext {
    // System access
    system: SystemContext;

    // Operation details
    operation: OperationType;
    model: Model;

    // Record being processed
    record: ModelRecord;
    recordIndex: number;  // Position in batch

    // Accumulated state
    errors: ValidationError[];
    warnings: string[];
}

/**
 * Observer contract
 */
export interface Observer {
    readonly name: string;
    readonly ring: ObserverRing;
    readonly priority: number;  // Lower = runs first within ring
    readonly operations: readonly OperationType[];
    readonly models?: readonly string[];  // Empty = all models

    execute(context: ObserverContext): Promise<void>;
}

/**
 * System context for database access
 */
export interface SystemContext {
    database: Database;
    cache: ModelCache;
    // Add other system services as needed
}
```

**Key Points:**
- `ObserverContext` carries everything an observer needs
- Observers declare which rings/operations/models they handle
- `priority` orders execution within a ring

### 3. Observer Errors (`src/db/observers/errors.ts`)

**Source:** `monk-api/src/lib/observers/errors.ts`

```typescript
/**
 * Base class for observer errors
 */
export class ObserverError extends Error {
    constructor(
        message: string,
        public readonly code: string = 'OBSERVER_ERROR'
    ) {
        super(message);
        this.name = 'ObserverError';
    }
}

/**
 * Validation failures (Ring 1)
 */
export class ValidationError extends ObserverError {
    constructor(
        message: string,
        public readonly field?: string,
        code: string = 'VALIDATION_ERROR'
    ) {
        super(message, code);
        this.name = 'ValidationError';
    }
}

/**
 * Security violations (Ring 2)
 */
export class SecurityError extends ObserverError {
    constructor(
        message: string,
        code: string = 'SECURITY_ERROR'
    ) {
        super(message, code);
        this.name = 'SecurityError';
    }
}

/**
 * Business logic failures (Ring 3)
 */
export class BusinessLogicError extends ObserverError {
    constructor(
        message: string,
        code: string = 'BUSINESS_LOGIC_ERROR'
    ) {
        super(message, code);
        this.name = 'BusinessLogicError';
    }
}

/**
 * System/database errors (Ring 5+)
 */
export class SystemError extends ObserverError {
    constructor(
        message: string,
        code: string = 'SYSTEM_ERROR'
    ) {
        super(message, code);
        this.name = 'SystemError';
    }
}
```

### 4. Base Observer (`src/db/observers/base-observer.ts`)

**Source:** `monk-api/src/lib/observers/base-observer.ts`

```typescript
import type { Observer, ObserverContext } from './interfaces';
import type { ObserverRing, OperationType } from './types';

/**
 * Abstract base class for observers
 *
 * Provides common patterns:
 * - Timeout handling
 * - Error wrapping
 * - Logging
 */
export abstract class BaseObserver implements Observer {
    abstract readonly name: string;
    abstract readonly ring: ObserverRing;
    abstract readonly priority: number;
    abstract readonly operations: readonly OperationType[];
    readonly models?: readonly string[];

    /**
     * Timeout for observer execution (ms)
     */
    protected readonly timeout: number = 5000;

    /**
     * Main entry point - wraps execute with error handling
     */
    async executeTry(context: ObserverContext): Promise<void> {
        const start = Date.now();

        try {
            await Promise.race([
                this.execute(context),
                this.timeoutPromise(),
            ]);
        } catch (error) {
            console.error(`Observer ${this.name} failed`, {
                ring: this.ring,
                operation: context.operation,
                model: context.model.model_name,
                duration: Date.now() - start,
                error,
            });
            throw error;
        }
    }

    /**
     * Override in subclasses to implement logic
     */
    abstract execute(context: ObserverContext): Promise<void>;

    private timeoutPromise(): Promise<never> {
        return new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Observer ${this.name} timed out after ${this.timeout}ms`));
            }, this.timeout);
        });
    }
}
```

### 5. Observer Runner (`src/db/observers/runner.ts`)

**Source:** `monk-api/src/lib/observers/runner.ts`

```typescript
import type { Observer, ObserverContext } from './interfaces';
import type { ObserverRing, OperationType, ObserverResult } from './types';

/**
 * Executes observers in ring order
 */
export class ObserverRunner {
    private observers: Map<ObserverRing, Observer[]> = new Map();

    /**
     * Register an observer
     */
    register(observer: Observer): void {
        const ring = observer.ring;
        if (!this.observers.has(ring)) {
            this.observers.set(ring, []);
        }

        const ringObservers = this.observers.get(ring)!;
        ringObservers.push(observer);

        // Sort by priority within ring
        ringObservers.sort((a, b) => a.priority - b.priority);
    }

    /**
     * Execute all applicable observers for an operation
     */
    async run(context: ObserverContext): Promise<ObserverResult[]> {
        const results: ObserverResult[] = [];

        // Execute rings 0-9 in order
        for (let ring = 0; ring <= 9; ring++) {
            const ringObservers = this.observers.get(ring as ObserverRing) || [];

            for (const observer of ringObservers) {
                // Skip if observer doesn't handle this operation
                if (!observer.operations.includes(context.operation)) {
                    continue;
                }

                // Skip if observer is model-specific and doesn't match
                if (observer.models?.length &&
                    !observer.models.includes(context.model.model_name)) {
                    continue;
                }

                const start = Date.now();

                try {
                    await observer.execute(context);

                    results.push({
                        observer: observer.name,
                        ring: observer.ring,
                        duration: Date.now() - start,
                    });
                } catch (error) {
                    results.push({
                        observer: observer.name,
                        ring: observer.ring,
                        duration: Date.now() - start,
                        error: error as Error,
                    });

                    // Validation errors in Ring 1 can accumulate
                    // Other errors should stop execution
                    if (ring !== 1) {
                        throw error;
                    }

                    context.errors.push(error as any);
                }
            }
        }

        // After all rings, check for accumulated validation errors
        if (context.errors.length > 0) {
            throw new AggregateError(
                context.errors,
                `Validation failed with ${context.errors.length} error(s)`
            );
        }

        return results;
    }
}
```

### 6. Observer Registry (`src/db/observers/registry.ts`)

**Source:** `monk-api/src/observers/registry.ts`

```typescript
import { ObserverRunner } from './runner';

// Import observers
import UpdateMerger from './impl/update-merger';
import DataValidator from './impl/data-validator';
import ImmutableValidator from './impl/immutable-validator';
import FrozenValidator from './impl/frozen-validator';
import SqlCreate from './impl/sql-create';
import SqlUpdate from './impl/sql-update';
import SqlDelete from './impl/sql-delete';
import Tracked from './impl/tracked';
// ... more observers

/**
 * Create and configure observer runner with all observers
 */
export function createObserverRunner(): ObserverRunner {
    const runner = new ObserverRunner();

    // Ring 0: Data Preparation
    runner.register(new UpdateMerger());

    // Ring 1: Input Validation
    runner.register(new FrozenValidator());
    runner.register(new ImmutableValidator());
    runner.register(new DataValidator());

    // Ring 5: Database
    runner.register(new SqlCreate());
    runner.register(new SqlUpdate());
    runner.register(new SqlDelete());

    // Ring 7: Audit
    runner.register(new Tracked());

    // ... register more

    return runner;
}
```

## Directory Structure

```
src/db/
├── observers/
│   ├── types.ts           # Ring enum, operation types
│   ├── interfaces.ts      # Observer, ObserverContext
│   ├── errors.ts          # ValidationError, SecurityError, etc.
│   ├── base-observer.ts   # Abstract base class
│   ├── runner.ts          # Ring execution engine
│   ├── registry.ts        # Observer registration
│   └── impl/              # Observer implementations (Phase 4)
│       ├── update-merger.ts
│       ├── data-validator.ts
│       ├── immutable-validator.ts
│       └── ...
```

## Testing Strategy

```typescript
import { describe, it, expect } from 'bun:test';
import { ObserverRunner } from './runner';
import { ObserverRing } from './types';

describe('ObserverRunner', () => {
    it('executes observers in ring order', async () => {
        const runner = new ObserverRunner();
        const order: number[] = [];

        // Register observers in reverse order
        runner.register({
            name: 'ring5',
            ring: ObserverRing.Database,
            priority: 50,
            operations: ['create'],
            execute: async () => { order.push(5); },
        });

        runner.register({
            name: 'ring1',
            ring: ObserverRing.InputValidation,
            priority: 50,
            operations: ['create'],
            execute: async () => { order.push(1); },
        });

        await runner.run(mockContext);

        expect(order).toEqual([1, 5]);  // Ring order preserved
    });

    it('respects priority within ring', async () => {
        const runner = new ObserverRunner();
        const order: string[] = [];

        runner.register({
            name: 'low-priority',
            ring: ObserverRing.InputValidation,
            priority: 100,
            operations: ['create'],
            execute: async () => { order.push('low'); },
        });

        runner.register({
            name: 'high-priority',
            ring: ObserverRing.InputValidation,
            priority: 10,
            operations: ['create'],
            execute: async () => { order.push('high'); },
        });

        await runner.run(mockContext);

        expect(order).toEqual(['high', 'low']);
    });
});
```

## Acceptance Criteria

- [ ] Can define observer with ring, priority, operations
- [ ] Runner executes observers in ring order (0-9)
- [ ] Priority respected within each ring
- [ ] Operation filtering works (create/update/delete)
- [ ] Model filtering works (specific models vs all)
- [ ] Errors in Ring 1 accumulate, others stop execution
- [ ] Timeout prevents runaway observers
- [ ] Results track duration and any errors

## Next Phase

Once foundation is complete, proceed to [Phase 2: Schema](./02-schema.md) to define the models/fields tables.
