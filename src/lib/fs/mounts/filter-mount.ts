/**
 * FilterMount - Saved filters as executable query files
 *
 * Matches HTTP API structure:
 * - /api/find/                        → List models with saved filters
 * - /api/find/orders/                 → List saved filters for model
 * - /api/find/orders/high-value       → GET /api/find/:model/:filter (execute query)
 *
 * Reading a filter file executes the saved query and returns results as JSON.
 * Read-only mount - filter management goes through /api/data/filters.
 *
 * See also: FindMount for ad-hoc queries with inline parameters.
 */

import type { System } from '@src/lib/system.js';
import type { Mount, FSEntry } from '../types.js';
import { FSError } from '../types.js';

type ParsedPath =
    | { type: 'root' }
    | { type: 'model'; modelName: string }
    | { type: 'filter'; modelName: string; filterName: string };

export class FilterMount implements Mount {
    constructor(private readonly system: System) {}

    async stat(path: string): Promise<FSEntry> {
        const parsed = this.parsePath(path);

        if (parsed.type === 'root') {
            return {
                name: 'find',
                type: 'directory',
                size: 0,
                mode: 0o755,
            };
        }

        if (parsed.type === 'model') {
            // Check if any filters exist for this model
            const filters = await this.system.database.selectAny('filters', {
                where: { model_name: parsed.modelName },
                limit: 1,
            }, { context: 'system' });

            if (filters.length === 0) {
                throw new FSError('ENOENT', path);
            }

            return {
                name: parsed.modelName,
                type: 'directory',
                size: 0,
                mode: 0o755,
            };
        }

        if (parsed.type === 'filter') {
            const filter = await this.system.database.selectOne('filters', {
                where: { model_name: parsed.modelName, name: parsed.filterName },
            }, { context: 'system' });

            if (!filter) {
                throw new FSError('ENOENT', path);
            }

            return {
                name: parsed.filterName,
                type: 'file',
                size: 0,
                mode: 0o444,
                mtime: filter.updated_at ? new Date(filter.updated_at) : undefined,
                ctime: filter.created_at ? new Date(filter.created_at) : undefined,
            };
        }

        throw new FSError('ENOENT', path);
    }

    async readdir(path: string): Promise<FSEntry[]> {
        const parsed = this.parsePath(path);

        if (parsed.type === 'root') {
            // Get distinct model names that have filters
            const filters = await this.system.database.selectAny('filters', {}, { context: 'system' });
            const modelNames = [...new Set(filters.map(f => f.model_name))];

            return modelNames.map(name => ({
                name,
                type: 'directory' as const,
                size: 0,
                mode: 0o755,
            }));
        }

        if (parsed.type === 'model') {
            const filters = await this.system.database.selectAny('filters', {
                where: { model_name: parsed.modelName },
            }, { context: 'system' });

            if (filters.length === 0) {
                throw new FSError('ENOENT', path);
            }

            return filters.map(f => ({
                name: f.name,
                type: 'file' as const,
                size: 0,
                mode: 0o444,
                mtime: f.updated_at ? new Date(f.updated_at) : undefined,
                ctime: f.created_at ? new Date(f.created_at) : undefined,
            }));
        }

        throw new FSError('ENOTDIR', path);
    }

    async read(path: string): Promise<string> {
        const parsed = this.parsePath(path);

        if (parsed.type === 'root' || parsed.type === 'model') {
            throw new FSError('EISDIR', path);
        }

        if (parsed.type === 'filter') {
            // Load the saved filter
            const filter = await this.system.database.selectOne('filters', {
                where: { model_name: parsed.modelName, name: parsed.filterName },
            }, { context: 'system' });

            if (!filter) {
                throw new FSError('ENOENT', path);
            }

            // Build query from saved filter
            const query: Record<string, any> = {};
            if (filter.select) query.select = filter.select;
            if (filter.where) query.where = filter.where;
            if (filter.order) query.order = filter.order;
            if (filter.limit != null) query.limit = filter.limit;
            if (filter.offset != null) query.offset = filter.offset;

            // Execute query against the model
            const results = await this.system.database.selectAny(
                parsed.modelName,
                query,
                { context: 'api' }
            );

            return JSON.stringify(results, null, 2);
        }

        throw new FSError('ENOENT', path);
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
            return { type: 'filter', modelName: segments[0], filterName: segments[1] };
        }

        throw new FSError('ENOENT', path);
    }
}
