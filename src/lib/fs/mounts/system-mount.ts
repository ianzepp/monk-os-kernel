/**
 * SystemMount - Read-only system introspection
 *
 * Provides pseudo-files for system information:
 * - /system/version - API version
 * - /system/uptime - Server uptime
 * - /system/whoami - Current user info (JSON)
 * - /system/tenant - Current tenant name
 * - /system/database - Database name
 * - /system/namespace - Namespace/schema name
 * - /system/access - User access level
 */

import type { System } from '@src/lib/system.js';
import type { Mount, FSEntry } from '../types.js';
import { FSError } from '../types.js';

export class SystemMount implements Mount {
    private readonly startTime = new Date();
    private readonly files: Map<string, () => Promise<string>>;

    constructor(private readonly system: System) {
        this.files = new Map([
            ['version', async () => process.env.npm_package_version || '5.1.0'],
            ['uptime', async () => this.formatUptime()],
            ['whoami', async () => {
                const user = this.system.getUser();
                return JSON.stringify(user, null, 2);
            }],
            ['tenant', async () => this.system.tenant],
            ['database', async () => this.system.dbName],
            ['namespace', async () => this.system.nsName],
            ['access', async () => this.system.access],
        ]);
    }

    async stat(path: string): Promise<FSEntry> {
        if (path === '/') {
            return {
                name: 'system',
                type: 'directory',
                size: 0,
                mode: 0o555,
            };
        }

        const name = this.extractName(path);
        if (!this.files.has(name)) {
            throw new FSError('ENOENT', path);
        }

        const content = await this.files.get(name)!();
        return {
            name,
            type: 'file',
            size: Buffer.byteLength(content, 'utf8'),
            mode: 0o444,
        };
    }

    async readdir(path: string): Promise<FSEntry[]> {
        if (path !== '/') {
            throw new FSError('ENOTDIR', path);
        }

        return [...this.files.keys()].map(name => ({
            name,
            type: 'file' as const,
            size: 0,
            mode: 0o444,
        }));
    }

    async read(path: string): Promise<string> {
        const name = this.extractName(path);
        const getter = this.files.get(name);
        if (!getter) {
            throw new FSError('ENOENT', path);
        }
        return getter();
    }

    private extractName(path: string): string {
        return path.split('/').filter(Boolean)[0] || '';
    }

    private formatUptime(): string {
        const ms = Date.now() - this.startTime.getTime();
        const seconds = Math.floor(ms / 1000);
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const mins = Math.floor((seconds % 3600) / 60);

        const parts: string[] = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        parts.push(`${mins}m`);

        return parts.join(' ');
    }
}
