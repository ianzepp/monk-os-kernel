/**
 * Model Name Validator - Ring 1 Input Validation
 *
 * Validates model names for SQL safety and PostgreSQL compatibility.
 * Prevents SQL injection, reserved words, and invalid identifier patterns.
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { ValidationError } from '@src/lib/observers/errors.js';
import type { ModelRecord } from '@src/lib/model-record.js';

// PostgreSQL reserved words that should not be used as model names
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

// System table prefixes that should not be used
const SYSTEM_PREFIXES = ['pg_', 'information_schema', 'sql_', 'sys_'];

export default class model_nameValidator extends BaseObserver {
    readonly ring = ObserverRing.InputValidation;  // Ring 1
    readonly operations = ['create', 'update'] as const;
    readonly models = ['models'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { record } = context;
        const { model_name } = record;

        // Validate required field (previously handled by Ajv, now done explicitly)
        if (!model_name || model_name.trim() === '') {
            throw new ValidationError(
                'model_name is required',
                'model_name'
            );
        }

        // Validate length
        if (model_name.length > 63) {
            throw new ValidationError(
                'Model name must be 63 characters or less (PostgreSQL identifier limit)',
                'model_name'
            );
        }

        // Validate format: lowercase letters, numbers, underscores only
        if (!/^[a-z][a-z0-9_]*$/.test(model_name)) {
            throw new ValidationError(
                'Model name must start with a letter and contain only lowercase letters, numbers, and underscores',
                'model_name'
            );
        }

        // Check for reserved words
        if (RESERVED_WORDS.has(model_name.toLowerCase())) {
            throw new ValidationError(
                `Model name '${model_name}' is a PostgreSQL reserved word`,
                'model_name'
            );
        }

        // Check for system prefixes
        for (const prefix of SYSTEM_PREFIXES) {
            if (model_name.toLowerCase().startsWith(prefix)) {
                throw new ValidationError(
                    `Model name cannot start with reserved prefix '${prefix}'`,
                    'model_name'
                );
            }
        }

        // Prevent double underscores (often used for system models)
        if (model_name.includes('__')) {
            throw new ValidationError(
                'Model name cannot contain double underscores (reserved for system use)',
                'model_name'
            );
        }
    }
}
