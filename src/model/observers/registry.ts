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

// =============================================================================
// OBSERVER IMPORTS
// =============================================================================

// Ring 1: Input Validation
import { Frozen, Immutable, Constraints } from '../ring/1/index.js';

// Ring 5: Database Operations
import { SqlCreate, SqlUpdate, SqlDelete } from '../ring/5/index.js';

// Ring 6: Post-Database (DDL)
import { DdlCreateModel, DdlCreateField } from '../ring/6/index.js';

// Ring 8: Integration
import { Cache } from '../ring/8/index.js';

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
 * - Ring 1: Frozen, Immutable, Constraints (input validation)
 * - Ring 5: SqlCreate, SqlUpdate, SqlDelete (database operations)
 * - Ring 6: DdlCreateModel, DdlCreateField (schema management)
 * - Ring 8: Cache (cache invalidation)
 *
 * TODO:
 * - Ring 0: UpdateMerger (data preparation)
 * - Ring 4: TransformProcessor (enrichment)
 * - Ring 7: Tracked (audit)
 *
 * @returns Configured ObserverRunner
 */
export function createObserverRunner(): ObserverRunner {
    const runner = new ObserverRunner();

    // =========================================================================
    // RING 0: DATA PREPARATION
    // =========================================================================
    // Phase 4: runner.register(new UpdateMerger());

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
    // Phase 4: runner.register(new TransformProcessor());

    // =========================================================================
    // RING 5: DATABASE
    // =========================================================================
    runner.register(new SqlCreate());
    runner.register(new SqlUpdate());
    runner.register(new SqlDelete());

    // =========================================================================
    // RING 6: POST-DATABASE (DDL)
    // =========================================================================
    runner.register(new DdlCreateModel());
    runner.register(new DdlCreateField());

    // =========================================================================
    // RING 7: AUDIT
    // =========================================================================
    // Phase 4: runner.register(new Tracked());

    // =========================================================================
    // RING 8: INTEGRATION
    // =========================================================================
    runner.register(new Cache());

    // =========================================================================
    // RING 9: NOTIFICATION
    // =========================================================================
    // Application-specific observers registered separately

    return runner;
}
