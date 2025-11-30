# Observer System Development Guide

> **Ring-based business logic execution for universal database operation coverage**

The Observer system provides **extensible business logic execution** through a ring-based pipeline that automatically runs for every database operation. This ensures consistent validation, security, audit, and integration without modifying core database code.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Observer Architecture](#observer-architecture)
3. [Ring System](#ring-system)
4. [Directory Structure](#directory-structure)
5. [Creating Observers](#creating-observers)
6. [Async Observers](#async-observers)
7. [Observer Context](#observer-context)
8. [Observer Patterns](#observer-patterns)
9. [Testing Observers](#testing-observers)
10. [Performance Profiling](#performance-profiling)
11. [Best Practices](#best-practices)

## Quick Start

### Create a Simple Validator

```typescript
// src/observers/users/1/email-validator.ts
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { ValidationError } from '@src/lib/observers/errors.js';
import type { ObserverContext } from '@src/lib/observers/interfaces.js';

export default class EmailValidator extends BaseObserver {
    ring = ObserverRing.InputValidation;
    operations = ['create', 'update'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { data } = context;

        for (const record of data) {
            if (record.email && !this.isValidEmail(record.email)) {
                throw new ValidationError('Invalid email format', 'email');
            }
        }
    }

    private isValidEmail(email: string): boolean {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }
}
```

**That's it!** The observer auto-loads at startup and executes for all user operations.

## Observer Architecture

### Core Components

#### **ObserverRunner** (`src/lib/observers/runner.ts`)
- **Ring-Based Execution**: 10 ordered rings (0-9) with selective execution per operation type
- **File-Based Discovery**: Auto-loads observers from `src/observers/:model/:ring/:observer.ts`
- **Universal Coverage**: All database operations automatically run through observer pipeline
- **Model Integration**: Provides Model objects with validation capabilities to all observers

#### **BaseObserver** (`src/lib/observers/base-observer.ts`)
- **executeTry/execute separation**: Comprehensive error handling with pure business logic
- **Model Context**: Access to full Model objects with `model.validateOrThrow()`
- **Consistent Logging**: Built-in timing and execution tracking with nanosecond precision
- **Error Classification**: ValidationError, BusinessLogicError, SystemError for proper handling
- **Timeout Protection**: 5s default timeout for observer execution

#### **BaseAsyncObserver** (`src/lib/observers/base-async-observer.ts`)
- **Non-blocking execution**: Perfect for external APIs, notifications, cache invalidation
- **Error isolation**: Failures logged but don't affect committed database operations
- **Timeout protection**: 10s default timeout for external service operations
- **Transaction safety**: Executes outside transaction context after commit

## Ring System

The observer system executes business logic in **10 ordered rings (0-9)** for every database operation:

```typescript
Ring 0: DataPreparation // Data loading, merging, input preparation
Ring 1: InputValidation // Model validation, format checks, basic integrity
Ring 2: Security        // Access control, protection policies, rate limiting
Ring 3: Business        // Complex business logic, domain rules, workflows
Ring 4: Enrichment      // Data enrichment, defaults, computed fields
Ring 5: Database        // 🎯 SQL EXECUTION
Ring 6: PostDatabase    // Immediate post-database processing
Ring 7: Audit           // Audit logging, change tracking, compliance
Ring 8: Integration     // External APIs, webhooks, cache invalidation (async)
Ring 9: Notification    // User notifications, email alerts, real-time updates (async)
```

### Ring Selection Guidelines

#### **Synchronous Rings (0-5): Blocking Execution**
- **Ring 0 (DataPreparation)**: Record preloading, data merging, input sanitization
- **Ring 1 (InputValidation)**: Type validation, required field checks, constraint validation
- **Ring 2 (Security)**: Access control, soft delete protection, existence validation
- **Ring 3 (Business)**: Complex business rules, domain validation, workflow logic
- **Ring 4 (Enrichment)**: Computed fields, default values, data transformation
- **Ring 5 (Database)**: SQL execution only

#### **Asynchronous Rings (6-9): Non-blocking Execution**
- **Ring 6 (PostDatabase)**: Immediate post-processing that doesn't need external calls
- **Ring 7 (Audit)**: Change tracking, compliance logging (can be async for performance)
- **Ring 8 (Integration)**: External APIs, webhooks, cache clearing, search indexing
- **Ring 9 (Notification)**: Email, push notifications, real-time updates

### Ring Execution Matrix

Different operations execute different rings for optimal performance:

```typescript
select: [0, 1, 5, 8, 9]           // Validation, Security, Database, Integration, Notification
create: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]  // ALL rings
update: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]  // ALL rings
delete: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]  // ALL rings
revert: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]  // ALL rings (undoing soft deletes)
```

## Directory Structure

Observers follow a strict directory pattern for auto-discovery:

```
src/observers/:model/:ring/:observer-name.ts

Examples:
src/observers/all/0/10-record-preloader.ts       # Ring 0: All models, data preparation
src/observers/all/1/50-data-validator.ts  # Ring 1: All models, validation
src/observers/users/1/50-email-validation.ts     # Ring 1: Users model only
src/observers/all/2/50-soft-delete-protector.ts  # Ring 2: All models, security
src/observers/all/5/50-sql-create-observer.ts    # Ring 5: All models, SQL execution
src/observers/all/7/50-change-tracker.ts         # Ring 7: All models, audit
src/observers/all/8/50-webhook-sender.ts         # Ring 8: All models, async integration
```

### Model Targeting

- **Specific model**: `src/observers/users/` → Only applies to "users" model
- **All models**: `src/observers/all/` → Applies to every model
- **Auto-discovery**: Observer system loads all observers at server startup

### Priority System

Observers execute in priority order within each ring (lower numbers first):

```
src/observers/all/0/10-record-preloader.ts   # Priority 10 (executes first)
src/observers/all/0/50-update-merger.ts      # Priority 50 (executes second)
src/observers/all/0/90-sanitizer.ts          # Priority 90 (executes last)
```

**Default priority**: 50 (if not specified in observer class)

## Creating Observers

### Basic Observer Pattern

```typescript
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { ValidationError } from '@src/lib/observers/errors.js';
import type { ObserverContext } from '@src/lib/observers/interfaces.js';

export default class CustomValidator extends BaseObserver {
    ring = ObserverRing.InputValidation;
    operations = ['create', 'update'] as const;
    priority = 50; // Optional: lower numbers execute first

    async execute(context: ObserverContext): Promise<void> {
        const { system, model, data, metadata } = context;

        // Access Model object for validation
        for (const record of data) {
            model.validateOrThrow(record);

            if (!this.isValid(record)) {
                throw new ValidationError('Invalid data', 'field');
            }
        }

        // Record validation metadata for audit
        metadata.set('custom_validation', 'passed');
        console.info('Custom validation completed', {
            modelName: model.model_name,
            recordCount: data.length
        });
    }

    private isValid(record: any): boolean {
        // Custom validation logic
        return true;
    }
}
```

### Operation Targeting

Limit observers to specific operations:

```typescript
export default class PasswordValidator extends BaseObserver {
    ring = ObserverRing.InputValidation;
    operations = ['create', 'update'] as const; // Only run on create/update
    // Will NOT execute on 'delete', 'select', or 'revert' operations
}
```

### Using Preloaded Data (Efficient Pattern)

```typescript
export default class ExistenceValidator extends BaseObserver {
    ring = ObserverRing.Security;
    operations = ['update', 'delete'] as const;

    async execute(context: ObserverContext): Promise<void> {
        // Use preloaded data from RecordPreloader (Ring 0) for efficiency
        const preloadedRecords = context.metadata.get('preloaded_records') || [];

        if (preloadedRecords.length === 0) {
            throw new ValidationError('Records not found');
        }

        // No database query needed - data already loaded!
    }
}
```

## Async Observers

For operations that don't need to block the API response:

```typescript
import { BaseAsyncObserver } from '@src/lib/observers/base-async-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import type { ObserverContext } from '@src/lib/observers/interfaces.js';

export default class WebhookSender extends BaseAsyncObserver {
    ring = ObserverRing.Integration;
    operations = ['create', 'update', 'delete'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { operation, model, result } = context;

        // This executes asynchronously after database commit
        // Failures are logged but don't affect the API response
        try {
            await this.sendWebhook({
                event: `${model.model_name}.${operation}`,
                data: result,
                timestamp: new Date()
            });
        } catch (error) {
            // Error logged automatically by BaseAsyncObserver
            // API response already sent successfully
        }
    }

    private async sendWebhook(payload: any): Promise<void> {
        // External webhook implementation
    }
}
```

### Async Observer Benefits

- ✅ **Faster responses**: External operations don't block API response
- ✅ **Error isolation**: Async failures logged, don't affect committed data
- ✅ **Timeout protection**: 10s default timeout for external service operations
- ✅ **Transaction safety**: Executes outside transaction context after commit

## Observer Context

The `ObserverContext` provides complete access to the operation:

```typescript
interface ObserverContext {
    system: System;                  // Per-request database context
    model: Model;                    // Full Model object with validation
    operation: OperationType;        // create, update, delete, revert, access
    record: ModelRecord;             // Single record being processed
    recordIndex: number;             // Index in batch (for error messages)
    errors: ValidationError[];       // Accumulated validation errors
    warnings: ValidationWarning[];   // Accumulated non-blocking warnings
    startTime: number;               // Request start time for tracking
    currentRing?: ObserverRing;      // Current executing ring (debugging)
    currentObserver?: string;        // Current executing observer (debugging)
}
```

### Cross-Observer Communication

Use the `metadata` Map for sharing computed values between observers:

```typescript
// Ring 0 observer computes and stores value
context.metadata.set('preloaded_records', existingRecords);

// Ring 2 observer retrieves and uses the value
const preloadedRecords = context.metadata.get('preloaded_records');
```

## Observer Patterns

### Data Preparation Pattern (Ring 0)

```typescript
export default class RecordPreloader extends BaseObserver {
    ring = ObserverRing.DataPreparation;
    operations = ['update', 'delete', 'revert'] as const;
    priority = 10; // Execute first in ring

    async execute(context: ObserverContext): Promise<void> {
        const { system, model, data } = context;

        // Preload existing records for efficient access by other observers
        const ids = data.map(record => record.id).filter(Boolean);
        if (ids.length === 0) return;

        const existingRecords = await system.database.selectAny(model.model_name, {
            where: { id: { $in: ids } }
        });

        // Store in context for other observers to use (frozen for safety)
        context.metadata.set('preloaded_records', Object.freeze(existingRecords));
    }
}
```

### Validation Pattern (Ring 1)

```typescript
export default class DataValidator extends BaseObserver {
    ring = ObserverRing.InputValidation;
    operations = ['create', 'update'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { model, data } = context;

        for (const record of data) {
            // Use Model object's built-in validation
            model.validateOrThrow(record);
        }
    }
}
```

### Security Pattern (Ring 2)

```typescript
export default class SoftDeleteProtector extends BaseObserver {
    ring = ObserverRing.Security;
    operations = ['update', 'delete'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const preloadedRecords = context.metadata.get('preloaded_records') || [];

        for (const record of preloadedRecords) {
            if (record.trashed_at || record.deleted_at) {
                throw new SecurityError(
                    `Cannot modify ${record.trashed_at ? 'trashed' : 'deleted'} record`
                );
            }
        }
    }
}
```

### Business Logic Pattern (Ring 3)

```typescript
export default class DuplicateModelChecker extends BaseObserver {
    ring = ObserverRing.Business;
    operations = ['create'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { system, data } = context;

        for (const record of data) {
            const existing = await system.database.selectOne('models', {
                where: { model_name: record.model_name }
            });

            if (existing) {
                throw new BusinessLogicError(
                    `Model '${record.model_name}' already exists`
                );
            }
        }
    }
}
```

### Audit Pattern (Ring 7)

```typescript
export default class ChangeTracker extends BaseObserver {
    ring = ObserverRing.Audit;
    operations = ['create', 'update', 'delete'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { system, operation, model, result } = context;
        const preloadedRecords = context.metadata.get('preloaded_records');

        // Track changes for audit trail
        const changes = this.computeChanges(preloadedRecords, result);

        await system.database.createOne('audit_log', {
            operation,
            model: model.model_name,
            record_id: result?.id,
            changes,
            user_id: system.getUserId(),
            timestamp: new Date().toISOString()
        });
    }

    private computeChanges(existing: any, result: any): any {
        // Compute field-level changes
        return { before: existing, after: result };
    }
}
```

## Testing Observers

### Unit Testing (Recommended)

```typescript
// src/observers/users/1/email-validator.test.ts
import { describe, test, expect } from 'vitest';
import EmailValidator from './email-validator.js';
import { createMockObserverContext } from '@spec/helpers/observer-helpers.js';

describe('EmailValidator Observer', () => {
    test('should validate correct email', async () => {
        const observer = new EmailValidator();
        const context = createMockObserverContext({
            model: 'users',
            operation: 'create',
            data: [{ email: 'test@example.com' }]
        });

        await expect(observer.execute(context)).resolves.not.toThrow();
    });

    test('should throw ValidationError for invalid email', async () => {
        const observer = new EmailValidator();
        const context = createMockObserverContext({
            model: 'users',
            operation: 'create',
            data: [{ email: 'invalid-email' }]
        });

        await expect(observer.execute(context)).rejects.toThrow(ValidationError);
    });
});
```

### Integration Testing (With Database)

```typescript
// spec/integration/observers/observer-pipeline.test.ts
import { describe, test, expect, beforeAll } from 'vitest';
import { createTestContextWithFixture } from '@spec/helpers/test-tenant.js';

describe('Observer Pipeline Integration', () => {
    let testContext: TestContextWithData;

    beforeAll(async () => {
        testContext = await createTestContextWithFixture('testing');
    });

    test('should run complete observer pipeline for user creation', async () => {
        const result = await testContext.database.createOne('users', {
            email: 'test@example.com',
            name: 'Test User'
        });

        // Verify all observers ran successfully
        expect(result.id).toBeDefined();
        expect(result.created_at).toBeDefined();
    });
});
```

## Performance Profiling

### Automatic Performance Monitoring

All observers are automatically tracked with nanosecond precision:

```
[TIME] Observer: RecordPreloader 1.291ms { ring: 0, operation: "update", modelName: "users", status: "success" }
[TIME] Observer: DataValidator 0.090ms { ring: 1, operation: "update", modelName: "users", status: "success" }
[TIME] Observer: SoftDeleteProtector 0.045ms { ring: 2, operation: "update", modelName: "users", status: "success" }
[TIME] Observer: UpdateSqlObserver 3.257ms { ring: 5, operation: "update", modelName: "users", status: "success" }
[TIME] AsyncObserver: CacheInvalidator 1.625ms { ring: 8, operation: "update", status: "success" }
```

### Performance Analysis

- **Bottleneck identification**: Immediately see which observers are slow
- **Ring performance**: Understand time distribution across observer rings
- **Database efficiency**: Monitor SQL operation timing and optimization opportunities
- **Async overhead**: See async observer execution time separately

## Best Practices

### Observer Design
- **Single Responsibility**: Each observer should have one clear purpose
- **Ring Appropriateness**: Choose the right ring for your observer's function
- **Error Handling**: Use appropriate error types (ValidationError, BusinessLogicError, SystemError)
- **Performance**: Use preloaded data when possible, avoid N+1 queries
- **Logging**: Include relevant context in log messages

### Model Integration
- **Use Model Objects**: Access `context.model.validateOrThrow()` for validation
- **System Model Check**: Use `context.model.isSystemModel()` for protection
- **Model Context**: Leverage model information for business logic decisions

### Testing Strategy
- **Unit Tests First**: Test observer logic without database dependencies
- **Integration Tests**: Verify observers work in complete pipeline
- **Mock Context**: Use `createMockObserverContext()` for isolated testing
- **Real Database**: Use `createTestContextWithFixture()` for integration tests

### Performance Optimization
- **Preloading**: Use RecordPreloader results to avoid duplicate queries
- **Batch Operations**: Process multiple records efficiently
- **Async When Possible**: Use BaseAsyncObserver for non-blocking operations
- **Caching**: Cache expensive computations when appropriate
- **Priority Management**: Use priority field to optimize execution order

### Error Classification

Use the correct error type for your use case:

```typescript
import {
    ValidationError,      // Input validation failures (Ring 1)
    BusinessLogicError,   // Business rule violations (Ring 3)
    SecurityError,        // Security policy violations (Ring 2)
    SystemError          // System-level failures
} from '@src/lib/observers/errors.js';

// Validation error
throw new ValidationError('Invalid email format', 'email');

// Business logic error
throw new BusinessLogicError('Insufficient balance for withdrawal');

// Security error
throw new SecurityError('Cannot modify deleted record');

// System error
throw new SystemError('Database connection failed');
```

## Data Integrity Pipeline

The observer system provides complete data integrity protection:

### Phase 1+2 Implementation (Issue #101)

#### **Model Validation (Rings 0-1)**
- **SystemModelProtector**: Prevents data operations on system models
- **DataValidator**: Validates all data against field metadata
- **RequiredFieldsValidator**: Ensures required fields are present

#### **Data Integrity & Business Logic (Rings 0-3)**
- **RecordPreloader** (Ring 0): Efficient single-query preloading of existing records
- **UpdateMerger** (Ring 0): Proper record merging preserving unchanged fields
- **SoftDeleteProtector** (Ring 2): Prevents operations on trashed/deleted records
- **ExistenceValidator** (Ring 2): Validates records exist before operations
- **DuplicateChecker** (Ring 3): Prevents duplicate model/field creation

### Universal Coverage & Performance
- **All models protected**: Every database operation gets validation, security, business logic automatically
- **Single query preloading**: O(1) vs O(N) database calls for multi-record operations
- **Read-only safety**: Frozen preloaded objects prevent accidental mutation
- **Clean SQL transport**: SQL observers (Ring 5) handle pure database operations after validation

## Framework Integration

Observers are **automatically discovered and loaded** at server startup. No manual registration required.

The framework:
1. **Discovers** observers using file path patterns (`src/observers/:model/:ring/:file.ts`)
2. **Validates** observer classes for correct implementation
3. **Caches** observers in memory for performance
4. **Executes** observers in ring order for each operation
5. **Aggregates** errors and warnings across all rings

### Auto-Loading Verification

```bash
# Start server and look for observer loading logs
npm run start:dev

# Look for:
# "✅ Observer loaded: EmailValidator (ring 1, model: users)"
# "✅ Observer loaded: RecordPreloader (ring 0, model: all)"
```

---

## Quick Reference

### Ring Assignment Quick Guide

| Ring | Name | Purpose | Examples |
|------|------|---------|----------|
| 0 | DataPreparation | Load, merge, sanitize | RecordPreloader, UpdateMerger |
| 1 | InputValidation | Model validation | DataValidator, EmailValidator |
| 2 | Security | Access control, protection | SoftDeleteProtector, ExistenceValidator |
| 3 | Business | Business rules | DuplicateChecker, BalanceValidator |
| 4 | Enrichment | Defaults, computed fields | UuidArrayProcessor, DefaultValues |
| 5 | Database | SQL execution | SqlCreateObserver, SqlUpdateObserver |
| 6 | PostDatabase | Immediate post-processing | DDL operations |
| 7 | Audit | Change tracking | ChangeTracker, HistoryTracker |
| 8 | Integration | External APIs, cache | WebhookSender, CacheInvalidator |
| 9 | Notification | Notifications, alerts | EmailNotifier, PushNotifier |

### Common Patterns

```typescript
// Validation (Ring 1)
throw new ValidationError('Invalid format', 'field_name');

// Security check (Ring 2)
if (record.deleted_at) throw new SecurityError('Cannot modify deleted record');

// Business logic (Ring 3)
if (balance < 0) throw new BusinessLogicError('Insufficient balance');

// Cross-observer data sharing
context.metadata.set('key', value);
const value = context.metadata.get('key');

// Use preloaded data (efficient)
const records = context.metadata.get('preloaded_records');

// Model validation
context.model.validateOrThrow(record);
```

---

For complete API documentation and advanced patterns, see the existing observers in `src/observers/all/` and their corresponding implementations.
