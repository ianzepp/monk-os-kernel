/**
 * FindMount - Ad-hoc query as a virtual directory
 *
 * Creates a dynamic view of records matching query criteria.
 * Useful for creating shortcuts to filtered data:
 *
 *   mount -t find accounts '{"where":{"balance":{"$gt":1000000}}}' /home/root/rich
 *   ls /home/root/rich  → lists matching account IDs
 *   cat /home/root/rich/abc123  → reads that account record
 *
 * Query options:
 * - where: Filter criteria
 * - order: Sort order
 * - limit: Max records (default 1000)
 * - select: Fields to include
 *
 * Read-only mount - writes go through /api/data.
 *
 * See also: FilterMount for saved filters from the filters table.
 */

import type { System } from '@src/lib/system.js';
import type { Mount, FSEntry } from '../types.js';
import { FSError } from '../types.js';

export interface FindMountQuery {
    where?: Record<string, any>;
    order?: Array<{ field: string; sort?: 'asc' | 'desc' }>;
    limit?: number;
    select?: string[];
}

export class FindMount implements Mount {
    private readonly limit: number;

    constructor(
        private readonly system: System,
        private readonly modelName: string,
        private readonly query: FindMountQuery = {}
    ) {
        // Default limit to prevent unbounded queries
        this.limit = query.limit ?? 1000;
    }

    async stat(path: string): Promise<FSEntry> {
        const recordId = this.parseRecordId(path);

        if (!recordId) {
            // Root of mount - the query directory
            return {
                name: this.modelName,
                type: 'directory',
                size: 0,
                mode: 0o555, // read-only
            };
        }

        // Specific record
        const record = await this.fetchRecord(recordId);
        if (!record) {
            throw new FSError('ENOENT', path);
        }

        const content = JSON.stringify(record, null, 2);
        return {
            name: recordId,
            type: 'file',
            size: Buffer.byteLength(content, 'utf8'),
            mode: 0o444, // read-only
            mtime: record.updated_at ? new Date(record.updated_at) : undefined,
            ctime: record.created_at ? new Date(record.created_at) : undefined,
        };
    }

    async readdir(path: string): Promise<FSEntry[]> {
        const recordId = this.parseRecordId(path);

        if (recordId) {
            throw new FSError('ENOTDIR', path);
        }

        // Execute query to get matching records
        const records = await this.system.database.selectAny(this.modelName, {
            where: this.query.where,
            order: this.query.order,
            limit: this.limit,
            select: ['id', 'updated_at', 'created_at'],
        });

        return records.map(r => ({
            name: r.id,
            type: 'file' as const,
            size: 0,
            mode: 0o444,
            mtime: r.updated_at ? new Date(r.updated_at) : undefined,
            ctime: r.created_at ? new Date(r.created_at) : undefined,
        }));
    }

    async read(path: string): Promise<string> {
        const recordId = this.parseRecordId(path);

        if (!recordId) {
            throw new FSError('EISDIR', path);
        }

        const record = await this.fetchRecord(recordId);
        if (!record) {
            throw new FSError('ENOENT', path);
        }

        return JSON.stringify(record, null, 2);
    }

    /**
     * Fetch a single record, verifying it matches the query criteria
     */
    private async fetchRecord(recordId: string): Promise<Record<string, any> | null> {
        // Build where clause that includes both the ID and the query filter
        const where = this.query.where
            ? { $and: [{ id: recordId }, this.query.where] }
            : { id: recordId };

        const record = await this.system.database.selectOne(this.modelName, {
            where,
            select: this.query.select,
        });

        return record;
    }

    /**
     * Parse path to extract record ID (if any)
     */
    private parseRecordId(path: string): string | null {
        const segments = path.split('/').filter(Boolean);

        if (segments.length === 0) {
            return null;
        }

        if (segments.length === 1) {
            return segments[0];
        }

        throw new FSError('ENOENT', path);
    }
}
