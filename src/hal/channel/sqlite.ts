/**
 * SQLite Channel
 *
 * SQLite database channel using bun:sqlite.
 */

import { randomUUID } from 'crypto';
import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Channel, ChannelOpts, QueryData } from './types.js';

/**
 * SQLite channel using bun:sqlite.
 */
export class BunSqliteChannel implements Channel {
    readonly id = randomUUID();
    readonly proto = 'sqlite';
    readonly description: string;

    private db: import('bun:sqlite').Database;
    private _closed = false;

    constructor(path: string, opts?: ChannelOpts) {
        this.description = path;

        // Import synchronously (bun:sqlite is a built-in)
        const { Database } = require('bun:sqlite');
        this.db = new Database(path, {
            readonly: opts?.readonly ?? false,
            create: opts?.create ?? true,
        });

        // Enable WAL for better concurrency
        this.db.exec('PRAGMA journal_mode = WAL');
    }

    get closed(): boolean {
        return this._closed;
    }

    async *handle(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Channel closed');
            return;
        }

        try {
            switch (msg.op) {
                case 'query': {
                    const { sql, params } = msg.data as QueryData;
                    const stmt = this.db.prepare(sql);
                    const bindings = (params ?? []) as import('bun:sqlite').SQLQueryBindings[];
                    const rows = stmt.all(...bindings);

                    for (const row of rows) {
                        yield respond.item(row);
                    }
                    yield respond.done();
                    break;
                }

                case 'execute': {
                    const { sql, params } = msg.data as QueryData;
                    const stmt = this.db.prepare(sql);
                    const bindings = (params ?? []) as import('bun:sqlite').SQLQueryBindings[];
                    const result = stmt.run(...bindings);

                    yield respond.ok({ affectedRows: result.changes });
                    break;
                }

                default:
                    yield respond.error('EINVAL', `Unknown op: ${msg.op}`);
            }
        } catch (err) {
            const sqliteErr = err as Error;
            yield respond.error('EIO', sqliteErr.message);
        }
    }

    async push(_response: Response): Promise<void> {
        throw new Error('SQLite channels do not support push');
    }

    async recv(): Promise<Message> {
        throw new Error('SQLite channels do not support recv');
    }

    async close(): Promise<void> {
        this._closed = true;
        this.db.close();
    }
}
