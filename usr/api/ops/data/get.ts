/**
 * data:get - Get a single record by ID
 *
 * Request:
 *   { op: "data:get", data: { model: string, id: string } }
 *
 * Response:
 *   { op: "ok", data: { ... record ... } }
 *   { op: "error", data: { code: "NOT_FOUND", message: "..." } }
 */

import { respond } from '@usr/lib/api';
import type { OpContext } from '@usr/lib/api';

interface GetRequest {
    model: string;
    id: string;
}

export default async function* ({ conn, msg }: OpContext) {
    const { model, id } = (msg.data ?? {}) as GetRequest;

    // Validate required fields
    if (!model) {
        yield respond.error('MODEL_REQUIRED', 'Model name is required');
        return;
    }

    if (!id) {
        yield respond.error('ID_REQUIRED', 'Record ID is required');
        return;
    }

    // Check auth
    if (!conn.user) {
        yield respond.error('UNAUTHORIZED', 'Authentication required');
        return;
    }

    // TODO: Actual database query via system context
    // For now, return placeholder data
    const record = {
        id,
        model,
        name: `Record ${id}`,
        created_at: new Date().toISOString(),
    };

    yield respond.ok(record);
}
