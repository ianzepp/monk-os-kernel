/**
 * Observer Pipeline - Registry
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The registry is the central point for observer registration. It provides
 * a factory function that creates a fully-configured ObserverRunner with
 * all standard observers registered.
 *
 * Observer registration is organized by ring for clarity:
 * - Ring 0: Data preparation (merge, defaults)
 * - Ring 1: Input validation (type, constraints, required)
 * - Ring 2: Security (permissions, existence)
 * - Ring 3: Business logic (custom rules)
 * - Ring 4: Enrichment (transforms, computed fields)
 * - Ring 5: Database (SQL execution)
 * - Ring 6: Post-database (DDL)
 * - Ring 7: Audit (change tracking)
 * - Ring 8: Integration (cache, webhooks)
 * - Ring 9: Notification (events)
 *
 * USAGE
 * =====
 * ```typescript
 * import { createObserverRunner } from './registry.js';
 *
 * const runner = createObserverRunner();
 * await runner.run(context);
 * ```
 *
 * EXTENSIBILITY
 * =============
 * Applications can register additional observers after creation:
 * ```typescript
 * const runner = createObserverRunner();
 * runner.register(new MyCustomObserver());
 * ```
 *
 * @module model/observers/registry
 */

import { ObserverRunner } from './runner.js';

// Re-export ObserverRunner for consumers that import from registry
export { ObserverRunner } from './runner.js';

// =============================================================================
// OBSERVER IMPORTS
// =============================================================================

// Ring 0: Data Preparation
import { UpdateMerger } from '../ring/0/index.js';

// Ring 1: Input Validation
import { Frozen, Immutable, Constraints } from '../ring/1/index.js';

// Ring 4: Enrichment
import { TransformProcessor } from '../ring/4/index.js';

// Ring 5: Database Operations
import { SqlCreate, SqlUpdate, SqlDelete, PathnameSync } from '../ring/5/index.js';

// Ring 6: Post-Database (DDL)
import { DdlCreateModel, DdlCreateField } from '../ring/6/index.js';

// Ring 7: Audit
import { Tracked } from '../ring/7/index.js';

// Ring 8: Integration
import { Cache, EntityCacheSync } from '../ring/8/index.js';

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create and configure observer runner with standard observers.
 *
 * WHY factory function: Ensures each caller gets a fresh runner instance.
 * Runners could theoretically be shared (observers are stateless), but
 * separate instances allow different configurations for testing.
 *
 * Currently registered observers:
 * - Ring 0: UpdateMerger (data preparation)
 * - Ring 1: Frozen, Immutable, Constraints (input validation)
 * - Ring 4: TransformProcessor (enrichment)
 * - Ring 5: SqlCreate, SqlUpdate, SqlDelete, PathnameSync (database operations)
 * - Ring 6: DdlCreateModel, DdlCreateField (schema management)
 * - Ring 7: Tracked (audit)
 * - Ring 8: Cache (model cache invalidation)
 * - Ring 8: EntityCacheSync (entity cache sync)
 *
 * @returns Configured ObserverRunner
 */
export function createObserverRunner(): ObserverRunner {
    const runner = new ObserverRunner();

    // =========================================================================
    // RING 0: DATA PREPARATION
    // =========================================================================
    runner.register(new UpdateMerger());

    // =========================================================================
    // RING 1: INPUT VALIDATION
    // =========================================================================
    runner.register(new Frozen());
    runner.register(new Immutable());
    runner.register(new Constraints());

    // =========================================================================
    // RING 2: SECURITY
    // =========================================================================
    // Phase 4: (future observers)

    // =========================================================================
    // RING 3: BUSINESS LOGIC
    // =========================================================================
    // Application-specific observers registered separately

    // =========================================================================
    // RING 4: ENRICHMENT
    // =========================================================================
    runner.register(new TransformProcessor());

    // =========================================================================
    // RING 5: DATABASE
    // =========================================================================
    runner.register(new SqlCreate());
    runner.register(new SqlUpdate());
    runner.register(new SqlDelete());
    runner.register(new PathnameSync());

    // =========================================================================
    // RING 6: POST-DATABASE (DDL)
    // =========================================================================
    runner.register(new DdlCreateModel());
    runner.register(new DdlCreateField());

    // =========================================================================
    // RING 7: AUDIT
    // =========================================================================
    runner.register(new Tracked());

    // =========================================================================
    // RING 8: INTEGRATION
    // =========================================================================
    runner.register(new Cache());
    runner.register(new EntityCacheSync());

    // =========================================================================
    // RING 9: NOTIFICATION
    // =========================================================================
    // Application-specific observers registered separately

    return runner;
}
