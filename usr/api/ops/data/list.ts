/**
 * data:list - List records from a model
 *
 * Request:
 *   { op: "data:list", data: { model: string, filter?: object, limit?: number } }
 *
 * Response:
 *   { op: "item", data: { ... record ... } }  // repeated
 *   { op: "done" }
 */

import { respond } from '@usr/lib/api';
import type { OpContext } from '@usr/lib/api';

interface ListRequest {
    model: string;
    filter?: Record<string, unknown>;
    limit?: number;
}

export default async function* ({ conn, msg }: OpContext) {
    const { model, filter, limit } = (msg.data ?? {}) as ListRequest;

    // Validate required fields
    if (!model) {
        yield respond.error('MODEL_REQUIRED', 'Model name is required');
        return;
    }

    // Check auth
    if (!conn.user) {
        yield respond.error('UNAUTHORIZED', 'Authentication required');
        return;
    }

    // TODO: Actual database query via system context
    // For now, return placeholder data
    const mockRecords = [
        { id: '1', name: 'Record 1', model },
        { id: '2', name: 'Record 2', model },
        { id: '3', name: 'Record 3', model },
    ];

    const records = limit ? mockRecords.slice(0, limit) : mockRecords;

    for (const record of records) {
        yield respond.item(record);
    }

    yield respond.done();
}
