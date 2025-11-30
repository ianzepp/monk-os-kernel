import { withTransaction } from '@src/lib/api-helpers.js';
import { BulkProcessor } from '@src/lib/bulk-processor.js';

/**
 * POST /api/bulk - Execute multiple operations atomically
 * @see src/routes/api/bulk/PUBLIC.md
 */
export default withTransaction(async ({ system, body }) => {
    const processor = new BulkProcessor(system);
    return await processor.process(body);
});
