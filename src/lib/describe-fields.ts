import type { System } from '@src/lib/system.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import type { FilterData } from '@src/lib/filter-types.js';
import type {
    FieldRecord,
    DbCreateInput,
    DbUpdateInput,
    SystemFields,
} from '@src/lib/database-types.js';

/**
 * DescribeFields - Wrapper for field operations on 'fields' table
 *
 * Provides Database-like interface for field metadata operations with
 * field-specific validation (name rules, reserved words).
 *
 * Note: Model sudo protection is handled by the 20-model-sudo-validator observer
 * which runs in Ring 1 for all create/update/delete operations.
 */
export class DescribeFields {
    constructor(private system: System) {}

    /**
     * Validate field name follows PostgreSQL naming rules
     */
    private validateFieldName(fieldName: string): void {
        if (!fieldName || typeof fieldName !== 'string') {
            throw HttpErrors.badRequest(`Field name must be a non-empty string`, 'INVALID_FIELD_NAME');
        }

        if (fieldName.length > 63) {
            throw HttpErrors.badRequest(`Field name '${fieldName}' exceeds 63 character limit`, 'FIELD_NAME_TOO_LONG');
        }

        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(fieldName)) {
            throw HttpErrors.badRequest(`Field name '${fieldName}' must start with letter or underscore and contain only letters, digits, and underscores`, 'INVALID_FIELD_NAME');
        }

        // Check against PostgreSQL reserved words
        const reservedWords = [
            'select', 'insert', 'update', 'delete', 'from', 'where', 'join', 'inner', 'outer',
            'left', 'right', 'on', 'group', 'order', 'by', 'having', 'union', 'table', 'index',
            'primary', 'key', 'foreign', 'constraint', 'create', 'drop', 'alter', 'database',
            'model', 'view', 'trigger', 'function', 'procedure', 'user', 'grant', 'revoke'
        ];

        if (reservedWords.includes(fieldName.toLowerCase())) {
            throw HttpErrors.badRequest(`Field name '${fieldName}' is a PostgreSQL reserved word`, 'RESERVED_FIELD_NAME');
        }
    }

    /**
     * Select multiple fields with optional filtering
     */
    async selectAny(filter?: FilterData, options?: { context?: 'api' | 'observer' | 'system' }): Promise<FieldRecord[]> {
        return this.system.database.selectAny<FieldRecord>('fields', filter, options);
    }

    /**
     * Select single field (returns null if not found)
     */
    async selectOne(filter: FilterData, options?: { context?: 'api' | 'observer' | 'system' }): Promise<FieldRecord | null> {
        return this.system.database.selectOne<FieldRecord>('fields', filter, options);
    }

    /**
     * Select single field (throws 404 if not found)
     */
    async select404(filter: FilterData, message?: string, options?: { context?: 'api' | 'observer' | 'system' }): Promise<FieldRecord> {
        return await this.system.database.select404<FieldRecord>('fields', filter, message, options)
            .catch(e => HttpErrors.remap(e, 'RECORD_NOT_FOUND', 'FIELD_NOT_FOUND'));
    }

    /**
     * Create new field
     *
     * Validates field name, then creates field record.
     * Observer pipeline will handle DDL (ALTER TABLE ADD COLUMN) and type mapping.
     */
    async createOne(data: DbCreateInput<Omit<FieldRecord, keyof SystemFields>>): Promise<FieldRecord> {
        // Validate field name
        if (data.field_name) {
            this.validateFieldName(data.field_name);
        }

        console.info('Creating field via observer pipeline', {
            modelName: data.model_name,
            fieldName: data.field_name
        });

        // Delegate to database (observer pipeline handles type mapping and DDL)
        return this.system.database.createOne<Omit<FieldRecord, keyof SystemFields>>('fields', {
            ...data,
            type: data.type || 'text'
        }) as Promise<FieldRecord>;
    }

    /**
     * Create multiple fields in bulk
     *
     * Validates field names for all fields, then creates field records.
     * Observer pipeline will handle DDL (ALTER TABLE ADD COLUMN) and type mapping for each.
     */
    async createAll(dataArray: DbCreateInput<Omit<FieldRecord, keyof SystemFields>>[]): Promise<FieldRecord[]> {
        // Validate field names before creating
        for (const data of dataArray) {
            if (data.field_name) {
                this.validateFieldName(data.field_name);
            }
        }

        console.info('Creating fields in bulk via observer pipeline', {
            fieldCount: dataArray.length
        });

        // Add default type for any fields missing it
        const dataWithDefaults = dataArray.map(data => ({
            ...data,
            type: data.type || 'text'
        }));

        // Delegate to database (observer pipeline handles type mapping and DDL)
        return this.system.database.createAll<Omit<FieldRecord, keyof SystemFields>>('fields', dataWithDefaults) as Promise<FieldRecord[]>;
    }

    /**
     * Update multiple fields in bulk
     *
     * Observer pipeline handles structural changes (ALTER TABLE) and type mapping.
     */
    async updateAll(updates: DbUpdateInput<FieldRecord>[]): Promise<FieldRecord[]> {
        console.info('Updating fields in bulk via observer pipeline', {
            fieldCount: updates.length
        });

        // Delegate to database (observer pipeline handles DDL and type mapping)
        return this.system.database.updateAll<FieldRecord>('fields', updates);
    }

    /**
     * Update field by filter (throws 404 if not found)
     *
     * Observer pipeline handles structural changes (ALTER TABLE) and type mapping.
     */
    async update404(filter: FilterData, updates: Partial<FieldRecord>, message?: string): Promise<FieldRecord> {
        console.info('Updating field via observer pipeline', {
            modelName: filter.where?.model_name,
            fieldName: filter.where?.field_name
        });

        return await this.system.database.update404<FieldRecord>('fields', filter, updates, message)
            .catch(e => HttpErrors.remap(e, 'RECORD_NOT_FOUND', 'FIELD_NOT_FOUND'));
    }

    /**
     * Delete field by filter (throws 404 if not found)
     *
     * Observer pipeline will handle DDL (ALTER TABLE DROP COLUMN).
     */
    async delete404(filter: FilterData, message?: string): Promise<FieldRecord> {
        console.info('Deleting field via observer pipeline', {
            modelName: filter.where?.model_name,
            fieldName: filter.where?.field_name
        });

        return await this.system.database.delete404<FieldRecord>('fields', filter, message)
            .catch(e => HttpErrors.remap(e, 'RECORD_NOT_FOUND', 'FIELD_NOT_FOUND'));
    }
}
