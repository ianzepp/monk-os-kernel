/**
 * DataMount - CRUD operations as filesystem
 *
 * Structure:
 * - /api/data/                       → directory (list models)
 * - /api/data/users/                 → directory (list records)
 * - /api/data/users/:id/             → directory (list fields)
 * - /api/data/users/:id/:field       → file (field value)
 *
 * Operations:
 * - cat /api/data/users/123/email    → read field value
 * - echo "x" > /api/data/users/123/email → update field
 * - ls /api/data/users/123/          → list fields
 * - rm -r /api/data/users/123/       → delete record (rmdir)
 *
 * Note: Record creation is via shell `insert` command, not filesystem.
 */

import type { System } from '@src/lib/system.js';
import type { Mount, FSEntry, FSEntryType } from '../types.js';
import { FSError } from '../types.js';

type ParsedPath =
    | { type: 'root' }
    | { type: 'model'; modelName: string }
    | { type: 'record'; modelName: string; recordId: string }
    | { type: 'field'; modelName: string; recordId: string; fieldName: string };

/** Fields that cannot be modified via filesystem writes */
const READONLY_FIELDS = new Set([
    'id',
    'created_at',
    'updated_at',
    'trashed_at',
    'deleted_at',
    'access_read',
    'access_edit',
    'access_full',
    'access_deny',
]);

export class DataMount implements Mount {
    constructor(private readonly system: System) {}

    /**
     * Get entry type from path structure (no I/O)
     *
     * Path depth determines type:
     * - 0-2 segments: directory (root, model, record)
     * - 3 segments: file (field)
     */
    getType(path: string): FSEntryType | null {
        const segments = path.split('/').filter(Boolean);
        if (segments.length <= 2) return 'directory';
        if (segments.length === 3) return 'file';
        return null; // Invalid path depth
    }

    async stat(path: string): Promise<FSEntry> {
        const parsed = this.parsePath(path);

        if (parsed.type === 'root') {
            return {
                name: 'data',
                type: 'directory',
                size: 0,
                mode: 0o755,
            };
        }

        if (parsed.type === 'model') {
            const model = await this.system.describe.models.selectOne({
                where: { model_name: parsed.modelName },
            });
            if (!model) {
                throw new FSError('ENOENT', path);
            }
            return {
                name: parsed.modelName,
                type: 'directory',
                size: 0,
                mode: 0o755,
                mtime: model.updated_at ? new Date(model.updated_at) : undefined,
            };
        }

        if (parsed.type === 'record') {
            try {
                const record = await this.system.database.selectOne(parsed.modelName, {
                    where: { id: parsed.recordId },
                });
                if (!record) {
                    throw new FSError('ENOENT', path);
                }
                return {
                    name: parsed.recordId,
                    type: 'directory',
                    size: 0,
                    mode: 0o755,
                    mtime: record.updated_at ? new Date(record.updated_at) : undefined,
                    ctime: record.created_at ? new Date(record.created_at) : undefined,
                };
            } catch (err) {
                if (err instanceof FSError) throw err;
                throw new FSError('ENOENT', path);
            }
        }

        if (parsed.type === 'field') {
            try {
                const record = await this.system.database.selectOne(parsed.modelName, {
                    where: { id: parsed.recordId },
                });
                if (!record) {
                    throw new FSError('ENOENT', path);
                }
                if (!(parsed.fieldName in record)) {
                    throw new FSError('ENOENT', path);
                }
                const value = this.formatValue(record[parsed.fieldName]);
                const isReadonly = READONLY_FIELDS.has(parsed.fieldName);
                return {
                    name: parsed.fieldName,
                    type: 'file',
                    size: Buffer.byteLength(value, 'utf8'),
                    mode: isReadonly ? 0o444 : 0o644,
                    mtime: record.updated_at ? new Date(record.updated_at) : undefined,
                };
            } catch (err) {
                if (err instanceof FSError) throw err;
                throw new FSError('ENOENT', path);
            }
        }

        throw new FSError('ENOENT', path);
    }

    async readdir(path: string): Promise<FSEntry[]> {
        const parsed = this.parsePath(path);

        if (parsed.type === 'root') {
            const models = await this.system.describe.models.selectAny();
            return models.map(m => ({
                name: m.model_name,
                type: 'directory' as const,
                size: 0,
                mode: 0o755,
                mtime: m.updated_at ? new Date(m.updated_at) : undefined,
            }));
        }

        if (parsed.type === 'model') {
            const model = await this.system.describe.models.selectOne({
                where: { model_name: parsed.modelName },
            });
            if (!model) {
                throw new FSError('ENOENT', path);
            }

            const records = await this.system.database.selectAny(parsed.modelName, {
                limit: 10000,
            });

            // Records are now directories, not files
            return records.map(r => ({
                name: r.id,
                type: 'directory' as const,
                size: 0,
                mode: 0o755,
                mtime: r.updated_at ? new Date(r.updated_at) : undefined,
                ctime: r.created_at ? new Date(r.created_at) : undefined,
            }));
        }

        if (parsed.type === 'record') {
            try {
                const record = await this.system.database.selectOne(parsed.modelName, {
                    where: { id: parsed.recordId },
                });
                if (!record) {
                    throw new FSError('ENOENT', path);
                }

                // List all fields as files
                const entries: FSEntry[] = [];
                for (const [key, value] of Object.entries(record)) {
                    const formatted = this.formatValue(value);
                    const isReadonly = READONLY_FIELDS.has(key);
                    entries.push({
                        name: key,
                        type: 'file',
                        size: Buffer.byteLength(formatted, 'utf8'),
                        mode: isReadonly ? 0o444 : 0o644,
                        mtime: record.updated_at ? new Date(record.updated_at) : undefined,
                    });
                }
                return entries;
            } catch (err) {
                if (err instanceof FSError) throw err;
                throw new FSError('ENOENT', path);
            }
        }

        throw new FSError('ENOTDIR', path);
    }

    async read(path: string): Promise<string> {
        const parsed = this.parsePath(path);

        if (parsed.type === 'root' || parsed.type === 'model' || parsed.type === 'record') {
            throw new FSError('EISDIR', path);
        }

        if (parsed.type === 'field') {
            try {
                const record = await this.system.database.selectOne(parsed.modelName, {
                    where: { id: parsed.recordId },
                });
                if (!record) {
                    throw new FSError('ENOENT', path);
                }
                if (!(parsed.fieldName in record)) {
                    throw new FSError('ENOENT', path);
                }
                return this.formatValue(record[parsed.fieldName]);
            } catch (err) {
                if (err instanceof FSError) throw err;
                throw new FSError('ENOENT', path);
            }
        }

        throw new FSError('ENOENT', path);
    }

    async write(path: string, content: string | Buffer): Promise<void> {
        const parsed = this.parsePath(path);

        if (parsed.type === 'root' || parsed.type === 'model' || parsed.type === 'record') {
            throw new FSError('EISDIR', path);
        }

        if (parsed.type === 'field') {
            // Check if field is readonly
            if (READONLY_FIELDS.has(parsed.fieldName)) {
                throw new FSError('EROFS', path, `Field '${parsed.fieldName}' is read-only`);
            }

            try {
                const record = await this.system.database.selectOne(parsed.modelName, {
                    where: { id: parsed.recordId },
                });
                if (!record) {
                    throw new FSError('ENOENT', path);
                }
                if (!(parsed.fieldName in record)) {
                    throw new FSError('ENOENT', path);
                }

                // Parse the value appropriately based on current type
                const rawValue = content.toString().trim();
                const parsedValue = this.parseValue(rawValue, record[parsed.fieldName]);

                await this.system.database.updateOne(parsed.modelName, parsed.recordId, {
                    [parsed.fieldName]: parsedValue,
                });
                return;
            } catch (err) {
                if (err instanceof FSError) throw err;
                throw new FSError('EIO', path, err instanceof Error ? err.message : String(err));
            }
        }

        throw new FSError('ENOENT', path);
    }

    async unlink(path: string): Promise<void> {
        const parsed = this.parsePath(path);

        // Records are directories now, use rmdir
        if (parsed.type === 'record') {
            throw new FSError('EISDIR', path, 'Use rmdir or rm -r to delete records');
        }

        // Can't delete individual fields
        if (parsed.type === 'field') {
            throw new FSError('EROFS', path, 'Cannot delete individual fields');
        }

        throw new FSError('EISDIR', path);
    }

    async rmdir(path: string): Promise<void> {
        const parsed = this.parsePath(path);

        if (parsed.type === 'root' || parsed.type === 'model') {
            throw new FSError('EACCES', path, 'Cannot delete models via filesystem');
        }

        if (parsed.type === 'record') {
            try {
                const existing = await this.system.database.selectOne(parsed.modelName, {
                    where: { id: parsed.recordId },
                });
                if (!existing) {
                    throw new FSError('ENOENT', path);
                }
                await this.system.database.deleteOne(parsed.modelName, parsed.recordId);
                return;
            } catch (err) {
                if (err instanceof FSError) throw err;
                throw new FSError('EIO', path, err instanceof Error ? err.message : String(err));
            }
        }

        throw new FSError('ENOTDIR', path);
    }

    /**
     * Format a field value for display
     */
    private formatValue(value: unknown): string {
        if (value === null || value === undefined) {
            return '';
        }
        if (typeof value === 'object') {
            return JSON.stringify(value);
        }
        return String(value);
    }

    /**
     * Parse a string value back to its appropriate type
     */
    private parseValue(rawValue: string, currentValue: unknown): unknown {
        // Empty string → null
        if (rawValue === '') {
            return null;
        }

        // Boolean
        if (typeof currentValue === 'boolean') {
            return rawValue === 'true' || rawValue === '1';
        }

        // Number
        if (typeof currentValue === 'number') {
            const num = Number(rawValue);
            if (isNaN(num)) {
                throw new Error(`Invalid number: ${rawValue}`);
            }
            return num;
        }

        // Object/Array (JSON)
        if (typeof currentValue === 'object' && currentValue !== null) {
            return JSON.parse(rawValue);
        }

        // String (default)
        return rawValue;
    }

    private parsePath(path: string): ParsedPath {
        const segments = path.split('/').filter(Boolean);

        if (segments.length === 0) {
            return { type: 'root' };
        }

        if (segments.length === 1) {
            return { type: 'model', modelName: segments[0] };
        }

        if (segments.length === 2) {
            return { type: 'record', modelName: segments[0], recordId: segments[1] };
        }

        if (segments.length === 3) {
            return {
                type: 'field',
                modelName: segments[0],
                recordId: segments[1],
                fieldName: segments[2],
            };
        }

        throw new FSError('ENOENT', path);
    }
}
