# Phase 1: Foundation - Observer Infrastructure

## Status: IMPLEMENTED

Implementation completed 2024-12. See `src/model/observers/` and `spec/model/observers/`.

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

## Implementation Notes

### Location Change

Originally planned for `src/db/observers/`. Implemented at `src/model/observers/` to avoid confusion with VFS (which is itself the "database" layer). The observer system is part of the Model abstraction, not a separate DB layer.

### Error Naming

Errors use `EOBS*` prefix to match kernel error conventions and avoid collision with HAL errors:

| Error | errno | Purpose |
|-------|-------|---------|
| `EOBSINVALID` | 1001 | Validation failure |
| `EOBSFROZEN` | 1002 | Model is frozen |
| `EOBSIMMUT` | 1003 | Field is immutable |
| `EOBSSEC` | 1010 | Security violation |
| `EOBSBUS` | 1020 | Business rule |
| `EOBSSYS` | 1030 | System/database |
| `EOBSTIMEOUT` | 1031 | Observer timeout |
| `EOBSERVER` | 1032 | Generic failure |

### Operation Types

Simplified to three core operations:
- `create` - INSERT
- `update` - UPDATE
- `delete` - soft DELETE

Future: May add `revert` (undo soft-delete) and `expire` (hard delete).

## Directory Structure

```
src/model/observers/
├── types.ts           # ObserverRing enum, OperationType, ObserverResult
├── errors.ts          # EOBS* error classes
├── interfaces.ts      # Observer, ObserverContext, Model, ModelRecord
├── base-observer.ts   # Abstract base with timeout handling
├── runner.ts          # Ring execution engine
├── registry.ts        # Observer registration factory
├── index.ts           # Public exports
└── impl/              # Observer implementations (Phase 4)
```

## Key Types

### ObserverRing (`types.ts`)

```typescript
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
```

### Observer Interface (`interfaces.ts`)

```typescript
export interface Observer {
    readonly name: string;
    readonly ring: ObserverRing;
    readonly priority: number;  // Lower = runs first
    readonly operations: readonly OperationType[];
    readonly models?: readonly string[];  // Empty/undefined = all models

    execute(context: ObserverContext): Promise<void>;
}
```

### ObserverContext (`interfaces.ts`)

```typescript
export interface ObserverContext {
    readonly system: SystemContext;
    readonly operation: OperationType;
    readonly model: Model;
    readonly record: ModelRecord;
    readonly recordIndex: number;
    readonly errors: EOBSINVALID[];  // Ring 1 accumulates here
    readonly warnings: string[];
}
```

### Error Classes (`errors.ts`)

```typescript
// Base class
export class ObserverError extends Error {
    readonly code: string;
    readonly errno: number;
}

// Specific errors
export class EOBSINVALID extends ObserverError { /* errno 1001, field?: string */ }
export class EOBSFROZEN extends ObserverError { /* errno 1002 */ }
export class EOBSIMMUT extends ObserverError { /* errno 1003, field?: string */ }
export class EOBSSEC extends ObserverError { /* errno 1010 */ }
export class EOBSBUS extends ObserverError { /* errno 1020 */ }
export class EOBSSYS extends ObserverError { /* errno 1030 */ }
export class EOBSTIMEOUT extends ObserverError { /* errno 1031 */ }
export class EOBSERVER extends ObserverError { /* errno 1032 */ }
```

## Usage

### Creating an Observer

```typescript
import { BaseObserver, ObserverRing, type ObserverContext } from '@src/model/observers/index.js';

export class MyValidator extends BaseObserver {
    readonly name = 'MyValidator';
    readonly ring = ObserverRing.InputValidation;
    readonly priority = 50;
    readonly operations = ['create', 'update'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const value = context.record.get('my_field');
        if (!value) {
            throw new EOBSINVALID('my_field is required', 'my_field');
        }
    }
}
```

### Running the Pipeline

```typescript
import { createObserverRunner } from '@src/model/observers/index.js';

const runner = createObserverRunner();
runner.register(new MyValidator());

const results = await runner.run(context);
```

## Tests

48 tests in `spec/model/observers/`:
- `errors.test.ts` - Error class construction, codes, helpers
- `runner.test.ts` - Registration, execution order, error handling

```bash
bun test spec/model/observers/
```

## Acceptance Criteria

- [x] Can define observer with ring, priority, operations
- [x] Runner executes observers in ring order (0-9)
- [x] Priority respected within each ring
- [x] Operation filtering works (create/update/delete)
- [x] Model filtering works (specific models vs all)
- [x] Errors in Ring 1 accumulate, others stop execution
- [x] Timeout prevents runaway observers (via BaseObserver)
- [x] Results track duration and any errors
- [x] Error classes follow kernel naming (EOBS*)

## Next Phase

Proceed to [Phase 2: Schema](./02-schema.md) to define the models/fields tables.
