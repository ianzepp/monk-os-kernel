/**
 * TrashedMount - Soft-deleted records as filesystem
 *
 * Like DataMount but only shows trashed records:
 * - /api/trashed/                    → List models with trashed records
 * - /api/trashed/orders/             → List trashed records (directories)
 * - /api/trashed/orders/:id/         → List fields in trashed record
 * - /api/trashed/orders/:id/:field   → View field value
 *
 * Read-only mount. Restore/permanent delete via API.
 */

import type { System } from '@src/lib/system.js';
import type { Mount, FSEntry, FSEntryType } from '../types.js';
import { FSError } from '../types.js';

type ParsedPath =
    | { type: 'root' }
    | { type: 'model'; modelName: string }
    | { type: 'record'; modelName: string; recordId: string }
    | { type: 'field'; modelName: string; recordId: string; fieldName: string };

export class TrashedMount implements Mount {
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
                name: 'trashed',
                type: 'directory',
                size: 0,
                mode: 0o755,
            };
        }

        if (parsed.type === 'model') {
            // Check model exists
            const model = await this.system.describe.models.selectOne({
                where: { model_name: parsed.modelName },
            });
            if (!model) {
                throw new FSError('ENOENT', path);
            }

            // Check if any trashed records exist
            const trashed = await this.system.database.selectAny(parsed.modelName, {
                limit: 1,
            }, { context: 'api', trashed: 'only' });

            if (trashed.length === 0) {
                throw new FSError('ENOENT', path);
            }

            return {
                name: parsed.modelName,
                type: 'directory',
                size: 0,
                mode: 0o755,
            };
        }

        if (parsed.type === 'record') {
            const record = await this.system.database.selectOne(parsed.modelName, {
                where: { id: parsed.recordId },
            }, { context: 'api', trashed: 'only' });

            if (!record) {
                throw new FSError('ENOENT', path);
            }

            return {
                name: parsed.recordId,
                type: 'directory',
                size: 0,
                mode: 0o555, // read-only directory
                mtime: record.trashed_at ? new Date(record.trashed_at) : undefined,
                ctime: record.created_at ? new Date(record.created_at) : undefined,
            };
        }

        if (parsed.type === 'field') {
            const record = await this.system.database.selectOne(parsed.modelName, {
                where: { id: parsed.recordId },
            }, { context: 'api', trashed: 'only' });

            if (!record) {
                throw new FSError('ENOENT', path);
            }
            if (!(parsed.fieldName in record)) {
                throw new FSError('ENOENT', path);
            }

            const value = this.formatValue(record[parsed.fieldName]);
            return {
                name: parsed.fieldName,
                type: 'file',
                size: Buffer.byteLength(value, 'utf8'),
                mode: 0o444, // read-only
                mtime: record.trashed_at ? new Date(record.trashed_at) : undefined,
            };
        }

        throw new FSError('ENOENT', path);
    }

    async readdir(path: string): Promise<FSEntry[]> {
        const parsed = this.parsePath(path);

        if (parsed.type === 'root') {
            // Get all models and check which have trashed records
            const models = await this.system.describe.models.selectAny();
            const entries: FSEntry[] = [];

            for (const model of models) {
                const trashed = await this.system.database.selectAny(model.model_name, {
                    limit: 1,
                }, { context: 'api', trashed: 'only' });

                if (trashed.length > 0) {
                    entries.push({
                        name: model.model_name,
                        type: 'directory',
                        size: 0,
                        mode: 0o755,
                    });
                }
            }

            return entries;
        }

        if (parsed.type === 'model') {
            const records = await this.system.database.selectAny(parsed.modelName, {
                limit: 10000,
            }, { context: 'api', trashed: 'only' });

            if (records.length === 0) {
                throw new FSError('ENOENT', path);
            }

            // Records are directories
            return records.map(r => ({
                name: r.id,
                type: 'directory' as const,
                size: 0,
                mode: 0o555, // read-only directory
                mtime: r.trashed_at ? new Date(r.trashed_at) : undefined,
                ctime: r.created_at ? new Date(r.created_at) : undefined,
            }));
        }

        if (parsed.type === 'record') {
            const record = await this.system.database.selectOne(parsed.modelName, {
                where: { id: parsed.recordId },
            }, { context: 'api', trashed: 'only' });

            if (!record) {
                throw new FSError('ENOENT', path);
            }

            // List all fields as files
            const entries: FSEntry[] = [];
            for (const [key, value] of Object.entries(record)) {
                const formatted = this.formatValue(value);
                entries.push({
                    name: key,
                    type: 'file',
                    size: Buffer.byteLength(formatted, 'utf8'),
                    mode: 0o444, // read-only
                    mtime: record.trashed_at ? new Date(record.trashed_at) : undefined,
                });
            }
            return entries;
        }

        throw new FSError('ENOTDIR', path);
    }

    async read(path: string): Promise<string> {
        const parsed = this.parsePath(path);

        if (parsed.type === 'root' || parsed.type === 'model' || parsed.type === 'record') {
            throw new FSError('EISDIR', path);
        }

        if (parsed.type === 'field') {
            const record = await this.system.database.selectOne(parsed.modelName, {
                where: { id: parsed.recordId },
            }, { context: 'api', trashed: 'only' });

            if (!record) {
                throw new FSError('ENOENT', path);
            }
            if (!(parsed.fieldName in record)) {
                throw new FSError('ENOENT', path);
            }

            return this.formatValue(record[parsed.fieldName]);
        }

        throw new FSError('ENOENT', path);
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
