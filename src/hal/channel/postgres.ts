/**
 * PostgreSQL Channel
 *
 * PostgreSQL database channel using Bun.sql.
 */

import { randomUUID } from 'crypto';
import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { Channel, ChannelOpts, QueryData } from './types.js';

/**
 * PostgreSQL channel using Bun.sql.
 */
export class BunPostgresChannel implements Channel {
    readonly id = randomUUID();
    readonly proto = 'postgres';
    readonly description: string;

    private sql: InstanceType<typeof Bun.SQL>;
    private _closed = false;

    constructor(url: string, _opts?: ChannelOpts) {
        this.description = url;
        this.sql = new Bun.SQL(url);
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
                    const rows = await this.sql.unsafe(sql, params ?? []);

                    for (const row of rows) {
                        yield respond.item(row);
                    }
                    yield respond.done();
                    break;
                }

                case 'execute': {
                    const { sql, params } = msg.data as QueryData;
                    const result = await this.sql.unsafe(sql, params ?? []);

                    yield respond.ok({ affectedRows: result.count });
                    break;
                }

                default:
                    yield respond.error('EINVAL', `Unknown op: ${msg.op}`);
            }
        } catch (err) {
            const pgErr = err as Error & { code?: string };
            const code = pgErr.code ?? '';
            yield respond.error('EIO', `${code}: ${pgErr.message}`);
        }
    }

    async push(_response: Response): Promise<void> {
        throw new Error('PostgreSQL channels do not support push');
    }

    async recv(): Promise<Message> {
        throw new Error('PostgreSQL channels do not support recv');
    }

    async close(): Promise<void> {
        this._closed = true;
        this.sql.close();
    }
}
