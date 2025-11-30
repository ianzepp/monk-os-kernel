/**
 * Field Name Validator - Ring 1 Input Validation
 *
 * Validates field names for SQL safety and PostgreSQL compatibility.
 * Prevents SQL injection, reserved words, system field conflicts, and invalid identifiers.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { ValidationError } from '@src/lib/observers/errors.js';
import { SYSTEM_FIELDS } from '@src/lib/model.js';
import type { ModelRecord } from '@src/lib/model-record.js';

// PostgreSQL reserved words
const RESERVED_WORDS = new Set([
    'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric',
    'authorization', 'between', 'binary', 'both', 'case', 'cast', 'check', 'collate',
    'collation', 'field', 'constraint', 'create', 'cross', 'current_catalog',
    'current_date', 'current_role', 'current_model', 'current_time', 'current_timestamp',
    'current_user', 'system', 'deferrable', 'desc', 'distinct', 'do', 'else', 'end',
    'except', 'false', 'fetch', 'for', 'foreign', 'freeze', 'from', 'full', 'grant',
    'group', 'having', 'ilike', 'in', 'initially', 'inner', 'intersect', 'into', 'is',
    'isnull', 'join', 'lateral', 'leading', 'left', 'like', 'limit', 'localtime',
    'localtimestamp', 'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only',
    'or', 'order', 'outer', 'overlaps', 'placing', 'primary', 'references', 'returning',
    'right', 'select', 'session_user', 'similar', 'some', 'symmetric', 'table', 'then',
    'to', 'trailing', 'true', 'union', 'unique', 'user', 'using', 'variadic', 'verbose',
    'when', 'where', 'window', 'with'
]);

export default class field_nameValidator extends BaseObserver {
    readonly ring = ObserverRing.InputValidation;  // Ring 1
    readonly operations = ['create', 'update'] as const;
    readonly models = ['fields'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { record } = context;
        const { field_name } = record;

        if (!field_name) {
            return; // Required field validation handled by Ajv
        }

        // Validate length
        if (field_name.length > 63) {
            throw new ValidationError(
                'Field name must be 63 characters or less (PostgreSQL identifier limit)',
                'field_name'
            );
        }

        // Validate format: lowercase letters, numbers, underscores only
        if (!/^[a-z][a-z0-9_]*$/.test(field_name)) {
            throw new ValidationError(
                'Field name must start with a letter and contain only lowercase letters, numbers, and underscores',
                'field_name'
            );
        }

        // Check for system field conflicts
        if (SYSTEM_FIELDS.has(field_name.toLowerCase())) {
            throw new ValidationError(
                `Field name '${field_name}' conflicts with system field`,
                'field_name'
            );
        }

        // Check for reserved words
        if (RESERVED_WORDS.has(field_name.toLowerCase())) {
            throw new ValidationError(
                `Field name '${field_name}' is a PostgreSQL reserved word`,
                'field_name'
            );
        }

        // Prevent double underscores (often used for system fields)
        if (field_name.includes('__')) {
            throw new ValidationError(
                'Field name cannot contain double underscores (reserved for system use)',
                'field_name'
            );
        }
    }
}
