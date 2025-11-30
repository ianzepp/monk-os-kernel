/**
 * Observer Registry
 *
 * Explicit registration of all observers. This is the source of truth for
 * which observers are loaded at startup. Each observer defines its own
 * ring, priority, operations, adapters, and models properties.
 *
 * To add a new observer:
 * 1. Create the observer file extending BaseObserver
 * 2. Add an import and instantiation here
 */

import type { Observer } from '@src/lib/observers/interfaces.js';

// =============================================================================
// Ring 0: Data Preparation
// =============================================================================
import ExternalModelGuard from '@src/observers/all/0/05-external-model-guard.js';
import UpdateMerger from '@src/observers/all/0/50-update-merger.js';

// =============================================================================
// Ring 1: Input Validation
// =============================================================================
import FrozenValidator from '@src/observers/all/1/10-frozen-validator.js';
import ModelSudoValidator from '@src/observers/all/1/20-model-sudo-validator.js';
import FieldSudoValidator from '@src/observers/all/1/25-field-sudo-validator.js';
import ImmutableValidator from '@src/observers/all/1/30-immutable-validator.js';
import DataValidator from '@src/observers/all/1/40-data-validator.js';

import FieldSystemModelValidator from '@src/observers/fields/1/10-field-system-model.js';
import DefaultValueTypeChecker from '@src/observers/fields/1/50-default-value-type-checker.js';
import FieldNameValidator from '@src/observers/fields/1/50-field-name-validator.js';

import ModelSystemModelValidator from '@src/observers/models/1/10-model-system-model.js';
import ModelNameValidator from '@src/observers/models/1/50-model-name-validator.js';

import EmailValidation from '@src/observers/users/1/50-email-validation.js';

// =============================================================================
// Ring 2: Security
// =============================================================================
import ExistenceValidator from '@src/observers/all/2/50-existence-validator.js';
import SoftDeleteProtector from '@src/observers/all/2/50-soft-delete-protector.js';

// =============================================================================
// Ring 3: Business Logic
// =============================================================================
import DuplicateFieldChecker from '@src/observers/fields/3/50-duplicate-field-checker.js';
import RelationshipModelChecker from '@src/observers/fields/3/50-relationship-model-checker.js';

import DuplicateModelChecker from '@src/observers/models/3/50-duplicate-model-checker.js';
import SystemTableProtector from '@src/observers/models/3/50-system-table-protector.js';

// =============================================================================
// Ring 4: Enrichment
// =============================================================================
import TransformProcessor from '@src/observers/all/4/50-transform-processor.js';

import TypeMapper from '@src/observers/fields/4/90-type-mapper.js';

// =============================================================================
// Ring 5: Database (SQL Execution)
// =============================================================================
import SqlAccess from '@src/observers/all/5/50-sql-access.js';
import SqlAccessSqlite from '@src/observers/all/5/50-sql-access-sqlite.js';
import SqlCreate from '@src/observers/all/5/50-sql-create.js';
import SqlCreateSqlite from '@src/observers/all/5/50-sql-create-sqlite.js';
import SqlUpdate from '@src/observers/all/5/50-sql-update.js';
import SqlUpdateSqlite from '@src/observers/all/5/50-sql-update-sqlite.js';
import SqlDelete from '@src/observers/all/5/50-sql-delete.js';
import SqlDeleteSqlite from '@src/observers/all/5/50-sql-delete-sqlite.js';
import SqlRevert from '@src/observers/all/5/50-sql-revert.js';
import SqlRevertSqlite from '@src/observers/all/5/50-sql-revert-sqlite.js';

// =============================================================================
// Ring 6: Post-Database (DDL Operations)
// =============================================================================
import FieldDdlCreate from '@src/observers/fields/6/10-field-ddl-create.js';
import FieldDdlCreateSqlite from '@src/observers/fields/6/10-field-ddl-create-sqlite.js';
import FieldDdlUpdate from '@src/observers/fields/6/10-field-ddl-update.js';
import FieldDdlUpdateSqlite from '@src/observers/fields/6/10-field-ddl-update-sqlite.js';
import FieldDdlDelete from '@src/observers/fields/6/10-field-ddl-delete.js';
import FieldDdlDeleteSqlite from '@src/observers/fields/6/10-field-ddl-delete-sqlite.js';
import DdlIndexes from '@src/observers/fields/6/20-ddl-indexes.js';
import TypeUnmapper from '@src/observers/fields/6/80-type-unmapper.js';

import ModelDdlCreate from '@src/observers/models/6/10-model-ddl-create.js';
import ModelDdlCreateSqlite from '@src/observers/models/6/10-model-ddl-create-sqlite.js';
import ModelDdlUpdate from '@src/observers/models/6/10-model-ddl-update.js';
import ModelDdlUpdateSqlite from '@src/observers/models/6/10-model-ddl-update-sqlite.js';
import ModelDdlDelete from '@src/observers/models/6/10-model-ddl-delete.js';
import ModelDdlDeleteSqlite from '@src/observers/models/6/10-model-ddl-delete-sqlite.js';

// =============================================================================
// Ring 7: Audit
// =============================================================================
import TrackedObserver from '@src/observers/all/7/60-tracked.js';

// =============================================================================
// Ring 8: Integration
// =============================================================================
import FieldCacheInvalidator from '@src/observers/fields/8/50-field-cache-invalidator.js';
import ModelCacheInvalidator from '@src/observers/models/8/50-model-cache-invalidator.js';

// =============================================================================
// Observer Registry
// =============================================================================

/**
 * All registered observers. Each observer instance defines its own:
 * - ring: which ring it executes in (0-9)
 * - priority: execution order within ring (lower first, default 50)
 * - operations: which operations it runs on (default: all)
 * - adapters: which database adapters it runs on (default: all)
 * - models: which models it runs on (default: all)
 */
export const observers: Observer[] = [
    // Ring 0: Data Preparation
    new ExternalModelGuard(),
    new UpdateMerger(),

    // Ring 1: Input Validation
    new FrozenValidator(),
    new ModelSudoValidator(),
    new FieldSudoValidator(),
    new ImmutableValidator(),
    new DataValidator(),
    new FieldSystemModelValidator(),
    new DefaultValueTypeChecker(),
    new FieldNameValidator(),
    new ModelSystemModelValidator(),
    new ModelNameValidator(),
    new EmailValidation(),

    // Ring 2: Security
    new ExistenceValidator(),
    new SoftDeleteProtector(),

    // Ring 3: Business Logic
    new DuplicateFieldChecker(),
    new RelationshipModelChecker(),
    new DuplicateModelChecker(),
    new SystemTableProtector(),

    // Ring 4: Enrichment
    new TransformProcessor(),
    new TypeMapper(),

    // Ring 5: Database
    new SqlAccess(),
    new SqlAccessSqlite(),
    new SqlCreate(),
    new SqlCreateSqlite(),
    new SqlUpdate(),
    new SqlUpdateSqlite(),
    new SqlDelete(),
    new SqlDeleteSqlite(),
    new SqlRevert(),
    new SqlRevertSqlite(),

    // Ring 6: Post-Database
    new FieldDdlCreate(),
    new FieldDdlCreateSqlite(),
    new FieldDdlUpdate(),
    new FieldDdlUpdateSqlite(),
    new FieldDdlDelete(),
    new FieldDdlDeleteSqlite(),
    new DdlIndexes(),
    new TypeUnmapper(),
    new ModelDdlCreate(),
    new ModelDdlCreateSqlite(),
    new ModelDdlUpdate(),
    new ModelDdlUpdateSqlite(),
    new ModelDdlDelete(),
    new ModelDdlDeleteSqlite(),

    // Ring 7: Audit
    new TrackedObserver(),

    // Ring 8: Integration
    new FieldCacheInvalidator(),
    new ModelCacheInvalidator(),
];
